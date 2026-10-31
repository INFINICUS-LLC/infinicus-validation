/**
 * BI-2-DEV-05: BI-10 metric calculation over the stored, governed registry (live PostgreSQL, application role, RLS enforced) with warehouse rows supplied through a
 * WarehouseRowSource. The platform has no warehouse row store yet, so the rows here are test-supplied; what is proven is that the calculation consumes exactly the
 * approved BI-09 hand-off of ONE business, asks the source only for that business's datasets (in its scope), is exact and replayable, carries its provenance,
 * refuses what it cannot calculate without a partial result, and reads the registry without writing anything. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, getPool, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceMetricCalculationService, type WarehouseRowSource } from '../src/BusinessIntelligenceMetricCalculationService.js';
import { BusinessIntelligenceMetricRegistryService } from '../src/BusinessIntelligenceMetricRegistryService.js';
import { MAX_DATASET_ROWS, metricContentHash, type MetricDefinitionContent, type MetricDefinitionInput, type MetricScope, type WarehouseRow } from '../src/index.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() });
const SALES: WarehouseRow[] = [
  { amount: '1200.50', cost: '400.20', date: '2026-01-15T09:00:00Z', channel: 'web' },
  { amount: '800.25', cost: '350.10', date: '2026-01-20T09:00:00Z', channel: 'store' },
  { amount: '300.10', cost: '100.05', date: '2026-02-02T09:00:00Z', channel: 'web' },
];

class Source implements WarehouseRowSource {
  calls: Array<{ scope: MetricScope; id: string }> = [];
  constructor(private readonly data: Map<string, readonly WarehouseRow[]>, private readonly failWith?: Error) {}
  async rows(scope: MetricScope, id: string): Promise<readonly WarehouseRow[]> {
    this.calls.push({ scope: { ...scope }, id });
    if (this.failWith) throw this.failWith;
    const rows = this.data.get(id);
    if (!rows) throw new Error('no such dataset');
    return rows;
  }
}

describe.runIf(run)('BusinessIntelligenceMetricCalculationService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const writer = new BusinessIntelligenceMetricRegistryService();
  const svc = new BusinessIntelligenceMetricCalculationService();
  let seq = 0;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  async function dataset(w: World): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,'financial','ds','active')`,
      [id, w.tenantId, w.workspaceId, w.businessId, `ds-${++seq}-${Date.now()}`]);
    return id;
  }
  const input = (ds: string, over: MetricDefinitionInput = {}): MetricDefinitionInput =>
    ({ name: 'Metric', code: `m_${++seq}`, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
  const reg = async (w: World, i: MetricDefinitionInput): Promise<string> => {
    const r = await writer.register(ctxOf(w), w.businessId, i); expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  };
  /** revenue, cost (base, monthly) and margin = revenue - cost, margin_rate = margin / revenue. */
  async function financialWorld(label: string) {
    const w = await createWorld(admin, label); const ds = await dataset(w);
    const revenue = await reg(w, input(ds, { code: 'revenue', sourceField: 'amount' }));
    const cost = await reg(w, input(ds, { code: 'cost', sourceField: 'cost' }));
    const margin = await reg(w, input(ds, { code: 'margin', metricType: 'derived', aggregation: undefined, sourceField: undefined, dependencies: [revenue, cost], formula: { operator: 'subtract' } }));
    const rate = await reg(w, input(ds, { code: 'margin_rate', metricType: 'ratio', aggregation: undefined, sourceField: undefined, dependencies: [margin, revenue], unit: 'ratio' }));
    return { w, ds, revenue, cost, margin, rate };
  }
  const calc = (w: World, source: WarehouseRowSource, over: { metricIds?: string[]; correlationId?: string; businessId?: string; ctx?: TenantContext } = {}) =>
    svc.calculate(over.ctx ?? ctxOf(w), over.businessId ?? w.businessId, { correlationId: over.correlationId ?? 'corr-1', ...(over.metricIds ? { metricIds: over.metricIds } : {}) }, source);
  const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };
  const state = async (w: World) => (await q(
    `SELECT (SELECT count(*) FROM business_intelligence.metric_definitions WHERE business_id = $1) AS defs,
            (SELECT md5(coalesce(string_agg(id::text || content_hash, ',' ORDER BY id), '')) FROM business_intelligence.metric_definition_versions WHERE business_id = $1) AS fingerprint,
            (SELECT count(*) FROM business_intelligence.metric_calculated_values WHERE business_id = $1) AS calculated,
            (SELECT count(*) FROM audit.audit_events WHERE tenant_id = $2) AS audits`, [w.businessId, w.tenantId]))[0];

  it('calculates the approved hand-off end to end with exact results: revenue, cost, margin and margin rate by month', async () => {
    const f = await financialWorld('C1');
    const source = new Source(new Map([[f.ds, SALES]]));
    const r = ok(await calc(f.w, source)).run;
    const by = (code: string) => r.results.filter((x) => x.metricCode === code).map((x) => [x.group.timeBucket, x.value]);
    expect(by('revenue')).toEqual([['2026-01', '2000.75'], ['2026-02', '300.1']]);
    expect(by('cost')).toEqual([['2026-01', '750.3'], ['2026-02', '100.05']]);
    expect(by('margin')).toEqual([['2026-01', '1250.45'], ['2026-02', '200.05']]);
    expect(by('margin_rate')).toEqual([['2026-01', '0.6249906285'], ['2026-02', '0.6666111296']]);
    expect(r.results.filter((x) => x.metricCode === 'revenue').map((x) => x.sourceRowCount)).toEqual([2, 1]);
    expect(r.metricCount).toBe(4); expect(r.warehouseSnapshotId).toBeNull();
  });

  it('asks the row source only for the datasets of the hand-off, once each, with the hand-off\'s own scope', async () => {
    const f = await financialWorld('C2'); const second = await dataset(f.w);
    await reg(f.w, input(second, { code: 'refunds', sourceField: 'amount' }));
    const source = new Source(new Map([[f.ds, SALES], [second, [{ amount: '5', date: '2026-01-02T00:00:00Z' }]]]));
    ok(await calc(f.w, source));
    expect(source.calls.map((c) => c.id).sort()).toEqual([f.ds, second].sort());
    for (const c of source.calls) expect(c.scope).toEqual({ tenantId: f.w.tenantId, workspaceId: f.w.workspaceId, businessId: f.w.businessId });
  });

  it('replays identically (same run id, same values, same fingerprints) and is identical under concurrent callers; a new correlation id changes only the correlation id', async () => {
    const f = await financialWorld('C3'); const source = new Source(new Map([[f.ds, SALES]]));
    const first = ok(await calc(f.w, source, { correlationId: 'req-1' })).run;
    await new Promise((r) => setTimeout(r, 20));
    const again = ok(await calc(f.w, source, { correlationId: 'req-2' })).run;
    expect({ ...again, correlationId: '' }).toEqual({ ...first, correlationId: '' });
    const many = await Promise.all(Array.from({ length: 12 }, () => calc(f.w, source, { correlationId: 'same' })));
    expect(new Set(many.map((m) => JSON.stringify(ok(m).run))).size).toBe(1);
  });

  it('carries its provenance: handoff id, stored definition version, the stored content hash, dataset, row count and fingerprint, and the stored source timestamp', async () => {
    const f = await financialWorld('C4'); const source = new Source(new Map([[f.ds, SALES]]));
    const r = ok(await calc(f.w, source)).run;
    const stored = await q(`SELECT d.id, d.latest_version, v.content_hash, v.definition_content, to_char(max(v.created_at) OVER () AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS newest FROM business_intelligence.metric_definitions d JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id AND v.version_number = d.latest_version WHERE d.business_id = $1`, [f.w.businessId]);
    for (const row of stored) {
      const res = r.results.find((x) => x.metricId === row.id)!;
      expect(res).toMatchObject({ metricVersion: row.latest_version, metricContentHash: row.content_hash, warehouseDatasetId: f.ds, calculationHandoffId: r.calculationHandoffId });
      expect(metricContentHash(row.definition_content as MetricDefinitionContent)).toBe(row.content_hash);
    }
    expect(r.handoffSourceTimestamp).toBe(stored[0].newest);
    expect(r.datasets).toEqual([{ warehouseDatasetId: f.ds, rowCount: 3, rowsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it('a new definition version is calculated as that version, with a new run identity; different rows give a different run, not a different hand-off', async () => {
    const f = await financialWorld('C5'); const source = new Source(new Map([[f.ds, SALES]]));
    const before = ok(await calc(f.w, source)).run;
    const revised = await writer.revise(ctxOf(f.w), f.w.businessId, f.cost, input(f.ds, { code: 'cost', sourceField: 'cost', unit: 'usd', description: 'revised' }));
    expect(revised.ok).toBe(true);
    const after = ok(await calc(f.w, source)).run;
    expect(after.results.find((x) => x.metricCode === 'cost')!.metricVersion).toBe(2);
    expect(after.calculationHandoffId).not.toBe(before.calculationHandoffId);
    expect(after.calculationRunId).not.toBe(before.calculationRunId);
    const other = ok(await calc(f.w, new Source(new Map([[f.ds, [...SALES, { amount: '1', cost: '1', date: '2026-02-03T00:00:00Z' }]]])))).run;
    expect(other.calculationHandoffId).toBe(after.calculationHandoffId);
    expect(other.calculationRunId).not.toBe(after.calculationRunId);
  });

  it('is limited to the business: a sibling business, another tenant and Stage 2D definitions are never calculated or requested, and foreign ids are refused before any row is read', async () => {
    const f = await financialWorld('C6'); const sibling = await addBusiness(admin, f.w); const other = await financialWorld('C6b');
    const sibDs = await dataset(sibling); const sibMetric = await reg(sibling, input(sibDs, { code: 'sibling_only' }));
    await q(`INSERT INTO business_intelligence.metric_definitions (tenant_id, workspace_id, business_id, metric_code, domain, metric_type, name, unit, status) VALUES ($1,$2,$3,'legacy','financial','base','Legacy','usd','active')`, [f.w.tenantId, f.w.workspaceId, f.w.businessId]);
    const data = new Map<string, readonly WarehouseRow[]>([[f.ds, SALES], [sibDs, [{ amount: '9', date: '2026-01-01T00:00:00Z' }]], [other.ds, SALES]]);
    const source = new Source(data);
    const r = ok(await calc(f.w, source)).run;
    expect(r.results.map((x) => x.metricCode)).not.toContain('sibling_only'); expect(r.results.map((x) => x.metricCode)).not.toContain('legacy');
    expect(source.calls.map((c) => c.id)).toEqual([f.ds]);
    const guarded = new Source(data);
    expect(await calc(f.w, guarded, { metricIds: [sibMetric] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    expect(await calc(f.w, guarded, { metricIds: [other.revenue] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    await expect(calc(f.w, guarded, { businessId: other.w.businessId })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(calc(f.w, guarded, { ctx: { ...ctxOf(f.w), tenantId: other.w.tenantId } })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(calc(f.w, guarded, { businessId: 'not-a-uuid' })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(guarded.calls).toEqual([]);
  });

  it('only approved, active metrics are calculated: an unapproved metric named explicitly is refused, an empty registry has nothing to calculate, neither reads a row', async () => {
    const f = await financialWorld('C7'); const draft = await reg(f.w, input(f.ds, { code: 'draftish', governanceStatus: 'draft' }));
    const source = new Source(new Map([[f.ds, SALES]]));
    expect(await calc(f.w, source, { metricIds: [draft] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
    const empty = await createWorld(admin, 'C7e');
    expect(await calc(empty, source)).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
    expect(source.calls).toEqual([]);
    expect(ok(await calc(f.w, source)).run.results.map((x) => x.metricCode)).not.toContain('draftish');
  });

  it('dependency selection: a derived metric is refused without its dependencies and calculated with them', async () => {
    const f = await financialWorld('C8'); const source = new Source(new Map([[f.ds, SALES]]));
    expect(await calc(f.w, source, { metricIds: [f.margin] })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    expect(await calc(f.w, source, { metricIds: [f.margin, f.revenue] })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    const r = ok(await calc(f.w, source, { metricIds: [f.margin, f.revenue, f.cost] })).run;
    expect(r.results.map((x) => x.metricCode).sort()).toEqual(['cost', 'cost', 'margin', 'margin', 'revenue', 'revenue']);
  });

  it('refuses what it cannot calculate with a typed code and no partial result: unreadable, missing, oversize and non-numeric datasets; the cause of a read failure is never returned', async () => {
    const f = await financialWorld('C9');
    const secret = new Error('connect ECONNREFUSED postgresql://svc:Sup3rSecret@10.1.2.3:5432/warehouse');
    const failed = await calc(f.w, new Source(new Map(), secret));
    expect(failed).toMatchObject({ ok: false, code: 'DATASET_ROWS_UNAVAILABLE' });
    expect(JSON.stringify(failed)).not.toMatch(/Sup3rSecret|ECONNREFUSED|postgresql|10\.1\.2\.3/);
    expect(await calc(f.w, new Source(new Map()))).toMatchObject({ ok: false, code: 'DATASET_ROWS_UNAVAILABLE' });
    const big = Array.from({ length: MAX_DATASET_ROWS + 1 }, () => ({ amount: '1', cost: '1', date: '2026-01-01T00:00:00Z' }));
    expect(await calc(f.w, new Source(new Map([[f.ds, big]])))).toMatchObject({ ok: false, code: 'DATASET_TOO_LARGE' });
    const bad = await calc(f.w, new Source(new Map([[f.ds, [{ amount: 'twelve', cost: '1', date: '2026-01-01T00:00:00Z' }]]])));
    expect(bad).toMatchObject({ ok: false, code: 'VALUE_NOT_NUMERIC' }); expect(bad).not.toHaveProperty('run');
  }, 60_000);

  it('builds the BI-11..BI-18 intelligence hand-off from the calculation: derived identity, replay-identical, concurrent-identical, correlation excluded from the identity', async () => {
    const f = await financialWorld('C11'); const source = new Source(new Map([[f.ds, SALES]]));
    const first = ok(await svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'req-1' }, source));
    const h = first.intelligenceHandoff;
    expect(h).toMatchObject({ sourceBlock: 'BI-10', status: 'ready', calculationRunId: first.run.calculationRunId, correlationId: 'req-1', warehouseSnapshotId: null });
    expect(h.metricResultIds).toEqual(first.run.results.map((r) => r.metricResultId));
    expect(h.metricResults.filter((r) => r.metricCode === 'margin').map((r) => r.value)).toEqual(['1250.45', '200.05']);
    const again = ok(await svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'req-2' }, source)).intelligenceHandoff;
    expect(again.intelligenceHandoffId).toBe(h.intelligenceHandoffId);
    expect({ ...again, correlationId: '' }).toEqual({ ...h, correlationId: '' });
    const many = await Promise.all(Array.from({ length: 10 }, () => svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'same' }, source)));
    expect(new Set(many.map((m) => JSON.stringify(ok(m).intelligenceHandoff))).size).toBe(1);
  });

  it('the intelligence hand-off holds only the business\'s own results; foreign ids and refusals produce no hand-off and read no rows', async () => {
    const f = await financialWorld('C12'); const other = await financialWorld('C12b');
    const source = new Source(new Map([[f.ds, SALES], [other.ds, SALES]]));
    const h = ok(await svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'c' }, source)).intelligenceHandoff;
    expect(h.metricResults.every((r) => r.warehouseDatasetId === f.ds)).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(new RegExp(`${other.ds}|${other.revenue}|${other.w.tenantId}|${other.w.businessId}`));
    const guarded = new Source(new Map([[f.ds, SALES]]));
    expect(await svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'c', metricIds: [other.revenue] }, guarded)).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    await expect(svc.calculateForIntelligence(ctxOf(f.w), other.w.businessId, { correlationId: 'c' }, guarded)).rejects.toMatchObject({ name: 'NotFoundError' });
    const bad = await svc.calculateForIntelligence(ctxOf(f.w), f.w.businessId, { correlationId: 'c' }, new Source(new Map([[f.ds, [{ amount: 'x', cost: '1', date: '2026-01-01T00:00:00Z' }]]])));
    expect(bad).toMatchObject({ ok: false, code: 'VALUE_NOT_NUMERIC' }); expect(bad).not.toHaveProperty('intelligenceHandoff');
    expect(guarded.calls).toEqual([]);
  });

  it('reads the registry and nothing else: no write statement, no Business Operations table, and no registry, calculated-value or audit row changes', async () => {
    const f = await financialWorld('C10'); const source = new Source(new Map([[f.ds, SALES]]));
    const before = await state(f.w);
    const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await originalConnect(); const original = client.query.bind(client);
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
      return client;
    }) as never);
    try { ok(await calc(f.w, source)); await calc(f.w, source, { metricIds: [randomUUID()] }); } finally { vi.restoreAllMocks(); }
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|MERGE|COPY)\b/i.test(s))).toEqual([]);
    expect(statements.filter((s) => /business_operations|metric_calculated_values|metric_time_series_values/i.test(s))).toEqual([]);
    expect(await state(f.w)).toEqual(before);
  });
});
