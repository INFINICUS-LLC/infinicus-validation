/**
 * BI-2-DEV-07: BI-10 calculation run and result persistence (migration 0223) over BI-owned sealed warehouse rows, against live PostgreSQL under the APPLICATION role.
 * Real chain: BO package -> BI intake -> dataset -> rows recorded and sealed through BiWarehouseRowRepository -> BI-09 registry -> BI-09 hand-off -> BI-10 calculation
 * -> persistence. THE WAREHOUSE ROWS ARE DEVELOPMENT FIXTURES (no BI ingestion pathway delivers rows yet). Proves: atomic and idempotent persistence, safe concurrent
 * replay, a persisted time that is the database's and distinct from the source timestamp, provenance bound to sealed evidence, round-trip fidelity with the in-memory
 * run and the PR #409 intelligence hand-off, tenant / workspace / business isolation and RLS, append-only evidence, database-level integrity, and no partial writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, getPool, withTenantTransaction, BiCalculationRunRepository, BiWarehouseRowRepository, type CalculationRunRecord, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceIntakeService } from '../src/BusinessIntelligenceIntakeService.js';
import { BusinessIntelligenceDatasetService } from '../src/BusinessIntelligenceDatasetService.js';
import { BusinessIntelligenceMetricRegistryService } from '../src/BusinessIntelligenceMetricRegistryService.js';
import { BusinessIntelligenceMetricCalculationService } from '../src/BusinessIntelligenceMetricCalculationService.js';
import { BusinessIntelligenceCalculationPersistenceService, runDigest } from '../src/BusinessIntelligenceCalculationPersistenceService.js';
import { PostgresWarehouseRowSource } from '../src/PostgresWarehouseRowSource.js';
import { buildIntelligenceHandoff, MAX_DATASET_ROWS, type MetricDefinitionInput, type WarehouseRow } from '../src/index.js';
import { biCtx, createBiWorld, publishBoPackage, type BiWorld } from './helpers/boPublicationFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const SALES: WarehouseRow[] = [
  { amount: '1200.50', cost: '400.20', date: '2026-01-15T09:00:00Z' },
  { amount: '800.25', cost: '350.10', date: '2026-01-20T09:00:00Z' },
  { amount: '300.10', cost: '100.05', date: '2026-02-02T09:00:00Z' },
];

describe.runIf(run)('BI-2-DEV-07 calculation persistence (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const intake = new BusinessIntelligenceIntakeService();
  const datasets = new BusinessIntelligenceDatasetService();
  const registry = new BusinessIntelligenceMetricRegistryService();
  const warehouse = new BiWarehouseRowRepository();
  const runs = new BiCalculationRunRepository();
  const svc = new BusinessIntelligenceMetricCalculationService();
  const persistence = new BusinessIntelligenceCalculationPersistenceService();
  let seq = 0;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const asApp = async <T>(ctx: TenantContext, fn: (query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>) =>
    withTenantTransaction(ctx, (client) => fn((sql, args) => client.query(sql, args)));
  const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { name?: string; code?: string; message: string }; } };

  /** A dataset from the real chain whose rows are recorded and SEALED (development fixture rows). */
  async function sealedDataset(w: BiWorld, rows: WarehouseRow[], targetBlock = 'BI-16') {
    const p = await publishBoPackage(admin, w, { recordCount: rows.length, targetBlock });
    const out = await intake.ingest(biCtx(w), p.handoff);
    if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    const d = await datasets.materialize(biCtx(w), out.intakePackageId);
    const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    await warehouse.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.datasetVersionId, sourceReferenceId: source.id, rows: rows.map((data, i) => ({ rowNumber: i + 1, data })) });
    const seal = await warehouse.sealVersion(biCtx(w), w.businessId, d.datasetVersionId);
    return { datasetId: d.datasetId, versionId: d.datasetVersionId, sourceId: source.id as string, seal };
  }
  const metric = (ds: string, over: MetricDefinitionInput): MetricDefinitionInput =>
    ({ name: 'Metric', code: `m_${++seq}`, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
  const reg = async (w: BiWorld, i: MetricDefinitionInput): Promise<string> => {
    const r = await registry.register(biCtx(w), w.businessId, i); expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  };
  /** revenue, cost (base, monthly), margin = revenue - cost, margin_rate = margin / revenue - on a sealed dataset. */
  async function financialWorld(label: string, rows: WarehouseRow[] = SALES) {
    const w = await createBiWorld(admin, label); const ds = await sealedDataset(w, rows);
    const revenue = await reg(w, metric(ds.datasetId, { code: 'revenue' }));
    const cost = await reg(w, metric(ds.datasetId, { code: 'cost', sourceField: 'cost' }));
    const margin = await reg(w, metric(ds.datasetId, { code: 'margin', metricType: 'derived', aggregation: undefined, sourceField: undefined, dependencies: [revenue, cost], formula: { operator: 'subtract' } }));
    const rate = await reg(w, metric(ds.datasetId, { code: 'margin_rate', metricType: 'ratio', aggregation: undefined, sourceField: undefined, dependencies: [margin, revenue], unit: 'ratio' }));
    return { w, ds, revenue, cost, margin, rate };
  }
  const go = (w: BiWorld, correlationId = 'corr-1', over: { metricIds?: string[]; businessId?: string; ctx?: TenantContext } = {}) =>
    svc.calculateAndPersist(over.ctx ?? biCtx(w), over.businessId ?? w.businessId, { correlationId, ...(over.metricIds ? { metricIds: over.metricIds } : {}) });
  const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };
  const tableCounts = async (w: BiWorld) => Object.fromEntries(await Promise.all(['metric_calculation_runs', 'metric_calculation_run_inputs', 'metric_results'].map(async (t) =>
    [t, Number((await q(`SELECT count(*) n FROM business_intelligence.${t} WHERE business_id = $1`, [w.businessId]))[0].n)])));

  it('calculates over the sealed warehouse rows and persists the run, its sealed input and every result, with exact decimal values', async () => {
    const f = await financialWorld('P1');
    const out = ok(await go(f.w));
    expect(out.replayed).toBe(false);
    expect(await tableCounts(f.w)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
    const stored = await q(`SELECT metric_code, time_bucket, value::text AS value, unit, threshold_status, source_row_count, calculation_status FROM business_intelligence.metric_results WHERE run_id = $1 ORDER BY metric_code, time_bucket`, [out.run.calculationRunId]);
    const by = (code: string) => stored.filter((r) => r.metric_code === code).map((r) => [r.time_bucket, r.value]);
    expect(by('revenue')).toEqual([['2026-01', '2000.75'], ['2026-02', '300.1']]);
    expect(by('cost')).toEqual([['2026-01', '750.3'], ['2026-02', '100.05']]);
    expect(by('margin')).toEqual([['2026-01', '1250.45'], ['2026-02', '200.05']]);
    expect(by('margin_rate')).toEqual([['2026-01', '0.6249906285'], ['2026-02', '0.6666111296']]);
    const [input] = await q(`SELECT dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest FROM business_intelligence.metric_calculation_run_inputs WHERE run_id = $1`, [out.run.calculationRunId]);
    expect(input).toMatchObject({ dataset_id: f.ds.datasetId, dataset_version_id: f.ds.versionId, row_count: 3, rows_fingerprint: out.run.datasets[0]!.rowsFingerprint, seal_digest: f.ds.seal.rowsDigest });
  });

  it('keeps the source timestamp and the persisted time apart: persisted_at is the database clock, the hand-off source time is the stored version time', async () => {
    const f = await financialWorld('P2');
    const before = Date.now();
    const out = ok(await go(f.w));
    const [r] = await q(`SELECT handoff_source_timestamp, persisted_at FROM business_intelligence.metric_calculation_runs WHERE id = $1`, [out.run.calculationRunId]);
    expect(r.handoff_source_timestamp.toISOString()).toBe(out.run.handoffSourceTimestamp);
    expect(r.persisted_at.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(r.persisted_at.getTime()).toBeGreaterThan(r.handoff_source_timestamp.getTime());
    expect(out.persistedAt.getTime()).toBe(r.persisted_at.getTime());
  });

  it('round trip: what is stored and read back is exactly the in-memory run, and the PR #409 intelligence hand-off built from either is identical', async () => {
    const f = await financialWorld('P3');
    const source = new PostgresWarehouseRowSource(biCtx(f.w));
    const inMemory = ok(await svc.calculate(biCtx(f.w), f.w.businessId, { correlationId: 'corr-1' }, source)).run;
    const persisted = ok(await go(f.w, 'corr-1'));
    expect(persisted.run).toEqual(inMemory);
    const read = ok(await persistence.get(biCtx(f.w), f.w.businessId, inMemory.calculationRunId));
    expect(read.run).toEqual(inMemory);
    const a = buildIntelligenceHandoff(inMemory); const b = buildIntelligenceHandoff(read.run);
    expect(a.ok && b.ok && a.handoff).toEqual(b.ok && b.handoff);
    expect(runDigest(read.run)).toBe(runDigest(inMemory));
  });

  it('is idempotent: the same calculation again is a replay with the same persisted time and writes no row; another correlation id keeps the FIRST correlation as provenance', async () => {
    const f = await financialWorld('P4');
    const first = ok(await go(f.w, 'first-request'));
    const counts = await tableCounts(f.w);
    await new Promise((r) => setTimeout(r, 25));
    const again = ok(await go(f.w, 'second-request'));
    expect(again.replayed).toBe(true);
    expect(again.persistedAt.getTime()).toBe(first.persistedAt.getTime());
    expect(again.run.correlationId).toBe('first-request');
    expect({ ...again.run, correlationId: '' }).toEqual({ ...first.run, correlationId: '' });
    expect(await tableCounts(f.w)).toEqual(counts);
  });

  it('concurrent identical calculations store exactly one run with one set of results', async () => {
    const f = await financialWorld('P5');
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => go(f.w, `c-${i}`)));
    const oks = all.map((r) => ok(r));
    expect(oks.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(oks.map((r) => r.run.calculationRunId)).size).toBe(1);
    expect(new Set(oks.map((r) => r.run.correlationId)).size).toBe(1);
    expect(await tableCounts(f.w)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
  });

  it('stores results that have nothing to calculate as NULL (no_data), and a run that reads no dataset (target metrics only) with no input', async () => {
    const w = await createBiWorld(admin, 'P6'); const ds = await sealedDataset(w, [{ other: 1, date: '2026-01-02T00:00:00Z' }, { other: 2, date: '2026-01-03T00:00:00Z' }]);
    await reg(w, metric(ds.datasetId, { code: 'ghost', aggregation: 'average', sourceField: 'missing', timeGrain: 'all_time' }));
    const out = ok(await go(w));
    expect(out.run.results[0]).toMatchObject({ value: null, calculationStatus: 'no_data', threshold: { status: 'no_data', targetMet: false } });
    expect((await q(`SELECT value, calculation_status, threshold_status FROM business_intelligence.metric_results WHERE run_id = $1`, [out.run.calculationRunId]))[0]).toEqual({ value: null, calculation_status: 'no_data', threshold_status: 'no_data' });
    expect(ok(await persistence.get(biCtx(w), w.businessId, out.run.calculationRunId)).run).toEqual(out.run);

    const t = await createBiWorld(admin, 'P6t'); const tds = await sealedDataset(t, SALES);
    await reg(t, metric(tds.datasetId, { code: 'goal', metricType: 'target', aggregation: undefined, sourceField: undefined, target: 125.5, timeGrain: 'all_time' }));
    const targetOnly = ok(await go(t));
    expect(targetOnly.run.datasets).toEqual([]);
    expect(await tableCounts(t)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 0, metric_results: 1 });
    expect(ok(await persistence.get(biCtx(t), t.businessId, targetOnly.run.calculationRunId)).run).toEqual(targetOnly.run);
  });

  describe('fails closed on its inputs', () => {
    it('a dataset whose latest version has no sealed rows cannot be calculated: typed refusal, nothing stored', async () => {
      const w = await createBiWorld(admin, 'F1');
      const p = await publishBoPackage(admin, w, { recordCount: 2 }); const out = await intake.ingest(biCtx(w), p.handoff);
      if (out.outcome !== 'VALIDATED') throw new Error('fixture');
      const d = await datasets.materialize(biCtx(w), out.intakePackageId);
      await reg(w, metric(d.datasetId, { code: 'unsealed' }));
      expect(await go(w)).toMatchObject({ ok: false, code: 'DATASET_ROWS_UNAVAILABLE' });
      expect(await tableCounts(w)).toEqual({ metric_calculation_runs: 0, metric_calculation_run_inputs: 0, metric_results: 0 });
    });

    it('rows altered after sealing are never calculated (the seal is re-checked on every read) and nothing is stored', async () => {
      const f = await financialWorld('F2');
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`UPDATE business_intelligence.warehouse_dataset_rows SET row_data = '{"amount":"1","cost":"1","date":"2026-01-01T00:00:00Z"}' WHERE dataset_version_id = $1 AND row_number = 1`, [f.ds.versionId]); await c.query('COMMIT'); } finally { c.release(); }
      const out = await go(f.w);
      expect(out).toMatchObject({ ok: false, code: 'DATASET_ROWS_UNAVAILABLE' });
      expect(JSON.stringify(out)).not.toMatch(/seal|digest|business_intelligence|postgres/i);
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(0);
    });

    it('persist refuses a run that does not match the sealed rows it claims to have read (different rows, version or digest), a tampered run, and an input set that does not match', async () => {
      const f = await financialWorld('F3'); const source = new PostgresWarehouseRowSource(biCtx(f.w));
      const calc = ok(await svc.calculate(biCtx(f.w), f.w.businessId, { correlationId: 'c' }, source)).run;
      const inputs = source.inputs;
      const zero = () => { const m = new Map(inputs); return m; };
      const [dsId, input] = [...inputs.entries()][0]!;
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, { ...calc, datasets: [{ ...calc.datasets[0]!, rowsFingerprint: 'e'.repeat(64) }] }, zero())).toMatchObject({ ok: false, code: 'RUN_IDENTITY_MISMATCH' });
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, calc, new Map([[dsId, { ...input, sealDigest: 'e'.repeat(64) }]]))).toMatchObject({ ok: false, code: 'INPUT_MISMATCH' });
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, calc, new Map([[dsId, { ...input, datasetVersionId: randomUUID() }]]))).toMatchObject({ ok: false, code: 'INPUT_MISMATCH' });
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, calc, new Map())).toMatchObject({ ok: false, code: 'INPUT_MISMATCH' });
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, calc, new Map([[dsId, { ...input, rowCount: 99 }]]))).toMatchObject({ ok: false, code: 'INPUT_MISMATCH' });
      // a value altered to another valid number keeps every id valid, but it is not what the sealed rows and the registry calculate
      const tampered = structuredClone(calc); tampered.results[0]!.value = '1';
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, tampered, inputs)).toMatchObject({ ok: false, code: 'RUN_NOT_REPRODUCIBLE' });
      const wrongStatus = structuredClone(calc); wrongStatus.results[0]!.threshold = { status: 'critical', targetMet: false };
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, wrongStatus, inputs)).toMatchObject({ ok: false, code: 'RUN_NOT_REPRODUCIBLE' });
      const wrongCount = structuredClone(calc); wrongCount.results[0]!.sourceRowCount = 99;
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, wrongCount, inputs)).toMatchObject({ ok: false, code: 'RUN_NOT_REPRODUCIBLE' });
      const forgedId = structuredClone(calc); forgedId.results[0]!.metricResultId = randomUUID();
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, forgedId, inputs)).toMatchObject({ ok: false, code: 'RESULT_INVALID' });
      expect(await tableCounts(f.w)).toEqual({ metric_calculation_runs: 0, metric_calculation_run_inputs: 0, metric_results: 0 });
      // and the genuine run still persists
      expect(ok(await persistence.persist(biCtx(f.w), f.w.businessId, calc, inputs)).replayed).toBe(false);
    });

    it('a run computed from rows the warehouse does not hold (caller-supplied rows) cannot be persisted', async () => {
      const f = await financialWorld('F4');
      const fake = ok(await svc.calculate(biCtx(f.w), f.w.businessId, { correlationId: 'c' }, { rows: async () => [{ amount: '5', cost: '1', date: '2026-01-01T00:00:00Z' }] }));
      const claimed = new Map([[f.ds.datasetId, { datasetVersionId: f.ds.versionId, versionNumber: 1, rowCount: 1, sealDigest: f.ds.seal.rowsDigest }]]);
      expect(await persistence.persist(biCtx(f.w), f.w.businessId, fake.run, claimed)).toMatchObject({ ok: false, code: 'INPUT_MISMATCH' });
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(0);
    });

    it('a datasets over the frozen 100000-row limit is refused, never truncated or stored', async () => {
      expect(MAX_DATASET_ROWS).toBe(100_000);
      const w = await createBiWorld(admin, 'F5');
      const p = await publishBoPackage(admin, w, { recordCount: MAX_DATASET_ROWS + 1 }); const out = await intake.ingest(biCtx(w), p.handoff);
      if (out.outcome !== 'VALIDATED') throw new Error('fixture');
      const d = await datasets.materialize(biCtx(w), out.intakePackageId);
      const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
      // development fixture: bulk-load as the administrator (the repository's batch bound would need ten calls); the seal still comes from the database via the repository
      await q(`INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
               SELECT $1,$2,$3,$4,$5, g, '{"amount":"1"}', $6 FROM generate_series(1, $7::int) g`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, d.datasetVersionId, source.id, MAX_DATASET_ROWS + 1]);
      await warehouse.sealVersion(biCtx(w), w.businessId, d.datasetVersionId);
      await reg(w, metric(d.datasetId, { code: 'huge', timeGrain: 'all_time' }));
      expect(await go(w)).toMatchObject({ ok: false, code: 'DATASET_TOO_LARGE' });
      expect((await tableCounts(w)).metric_calculation_runs).toBe(0);
    }, 180_000);
  });

  describe('atomic and consistent at the database', () => {
    async function recordOf(f: Awaited<ReturnType<typeof financialWorld>>) {
      const source = new PostgresWarehouseRowSource(biCtx(f.w));
      const calc = ok(await svc.calculate(biCtx(f.w), f.w.businessId, { correlationId: 'c' }, source)).run;
      const stored = ok(await persistence.persist(biCtx(f.w), f.w.businessId, calc, source.inputs));
      const record = await runs.get(biCtx(f.w), f.w.businessId, calc.calculationRunId);
      return { calc, stored, record };
    }
    const fresh = (record: Awaited<ReturnType<typeof recordOf>>['record']): CalculationRunRecord => {
      const id = randomUUID();
      return { ...record, id, calculationHandoffId: randomUUID(), results: record.results.map((r) => ({ ...r, id: randomUUID() })) };
    };

    it('a result that disagrees with the stored definition version it cites (hash, dataset, code or type) is refused and the whole run leaves no trace', async () => {
      const f = await financialWorld('A1'); const { record } = await recordOf(f);
      type ResultRec = typeof record.results[number];
      const changes: Array<[string, (r: ResultRec) => ResultRec]> = [
        ['content hash', (r) => ({ ...r, metricContentHash: 'd'.repeat(64) })],
        ['code', (r) => ({ ...r, metricCode: 'other_code' })],
        ['type', (r) => ({ ...r, metricType: 'ratio' })],
        ['definition version', (r) => ({ ...r, metricVersion: 7 })],
        ['definition', (r) => ({ ...r, metricDefinitionId: randomUUID() })],
      ];
      for (const [label, change] of changes) {
        const bad = fresh(record); bad.results = bad.results.map((r, i) => (i === 0 ? change(r) : r));
        const e = await refused(runs.persist(biCtx(f.w), f.w.businessId, bad));
        expect(e?.name, label).toBe('ValidationError');
        expect(e?.message, label).not.toMatch(/business_intelligence|trigger|constraint|postgres/i);
      }
      expect(await tableCounts(f.w)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 }); // only the genuine run
    });

    it('an input that is not the sealed version the run states (wrong digest, row count or an unsealed version) is refused', async () => {
      const f = await financialWorld('A2'); const { record } = await recordOf(f);
      for (const change of [{ sealDigest: 'c'.repeat(64) }, { rowCount: 2 }, { datasetVersionId: randomUUID() }]) {
        const bad = fresh(record); bad.inputs = [{ ...bad.inputs[0]!, ...change }];
        expect((await refused(runs.persist(biCtx(f.w), f.w.businessId, bad)))?.name).toBe('ValidationError');
      }
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(1);
    });

    it('a run is complete or absent: the database checks result count, input count and dataset coverage at commit', async () => {
      const f = await financialWorld('A3'); const { record } = await recordOf(f);
      const ctx = biCtx(f.w); const id = randomUUID(); const handoff = randomUUID();
      const insertRun = (query: Parameters<Parameters<typeof asApp>[1]>[0], resultCount: number, datasets: unknown) => query(
        `INSERT INTO business_intelligence.metric_calculation_runs (id, tenant_id, workspace_id, business_id, calculation_handoff_id, correlation_id, handoff_source_timestamp, metric_count, result_count, input_count, datasets, run_digest)
         VALUES ($1,$2,$3,$4,$5,'c', now(), 1, $6, 1, $7::jsonb, repeat('1', 64))`, [id, f.w.tenantId, f.w.workspaceId, f.w.businessId, handoff, resultCount, JSON.stringify(datasets)]);
      const insertInput = (query: Parameters<Parameters<typeof asApp>[1]>[0]) => query(
        `INSERT INTO business_intelligence.metric_calculation_run_inputs (tenant_id, workspace_id, business_id, run_id, dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [f.w.tenantId, f.w.workspaceId, f.w.businessId, id, record.inputs[0]!.datasetId, record.inputs[0]!.datasetVersionId, record.inputs[0]!.rowCount, record.inputs[0]!.rowsFingerprint, record.inputs[0]!.sealDigest]);
      const datasetsJson = [{ warehouseDatasetId: record.inputs[0]!.datasetId, rowCount: record.inputs[0]!.rowCount, rowsFingerprint: record.inputs[0]!.rowsFingerprint }];
      // claims two results, holds none
      const e1 = await refused(asApp(ctx, async (query) => { await insertRun(query, 2, datasetsJson); await insertInput(query); }));
      expect(e1?.code).toBe('23514');
      // states a dataset fingerprint its input does not carry
      const e2 = await refused(asApp(ctx, async (query) => { await insertRun(query, 1, [{ ...datasetsJson[0], rowsFingerprint: 'a'.repeat(64) }]); await insertInput(query); }));
      expect(e2?.code).toBe('23514');
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE id = $1`, [id]))[0].n)).toBe(0);
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_run_inputs WHERE run_id = $1`, [id]))[0].n)).toBe(0);
    });

    /** A direct (SQL) run that is complete in every respect except what `o` changes. Used to isolate one database rule at a time. */
    async function directRun(f: Awaited<ReturnType<typeof financialWorld>>, record: Awaited<ReturnType<typeof recordOf>>['record'], o: { datasets?: unknown[]; withInput?: boolean }) {
      const bad = fresh(record); const result = bad.results.find((r) => r.metricType === 'base')!; const withInput = o.withInput ?? true;
      const datasets = o.datasets ?? bad.datasets;
      await asApp(biCtx(f.w), async (query) => {
        await query(`INSERT INTO business_intelligence.metric_calculation_runs (id, tenant_id, workspace_id, business_id, calculation_handoff_id, correlation_id, handoff_source_timestamp, metric_count, result_count, input_count, datasets, run_digest)
                     VALUES ($1,$2,$3,$4,$5,'c', now(), 1, 1, $6, $7::jsonb, repeat('3', 64))`, [bad.id, f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.calculationHandoffId, withInput ? 1 : 0, JSON.stringify(datasets)]);
        if (withInput) await query(`INSERT INTO business_intelligence.metric_calculation_run_inputs (tenant_id, workspace_id, business_id, run_id, dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.id, bad.inputs[0]!.datasetId, bad.inputs[0]!.datasetVersionId, bad.inputs[0]!.rowCount, bad.inputs[0]!.rowsFingerprint, bad.inputs[0]!.sealDigest]);
        await query(`INSERT INTO business_intelligence.metric_results (id, tenant_id, workspace_id, business_id, run_id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key, group_dimensions, value, unit, threshold_status, calculation_status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'k','{}', 1, $12, 'normal', 'completed')`,
          [randomUUID(), f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.id, result.metricDefinitionId, result.metricVersion, result.metricCode, result.metricType, result.metricContentHash, result.warehouseDatasetId, result.unit]);
      });
      return bad.id;
    }
    const runRows = async (id: string) => Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE id = $1`, [id]))[0].n);

    it('the baseline for the next two rules: a complete direct run is accepted (so each refusal below is caused by exactly one property)', async () => {
      const f = await financialWorld('A3b'); const { record } = await recordOf(f);
      expect(await runRows(await directRun(f, record, {}))).toBe(1);
    });

    it('a run whose stated dataset fingerprint is not the one its input carries is refused at commit, even though counts and coverage are right', async () => {
      const f = await financialWorld('A3c'); const { record } = await recordOf(f);
      const stated = [{ warehouseDatasetId: record.inputs[0]!.datasetId, rowCount: record.inputs[0]!.rowCount, rowsFingerprint: 'a'.repeat(64) }];
      const before = Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE business_id = $1`, [f.w.businessId]))[0].n);
      const e = await refused(directRun(f, record, { datasets: stated }));
      expect(e?.code).toBe('23514'); expect(e?.message).toMatch(/dataset fingerprints/);
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE business_id = $1`, [f.w.businessId]))[0].n)).toBe(before);
    });

    it('a run with a base result from a dataset it did not read is refused at commit, even though counts and fingerprints are right', async () => {
      const f = await financialWorld('A3d'); const { record } = await recordOf(f);
      const before = Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE business_id = $1`, [f.w.businessId]))[0].n);
      const e = await refused(directRun(f, record, { datasets: [], withInput: false }));
      expect(e?.code).toBe('23514'); expect(e?.message).toMatch(/did not read/);
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE business_id = $1`, [f.w.businessId]))[0].n)).toBe(before);
    });

    it('persisted_at cannot be supplied: a back-dated time written directly is replaced by the database clock', async () => {
      const f = await financialWorld('A4'); const { record } = await recordOf(f); const ctx = biCtx(f.w);
      const bad = fresh(record); const result = bad.results.find((r) => r.metricType === 'base')!;
      const datasetsJson = JSON.stringify(bad.datasets);
      await asApp(ctx, async (query) => {
        await query(`INSERT INTO business_intelligence.metric_calculation_runs (id, tenant_id, workspace_id, business_id, calculation_handoff_id, correlation_id, handoff_source_timestamp, metric_count, result_count, input_count, datasets, run_digest, persisted_at)
                     VALUES ($1,$2,$3,$4,$5,'c', now(), 1, 1, 1, $6::jsonb, repeat('2', 64), '2001-01-01')`, [bad.id, f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.calculationHandoffId, datasetsJson]);
        await query(`INSERT INTO business_intelligence.metric_calculation_run_inputs (tenant_id, workspace_id, business_id, run_id, dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.id, bad.inputs[0]!.datasetId, bad.inputs[0]!.datasetVersionId, bad.inputs[0]!.rowCount, bad.inputs[0]!.rowsFingerprint, bad.inputs[0]!.sealDigest]);
        await query(`INSERT INTO business_intelligence.metric_results (id, tenant_id, workspace_id, business_id, run_id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key, group_dimensions, value, unit, threshold_status, calculation_status, persisted_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}', 1, $13, 'normal', 'completed', '2001-01-01')`,
          [randomUUID(), f.w.tenantId, f.w.workspaceId, f.w.businessId, bad.id, result.metricDefinitionId, result.metricVersion, result.metricCode, result.metricType, result.metricContentHash, result.warehouseDatasetId, 'k', result.unit]);
      });
      const [r] = await q(`SELECT persisted_at FROM business_intelligence.metric_calculation_runs WHERE id = $1`, [bad.id]);
      const [m] = await q(`SELECT persisted_at FROM business_intelligence.metric_results WHERE run_id = $1`, [bad.id]);
      expect(r.persisted_at.getFullYear()).toBeGreaterThanOrEqual(2026); expect(m.persisted_at.getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('a different run under an existing run identity is a conflict, never an overwrite', async () => {
      const f = await financialWorld('A5'); const { record } = await recordOf(f);
      const e = await refused(runs.persist(biCtx(f.w), f.w.businessId, { ...record, runDigest: 'f'.repeat(64) }));
      expect(e?.name).toBe('ConflictError');
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(1);
    });

    it('rejects malformed input before any write', async () => {
      const f = await financialWorld('A6'); const { record } = await recordOf(f);
      for (const bad of [{ ...record, id: 'nope' }, { ...record, calculationHandoffId: '{x}' }, { ...record, results: [] }, { ...record, inputs: [] }, { ...record, handoffSourceTimestamp: 'yesterday' }]) {
        expect((await refused(runs.persist(biCtx(f.w), f.w.businessId, fresh(bad as typeof record) && (bad as typeof record))))?.name).toBe('ValidationError');
      }
    });
  });

  describe('isolation, RLS and append-only evidence', () => {
    it('another business, workspace or tenant can neither read nor persist this run (uniform NotFound), and cannot see it through SQL', async () => {
      const a = await financialWorld('X1a'); const b = await financialWorld('X1b');
      const out = ok(await go(a.w));
      for (const call of [
        () => persistence.get(biCtx(b.w), b.w.businessId, out.run.calculationRunId),
        () => persistence.get(biCtx(b.w), a.w.businessId, out.run.calculationRunId),
        () => persistence.get(biCtx(a.w), b.w.businessId, out.run.calculationRunId),
        () => persistence.get(biCtx(a.w), a.w.businessId, 'not-a-uuid'),
        () => persistence.get(biCtx(a.w), a.w.businessId, randomUUID()),
      ]) expect((await refused(call()))?.name).toBe('NotFoundError');
      const seen = await asApp(biCtx(b.w), async (query) => (await query(`SELECT (SELECT count(*) FROM business_intelligence.metric_calculation_runs WHERE id = $1)::int AS runs,
        (SELECT count(*) FROM business_intelligence.metric_results WHERE run_id = $1)::int AS results`, [out.run.calculationRunId])).rows[0]);
      expect(seen).toEqual({ runs: 0, results: 0 });
      expect(await refused(go(a.w, 'x', { businessId: b.w.businessId }))).toMatchObject({ name: 'NotFoundError' });
    });

    it('a sibling business of the same workspace has its own runs: the explicit business predicate separates what RLS cannot', async () => {
      const a = await financialWorld('X2');
      const [sib] = await q(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.w.tenantId, a.w.workspaceId, `sib-${randomUUID().slice(0, 8)}`]);
      const out = ok(await go(a.w));
      expect((await refused(persistence.get(biCtx(a.w), sib.id, out.run.calculationRunId)))?.name).toBe('NotFoundError');
      expect(await go(a.w, 'c', { businessId: sib.id })).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.metric_calculation_runs WHERE business_id = $1`, [sib.id]))[0].n)).toBe(0);
    });

    it('a result cannot cite another business\'s definition even within the tenant (composite key), nor a run of another business', async () => {
      const a = await financialWorld('X3a'); const b = await financialWorld('X3b');
      const outA = ok(await go(a.w)); const outB = ok(await go(b.w));
      const [ownDef] = await q(`SELECT metric_definition_id, version_number, content_hash, definition_content ->> 'code' AS code, definition_content ->> 'metricType' AS metric_type FROM business_intelligence.metric_definition_versions WHERE business_id = $1 AND content_hash IS NOT NULL ORDER BY definition_content ->> 'code' LIMIT 1`, [a.w.businessId]);
      const [foreignDef] = await q(`SELECT metric_definition_id, version_number, content_hash FROM business_intelligence.metric_definition_versions WHERE business_id = $1 LIMIT 1`, [b.w.businessId]);
      // same tenant needed for the test: attach the foreign business's definition to a result of A's run by direct SQL as the administrator's session, which RLS does not stop
      const e = await refused(admin.query(`INSERT INTO business_intelligence.metric_results (id, tenant_id, workspace_id, business_id, run_id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key, group_dimensions, unit, threshold_status, calculation_status, value)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'x','base',$8,$9,'k','{}','usd','normal','completed',1)`, [randomUUID(), a.w.tenantId, a.w.workspaceId, a.w.businessId, outA.run.calculationRunId, foreignDef.metric_definition_id, foreignDef.version_number, foreignDef.content_hash, a.ds.datasetId]));
      expect(['23503', '23514']).toContain(e?.code); // the scope trigger refuses before the composite foreign key is checked
      const e2 = await refused(admin.query(`INSERT INTO business_intelligence.metric_results (id, tenant_id, workspace_id, business_id, run_id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key, group_dimensions, unit, threshold_status, calculation_status, value)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$10,$11,$8,$9,'k','{}','usd','normal','completed',1)`, [randomUUID(), a.w.tenantId, a.w.workspaceId, a.w.businessId, outB.run.calculationRunId, ownDef.metric_definition_id, ownDef.version_number, ownDef.content_hash, a.ds.datasetId, ownDef.code, ownDef.metric_type]));
      expect(e2?.code).toBe('23503'); // the run row of the other business does not exist in this scope
    });

    it('runs, inputs and results are append-only: update and delete are refused, and truncate is blocked by trigger and by privilege', async () => {
      const f = await financialWorld('X4'); const out = ok(await go(f.w)); const id = out.run.calculationRunId;
      for (const [sql, args] of [
        ['UPDATE business_intelligence.metric_calculation_runs SET status = status WHERE id = $1', [id]],
        ['DELETE FROM business_intelligence.metric_calculation_runs WHERE id = $1', [id]],
        ['UPDATE business_intelligence.metric_results SET value = 0 WHERE run_id = $1', [id]],
        ['DELETE FROM business_intelligence.metric_results WHERE run_id = $1', [id]],
        ['UPDATE business_intelligence.metric_calculation_run_inputs SET row_count = 0 WHERE run_id = $1', [id]],
        ['DELETE FROM business_intelligence.metric_calculation_run_inputs WHERE run_id = $1', [id]],
      ] as const) {
        expect((await refused(asApp(biCtx(f.w), (query) => query(sql, [...args]))))?.message, sql).toMatch(/append-only table/);
      }
      // TRUNCATE is verified from the catalog (see BiWarehouseRows.integration.test.ts): the trigger on the append-only function, and no TRUNCATE privilege for the application role
      for (const t of ['metric_calculation_runs', 'metric_calculation_run_inputs', 'metric_results']) {
        const triggers = await q(`SELECT p.proname, (tg.tgtype & 32) = 32 AS on_truncate FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid WHERE tg.tgrelid = ('business_intelligence.' || $1)::regclass AND tg.tgname = $2`, [t, `forbid_truncate_${t}`]);
        expect(triggers, t).toEqual([{ proname: 'forbid_mutation', on_truncate: true }]);
        const [priv] = (await asApp(biCtx(f.w), (query) => query(`SELECT has_table_privilege(current_user, $1, 'TRUNCATE') AS can`, [`business_intelligence.${t}`]))).rows;
        expect(priv.can, t).toBe(false);
      }
      expect(await tableCounts(f.w)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
    });

    it('stored evidence that was altered behind the application\'s back is detected on read (value, id and digest are all re-verified)', async () => {
      const f = await financialWorld('X5'); const out = ok(await go(f.w)); const id = out.run.calculationRunId;
      const tamper = async (sql: string, args: unknown[]) => { const c = await admin.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, args); await c.query('COMMIT'); } finally { c.release(); } };
      expect(ok(await persistence.get(biCtx(f.w), f.w.businessId, id)).run).toEqual(out.run);
      await tamper(`UPDATE business_intelligence.metric_results SET value = value + 1 WHERE run_id = $1 AND metric_code = 'revenue' AND time_bucket = '2026-01'`, [id]);
      expect(await persistence.get(biCtx(f.w), f.w.businessId, id)).toMatchObject({ ok: false, code: 'STORED_RUN_INTEGRITY' });
      expect(await go(f.w)).toMatchObject({ ok: false, code: 'STORED_RUN_INTEGRITY' }); // a replay does not hand back a corrupted run
    });
  });

  describe('compatibility, scope of work, and Business Operations', () => {
    it('only approved, active metrics are persisted; an unapproved metric named explicitly is refused and nothing is stored', async () => {
      const f = await financialWorld('C1'); const draft = await reg(f.w, metric(f.ds.datasetId, { code: 'draftish', governanceStatus: 'draft' }));
      expect(await go(f.w, 'c', { metricIds: [draft] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(0);
      expect(ok(await go(f.w)).run.results.map((r) => r.metricCode)).not.toContain('draftish');
    });

    it('a new definition version is a new run and the earlier run stays readable exactly as stored', async () => {
      const f = await financialWorld('C2'); const first = ok(await go(f.w));
      expect((await registry.revise(biCtx(f.w), f.w.businessId, f.cost, metric(f.ds.datasetId, { code: 'cost', sourceField: 'cost', description: 'v2' }))).ok).toBe(true);
      const second = ok(await go(f.w));
      expect(second.run.calculationRunId).not.toBe(first.run.calculationRunId);
      expect(second.run.results.find((r) => r.metricCode === 'cost')!.metricVersion).toBe(2);
      expect(ok(await persistence.get(biCtx(f.w), f.w.businessId, first.run.calculationRunId)).run).toEqual(first.run);
      expect((await tableCounts(f.w)).metric_calculation_runs).toBe(2);
    });

    it('writes only BI tables and reads only BI and registry tables: no Business Operations table is touched and its records are unchanged', async () => {
      const f = await financialWorld('C3');
      const bo = async () => JSON.stringify([await q(`SELECT * FROM business_operations.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [f.w.businessId]), await q(`SELECT * FROM business_operations.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [f.w.businessId])]);
      const before = await bo();
      const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
      vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try { ok(await go(f.w)); } finally { vi.restoreAllMocks(); }
      expect(statements.filter((s) => /business_operations/i.test(s))).toEqual([]);
      const writes = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s));
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w).toMatch(/INSERT INTO business_intelligence\.(metric_calculation_runs|metric_calculation_run_inputs|metric_results)/);
      expect(await bo()).toBe(before);
    });
  });
});
