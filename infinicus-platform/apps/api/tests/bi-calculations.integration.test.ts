/**
 * BI-2-DEV-08 - the governed BI-10 calculation API (real PostgreSQL, production buildApp, application role):
 *   POST /v1/businesses/:businessId/bi/metric-calculations           execute (bi:write AND bi:read, subscription, Idempotency-Key; no data in the request)
 *   GET  /v1/businesses/:businessId/bi/metric-calculations/:runId    one stored run (bi:read)
 *   GET  /v1/businesses/:businessId/bi/metric-results                stored results, filtered and paged (bi:read)
 * THE WAREHOUSE ROWS ARE DEVELOPMENT FIXTURES, recorded and sealed through BiWarehouseRowRepository over a dataset made by the real BO -> BI intake -> dataset chain.
 * No BI ingestion pathway delivers production rows yet; the API never accepts rows and fails closed when sealed rows are absent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { BiWarehouseRowRepository, closePool, createPool, getPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceDatasetService, BusinessIntelligenceIntakeService, BusinessIntelligenceMetricRegistryService, MAX_DATASET_ROWS, type MetricDefinitionInput, type WarehouseRow } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';
import { publishBoPackage } from '../../../packages/workflow/tests/helpers/boPublicationFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const SALES: WarehouseRow[] = [
  { amount: '1200.50', cost: '400.20', date: '2026-01-15T09:00:00Z' },
  { amount: '800.25', cost: '350.10', date: '2026-01-20T09:00:00Z' },
  { amount: '300.10', cost: '100.05', date: '2026-02-02T09:00:00Z' },
];
const RUN_KEYS = ['calculationHandoffId', 'calculationRunId', 'correlationId', 'datasets', 'handoffSourceTimestamp', 'metricCount', 'persistedAt', 'resultCount', 'status', 'warehouseSnapshotId'];
const RESULT_KEYS = ['calculationRunId', 'calculationStatus', 'currency', 'datasetVersionId', 'group', 'groupKey', 'metricCode', 'metricContentHash', 'metricId', 'metricResultId', 'metricType', 'metricVersion', 'persistedAt', 'sourceRowCount', 'target', 'threshold', 'unit', 'value', 'warehouseDatasetId'];

describe.runIf(run)('BI-2-DEV-08: governed BI-10 calculation API', () => {
  let app: FastifyInstance; let admin: Pool; const tenantIds: string[] = []; let kit: ReturnType<typeof dalKit>;
  const registry = new BusinessIntelligenceMetricRegistryService();
  const warehouse = new BiWarehouseRowRepository();
  const intake = new BusinessIntelligenceIntakeService();
  const datasets = new BusinessIntelligenceDatasetService();
  let seq = 0;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
  }, 120_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]); await c.query('COMMIT'); }
      catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    }
    await admin?.end(); await closePool();
  });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const tenantWorld = (w: World) => ({ tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId });
  /** A dataset from the real chain (BO package -> BI intake -> dataset) whose rows are recorded and SEALED (development fixture rows). */
  async function sealedDataset(w: World, rows: WarehouseRow[], targetBlock = 'BI-16') {
    const p = await publishBoPackage(admin, tenantWorld(w), { recordCount: rows.length, targetBlock });
    const out = await intake.ingest(w.ctx, p.handoff);
    if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    const d = await datasets.materialize(w.ctx, out.intakePackageId);
    const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    if (rows.length > 0 && rows.length <= 10_000) {
      await warehouse.appendRows(w.ctx, w.businessId, { datasetVersionId: d.datasetVersionId, sourceReferenceId: source.id, rows: rows.map((data, i) => ({ rowNumber: i + 1, data })) });
      await warehouse.sealVersion(w.ctx, w.businessId, d.datasetVersionId);
    }
    return { datasetId: d.datasetId, versionId: d.datasetVersionId, sourceId: source.id as string };
  }
  const metric = (ds: string, over: MetricDefinitionInput): MetricDefinitionInput =>
    ({ name: 'Metric', code: `m_${++seq}`, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
  const reg = async (w: World, i: MetricDefinitionInput, businessId = w.businessId): Promise<string> => {
    const r = await registry.register(w.ctx, businessId, i); expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  };
  /** revenue, cost (base, monthly), margin = revenue - cost, margin_rate = margin / revenue - over a sealed dataset. */
  async function financialWorld(rows: WarehouseRow[] = SALES) {
    const w = await kit.world(); const ds = await sealedDataset(w, rows);
    const revenue = await reg(w, metric(ds.datasetId, { code: 'revenue', target: 1000, thresholds: { warningBelow: 500 } }));
    const cost = await reg(w, metric(ds.datasetId, { code: 'cost', sourceField: 'cost' }));
    const margin = await reg(w, metric(ds.datasetId, { code: 'margin', metricType: 'derived', aggregation: undefined, sourceField: undefined, dependencies: [revenue, cost], formula: { operator: 'subtract' } }));
    const rate = await reg(w, metric(ds.datasetId, { code: 'margin_rate', metricType: 'ratio', aggregation: undefined, sourceField: undefined, dependencies: [margin, revenue], unit: 'ratio' }));
    return { w, ds, revenue, cost, margin, rate };
  }
  const base = (businessId: string) => `/v1/businesses/${businessId}/bi/metric-calculations`;
  const resultsUrl = (businessId: string, query = '') => `/v1/businesses/${businessId}/bi/metric-results${query}`;
  const post = (w: { ctx: TenantContext; token: string }, businessId: string, payload: unknown = {}, key: string = unique('k'), extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: base(businessId), headers: { ...kit.headers(w), 'idempotency-key': key, ...extra }, payload: payload as never });
  const get = (w: { ctx: TenantContext; token: string }, url: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...kit.headers(w), ...extra } });
  const counts = async (businessId: string) => Object.fromEntries(await Promise.all(['metric_calculation_runs', 'metric_calculation_run_inputs', 'metric_results'].map(async (t) =>
    [t, Number((await q(`SELECT count(*) n FROM business_intelligence.${t} WHERE business_id = $1`, [businessId]))[0].n)])));
  const EMPTY = { metric_calculation_runs: 0, metric_calculation_run_inputs: 0, metric_results: 0 };

  /** A user who is an active member of the world's workspace holding exactly the given permissions through a tenant-owned role (none = no role at all). */
  async function memberWith(of: World, permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const regr = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = regr.json().id as string; await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: of.ctx.tenantId, workspaceId: of.ctx.workspaceId, userId };
    const memberships = new MembershipRepository(); const m = await memberships.create(ctx, userId); await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI calculation test role','workspace') RETURNING id`, [of.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }

  describe('execution', () => {
    it('calculates over the sealed warehouse rows, stores the run, and answers 201 with the contract fields and exact results', async () => {
      const f = await financialWorld();
      const res = await post(f.w, f.w.businessId);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual([...RUN_KEYS, 'replayed'].sort());
      expect(body).toMatchObject({ status: 'completed', replayed: false, metricCount: 4, resultCount: 8, warehouseSnapshotId: null });
      expect(body.datasets).toEqual([{ warehouseDatasetId: f.ds.datasetId, datasetVersionId: f.ds.versionId, rowCount: 3, rowsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), sealDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      expect(await counts(f.w.businessId)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
      const stored = await q(`SELECT metric_code, time_bucket, value::text AS value FROM business_intelligence.metric_results WHERE run_id = $1 ORDER BY metric_code, time_bucket`, [body.calculationRunId]);
      const by = (code: string) => stored.filter((r) => r.metric_code === code).map((r) => [r.time_bucket, r.value]);
      expect(by('revenue')).toEqual([['2026-01', '2000.75'], ['2026-02', '300.1']]);
      expect(by('margin')).toEqual([['2026-01', '1250.45'], ['2026-02', '200.05']]);
      expect(by('margin_rate')).toEqual([['2026-01', '0.6249906285'], ['2026-02', '0.6666111296']]);
    });

    it('keeps the source timestamp and the stored time apart and sanitises the response: no tenant, workspace or storage field', async () => {
      const f = await financialWorld();
      const res = await post(f.w, f.w.businessId); const b = res.json();
      expect(Date.parse(b.persistedAt)).toBeGreaterThan(Date.parse(b.handoffSourceTimestamp));
      for (const secret of ['tenantId', 'workspaceId', 'tenant_id', 'workspace_id', 'run_digest', f.w.ctx.tenantId, f.w.ctx.workspaceId, f.w.token]) expect(res.body, secret).not.toContain(secret);
    });

    it('replays: the same Idempotency-Key returns the stored response; a new key for the same calculation is a 200 replay of the same run with the FIRST correlation id', async () => {
      const f = await financialWorld(); const key = unique('same');
      const first = await post(f.w, f.w.businessId, {}, key, { 'x-correlation-id': 'first-request' });
      const sameKey = await post(f.w, f.w.businessId, {}, key, { 'x-correlation-id': 'other' });
      expect(first.statusCode).toBe(201); expect(sameKey.statusCode).toBe(201); expect(sameKey.json()).toEqual(first.json());
      const again = await post(f.w, f.w.businessId, {}, unique('new'), { 'x-correlation-id': 'second-request' });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ replayed: true, calculationRunId: first.json().calculationRunId, persistedAt: first.json().persistedAt, correlationId: 'first-request' });
      expect(await counts(f.w.businessId)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
    });

    it('is safe under concurrent executions: exactly one run is stored and exactly one caller sees 201', async () => {
      const f = await financialWorld();
      const all = await Promise.all(Array.from({ length: 8 }, () => post(f.w, f.w.businessId)));
      expect(all.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(all.map((r) => r.json().calculationRunId)).size).toBe(1);
      expect(await counts(f.w.businessId)).toEqual({ metric_calculation_runs: 1, metric_calculation_run_inputs: 1, metric_results: 8 });
    });

    it('a changed definition is a new run; the earlier run stays stored and retrievable', async () => {
      const f = await financialWorld(); const first = (await post(f.w, f.w.businessId)).json();
      expect((await registry.revise(f.w.ctx, f.w.businessId, f.cost, metric(f.ds.datasetId, { code: 'cost', sourceField: 'cost', description: 'v2' }))).ok).toBe(true);
      const second = await post(f.w, f.w.businessId);
      expect(second.statusCode).toBe(201); expect(second.json().calculationRunId).not.toBe(first.calculationRunId);
      expect((await get(f.w, `${base(f.w.businessId)}/${first.calculationRunId}`)).statusCode).toBe(200);
      expect((await counts(f.w.businessId)).metric_calculation_runs).toBe(2);
    });

    it('accepts a metric selection (upper-case, duplicated ids) and an expected hand-off; a dependency-open selection and an unknown metric are refused', async () => {
      const f = await financialWorld();
      const sel = await post(f.w, f.w.businessId, { metricIds: [f.revenue.toUpperCase(), f.revenue, f.cost] });
      expect(sel.statusCode, sel.body).toBe(201); expect(sel.json()).toMatchObject({ metricCount: 2, resultCount: 4 });
      expect((await post(f.w, f.w.businessId, { metricIds: [f.margin] })).statusCode).toBe(409);
      const unknown = await post(f.w, f.w.businessId, { metricIds: [randomUUID()] });
      expect(unknown.statusCode).toBe(404); expect(unknown.json().error.code).toBe('NotFoundError');
    });

    it('an expected hand-off id that is not the governed one is a 409 and nothing is calculated; the right one executes', async () => {
      const f = await financialWorld();
      const wrong = await post(f.w, f.w.businessId, { calculationHandoffId: randomUUID() });
      expect(wrong.statusCode).toBe(409); expect(wrong.body).toContain('HANDOFF_CHANGED');
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
      const full = (await post(f.w, f.w.businessId)).json();
      const right = await post(f.w, f.w.businessId, { calculationHandoffId: full.calculationHandoffId.toUpperCase() });
      expect(right.statusCode, right.body).toBe(200); expect(right.json().calculationRunId).toBe(full.calculationRunId);
    });

    it('an unapproved metric named explicitly is refused (409) and nothing is stored', async () => {
      const f = await financialWorld(); const draft = await reg(f.w, metric(f.ds.datasetId, { code: 'draftish', governanceStatus: 'draft' }));
      const res = await post(f.w, f.w.businessId, { metricIds: [draft] });
      expect(res.statusCode).toBe(409); expect(res.body).not.toContain(draft);
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
    });
  });

  describe('no data in the request, and the warehouse fails closed', () => {
    it.each([
      ['rows', { rows: [{ amount: '1' }] }], ['records', { records: [{ amount: '1' }] }], ['data', { data: [] }], ['warehouseRows', { warehouseRows: [] }], ['tenantId', { tenantId: randomUUID() }],
      ['an unknown field', { unexpected: true }], ['metricIds not an array', { metricIds: 'x' }], ['empty metricIds', { metricIds: [] }], ['malformed metric id', { metricIds: ['nope'] }],
      ['malformed hand-off id', { calculationHandoffId: '{x}' }], ['a snapshot id', { warehouseSnapshotId: 'snap' }],
    ])('refuses %s (400) and stores nothing', async (_label, payload) => {
      const f = await financialWorld();
      const res = await post(f.w, f.w.businessId, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
    });

    it('a business with no sealed rows cannot be calculated: 409, a fixed message, nothing stored (no fixture rows are used by the route)', async () => {
      const w = await kit.world();
      const p = await publishBoPackage(admin, tenantWorld(w), { recordCount: 2 }); const out = await intake.ingest(w.ctx, p.handoff);
      if (out.outcome !== 'VALIDATED') throw new Error('fixture');
      const d = await datasets.materialize(w.ctx, out.intakePackageId);
      await reg(w, metric(d.datasetId, { code: 'unsealed' }));
      const res = await post(w, w.businessId);
      expect(res.statusCode, res.body).toBe(409); expect(res.body).toContain('DATASET_ROWS_UNAVAILABLE');
      expect(res.body).not.toMatch(/seal|digest|business_intelligence|postgres|row_/i);
      expect(await counts(w.businessId)).toEqual(EMPTY);
    });

    it('rows altered after sealing are never calculated: 409 and nothing stored', async () => {
      const f = await financialWorld(); const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`UPDATE business_intelligence.warehouse_dataset_rows SET row_data = '{"amount":"1","cost":"1","date":"2026-01-01T00:00:00Z"}' WHERE dataset_version_id = $1 AND row_number = 1`, [f.ds.versionId]); await c.query('COMMIT'); } finally { c.release(); }
      const res = await post(f.w, f.w.businessId);
      expect(res.statusCode).toBe(409); expect(res.body).toContain('DATASET_ROWS_UNAVAILABLE');
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
    });

    it('a dataset over the frozen 100000-row limit is refused whole (409), never truncated', async () => {
      expect(MAX_DATASET_ROWS).toBe(100_000);
      const w = await kit.world();
      const p = await publishBoPackage(admin, tenantWorld(w), { recordCount: MAX_DATASET_ROWS + 1 }); const out = await intake.ingest(w.ctx, p.handoff);
      if (out.outcome !== 'VALIDATED') throw new Error('fixture');
      const d = await datasets.materialize(w.ctx, out.intakePackageId);
      const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
      await q(`INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
               SELECT $1,$2,$3,$4,$5, g, '{"amount":"1"}', $6 FROM generate_series(1, $7::int) g`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, d.datasetId, d.datasetVersionId, source.id, MAX_DATASET_ROWS + 1]);
      await warehouse.sealVersion(w.ctx, w.businessId, d.datasetVersionId);
      await reg(w, metric(d.datasetId, { code: 'huge', timeGrain: 'all_time' }));
      const res = await post(w, w.businessId);
      expect(res.statusCode, res.body).toBe(409); expect(res.body).toContain('DATASET_TOO_LARGE');
      expect(await counts(w.businessId)).toEqual(EMPTY);
    }, 180_000);

    it('an empty registry has nothing to execute (409 NO_METRICS_SELECTED)', async () => {
      const w = await kit.world();
      const res = await post(w, w.businessId);
      expect(res.statusCode).toBe(409); expect(res.body).toContain('NO_METRICS_SELECTED');
    });
  });

  describe('authorization: execute is not read', () => {
    it('requires authentication (401), an Idempotency-Key (400) and a business of the caller\'s workspace (404)', async () => {
      const f = await financialWorld();
      expect((await app.inject({ method: 'POST', url: base(f.w.businessId), payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: base(f.w.businessId), headers: { ...kit.headers(f.w) }, payload: {} })).statusCode).toBe(400);
      expect((await post(f.w, randomUUID())).statusCode).toBe(404);
      expect((await post(f.w, 'not-a-uuid')).statusCode).toBe(400);
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
    });

    it('bi:read alone cannot execute (403, nothing stored) yet can read; bi:write alone cannot execute either (the response returns data, so bi:read is also required); both can', async () => {
      const f = await financialWorld();
      const reader = await memberWith(f.w, ['bi:read']); const writer = await memberWith(f.w, ['bi:write']); const both = await memberWith(f.w, ['bi:read', 'bi:write']);
      const other = await memberWith(f.w, ['bo:read', 'bo:write']); const none = await memberWith(f.w, []);
      for (const m of [reader, writer, other, none]) { const res = await post(m, f.w.businessId); expect(res.statusCode, res.body).toBe(403); expect(res.body).not.toContain(f.revenue); }
      expect(await counts(f.w.businessId)).toEqual(EMPTY);
      const ok = await post(both, f.w.businessId); expect(ok.statusCode, ok.body).toBe(201);
      const runId = ok.json().calculationRunId;
      expect((await get(reader, `${base(f.w.businessId)}/${runId}`)).statusCode).toBe(200);
      expect((await get(reader, resultsUrl(f.w.businessId))).statusCode).toBe(200);
      for (const m of [writer, other, none]) { expect((await get(m, `${base(f.w.businessId)}/${runId}`)).statusCode).toBe(403); expect((await get(m, resultsUrl(f.w.businessId))).statusCode).toBe(403); }
    });

    it('a caller without the permission learns nothing about whether the business exists (403 for a real and an unknown business alike)', async () => {
      const f = await financialWorld(); const reader = await memberWith(f.w, ['bi:read']);
      expect([(await post(reader, f.w.businessId)).statusCode, (await post(reader, randomUUID())).statusCode]).toEqual([403, 403]);
    });

    it('a spoofed tenant or workspace header does not widen scope', async () => {
      const a = await financialWorld(); const b = await financialWorld();
      const res = await post(a.w, b.w.businessId, {}, unique('k'), { 'x-tenant-id': b.w.ctx.tenantId, 'x-workspace-id': b.w.ctx.workspaceId });
      expect(res.statusCode).not.toBe(201); expect(await counts(b.w.businessId)).toEqual(EMPTY);
    });
  });

  describe('isolation', () => {
    it('another tenant, an unknown business and a sibling business are indistinguishable 404s for runs and execution; nothing of another party appears', async () => {
      const a = await financialWorld(); const b = await financialWorld();
      const runA = (await post(a.w, a.w.businessId)).json().calculationRunId as string;
      const [sibling] = await q(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.w.ctx.tenantId, a.w.ctx.workspaceId, unique('sib')]);
      const probes = [
        await get(b.w, `${base(a.w.businessId)}/${runA}`), await get(b.w, `${base(b.w.businessId)}/${runA}`), await get(a.w, `${base(sibling.id)}/${runA}`),
        await get(a.w, `${base(a.w.businessId)}/${randomUUID()}`), await post(b.w, a.w.businessId),
      ];
      // a 404 may echo the id the CALLER supplied (their own input); it must carry nothing of the other party
      const otherResultIds = (await q(`SELECT id FROM business_intelligence.metric_results WHERE business_id = $1`, [a.w.businessId])).map((r) => r.id as string);
      for (const res of probes) {
        expect(res.statusCode, res.body).toBe(404);
        for (const leak of [a.w.ctx.tenantId, b.w.ctx.tenantId, a.revenue, a.ds.datasetId, a.ds.versionId, ...otherResultIds]) expect(res.body, leak).not.toContain(leak);
      }
      for (const res of probes) expect(res.json().error.message, res.body).toMatch(/^(Business|CalculationRun) not found: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // one of two fixed shapes
      expect(Object.keys(probes[0]!.json().error).sort()).toEqual(['code', 'correlationId', 'message']);
      expect((await post(a.w, sibling.id)).statusCode).toBe(409); // the sibling has no governed metrics of its own: its registry is empty, not a window into A's
      expect(await counts(sibling.id)).toEqual(EMPTY);
    });

    it('results of another business are never returned, whatever filter names them', async () => {
      const a = await financialWorld(); const b = await financialWorld();
      const runA = (await post(a.w, a.w.businessId)).json().calculationRunId as string; const runB = (await post(b.w, b.w.businessId)).json().calculationRunId as string;
      const bResults = (await get(b.w, resultsUrl(b.w.businessId))).json().results as Array<{ metricResultId: string; metricId: string }>;
      for (const query of [`?calculationRunId=${runB}`, `?metricId=${b.revenue}`, '']) {
        const res = await get(a.w, resultsUrl(a.w.businessId, query));
        expect(res.statusCode).toBe(200);
        for (const r of bResults) expect(res.body).not.toContain(r.metricResultId);
        expect(res.json().results.every((r: { calculationRunId: string }) => r.calculationRunId === runA)).toBe(true);
      }
      expect((await get(a.w, resultsUrl(b.w.businessId))).statusCode).toBe(404);
    });
  });

  describe('run retrieval', () => {
    it('returns the stored run with its identity, both timestamps and dataset provenance - the same facts the execution returned', async () => {
      const f = await financialWorld(); const exec = (await post(f.w, f.w.businessId)).json();
      const res = await get(f.w, `${base(f.w.businessId)}/${exec.calculationRunId.toUpperCase()}`);
      expect(res.statusCode, res.body).toBe(200);
      const { replayed: _r, ...expected } = exec;
      expect(res.json()).toEqual(expected);
      expect(Object.keys(res.json()).sort()).toEqual([...RUN_KEYS].sort());
    });

    it('is read-only: serving runs and results changes no row and issues no write', async () => {
      const f = await financialWorld(); const exec = (await post(f.w, f.w.businessId)).json();
      const before = JSON.stringify([await counts(f.w.businessId), await q(`SELECT md5(string_agg(id::text || value::text, ',' ORDER BY id)) AS h FROM business_intelligence.metric_results WHERE business_id = $1`, [f.w.businessId])]);
      const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
      vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try { await get(f.w, `${base(f.w.businessId)}/${exec.calculationRunId}`); await get(f.w, resultsUrl(f.w.businessId)); await get(f.w, resultsUrl(f.w.businessId, '?metricCode=revenue')); } finally { vi.restoreAllMocks(); }
      expect(statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b[^;]*business_intelligence\./i.test(s))).toEqual([]);
      expect(JSON.stringify([await counts(f.w.businessId), await q(`SELECT md5(string_agg(id::text || value::text, ',' ORDER BY id)) AS h FROM business_intelligence.metric_results WHERE business_id = $1`, [f.w.businessId])])).toBe(before);
    });

    it('a stored run altered behind the application is reported as a generic server error, never returned', async () => {
      const f = await financialWorld(); const exec = (await post(f.w, f.w.businessId)).json();
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`UPDATE business_intelligence.metric_results SET value = value + 1 WHERE run_id = $1 AND metric_code = 'revenue' AND time_bucket = '2026-01'`, [exec.calculationRunId]); await c.query('COMMIT'); } finally { c.release(); }
      const res = await get(f.w, `${base(f.w.businessId)}/${exec.calculationRunId}`);
      expect(res.statusCode).toBe(500); expect(res.json().error).toMatchObject({ code: 'internal_error', message: 'An unexpected error occurred.' });
      expect(res.body).not.toMatch(/STORED_RUN|digest|integrity|metric_results|business_intelligence/i);
    });

    it('rejects a malformed run id (400) and an unknown one (404)', async () => {
      const f = await financialWorld();
      expect((await get(f.w, `${base(f.w.businessId)}/nope`)).statusCode).toBe(400);
      expect((await get(f.w, `${base(f.w.businessId)}/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  describe('metric result querying', () => {
    it('lists the stored results with exact decimal text, definition version, units, groups, time buckets, threshold and target status and lineage', async () => {
      const f = await financialWorld(); const exec = (await post(f.w, f.w.businessId)).json();
      const res = await get(f.w, resultsUrl(f.w.businessId, `?calculationRunId=${exec.calculationRunId}`));
      expect(res.statusCode, res.body).toBe(200);
      const { results, limit, offset } = res.json();
      expect([limit, offset, results.length]).toEqual([20, 0, 8]);
      for (const r of results) expect(Object.keys(r).sort()).toEqual([...RESULT_KEYS].sort());
      const byKey = Object.fromEntries(results.map((r: { metricCode: string; group: { timeBucket: string } }) => [`${r.metricCode}@${r.group.timeBucket}`, r]));
      expect(byKey['revenue@2026-01']).toMatchObject({ metricId: f.revenue, metricVersion: 1, value: '2000.75', unit: 'usd', target: '1000', threshold: { status: 'normal', targetMet: true }, sourceRowCount: 2, calculationStatus: 'completed', datasetVersionId: f.ds.versionId, warehouseDatasetId: f.ds.datasetId });
      expect(byKey['revenue@2026-02']).toMatchObject({ value: '300.1', threshold: { status: 'warning', targetMet: false } });
      expect(byKey['margin@2026-01']).toMatchObject({ value: '1250.45', sourceRowCount: null, datasetVersionId: f.ds.versionId }); // derived: no row count; its dataset was read by the run, so its sealed version is the lineage
      expect(byKey['margin_rate@2026-02']).toMatchObject({ value: '0.6666111296', unit: 'ratio' });
      for (const secret of ['tenantId', 'workspaceId', 'tenant_id', f.w.ctx.tenantId]) expect(res.body, secret).not.toContain(secret);
    });

    it('orders deterministically and pages without gaps or overlaps; the bounds are exact', async () => {
      const f = await financialWorld(); await post(f.w, f.w.businessId);
      expect((await registry.revise(f.w.ctx, f.w.businessId, f.cost, metric(f.ds.datasetId, { code: 'cost', sourceField: 'cost', description: 'v2' }))).ok).toBe(true);
      await post(f.w, f.w.businessId); // a second run: newest first
      const all = (await get(f.w, resultsUrl(f.w.businessId, '?limit=100'))).json().results as Array<{ metricResultId: string; calculationRunId: string }>;
      expect(all).toHaveLength(16);
      expect(new Set(all.map((r) => r.calculationRunId)).size).toBe(2);
      expect(all.slice(0, 8).every((r) => r.calculationRunId === all[0]!.calculationRunId)).toBe(true);
      const again = (await get(f.w, resultsUrl(f.w.businessId, '?limit=100'))).json().results;
      expect(again).toEqual(all);
      const paged: string[] = [];
      for (let offset = 0; offset < 16; offset += 5) paged.push(...(await get(f.w, resultsUrl(f.w.businessId, `?limit=5&offset=${offset}`))).json().results.map((r: { metricResultId: string }) => r.metricResultId));
      expect(paged).toEqual(all.map((r) => r.metricResultId));
      expect((await get(f.w, resultsUrl(f.w.businessId, '?limit=5&offset=16'))).json().results).toEqual([]);
      expect((await get(f.w, resultsUrl(f.w.businessId, '?limit=100&offset=100000'))).statusCode).toBe(200);
      for (const bad of ['limit=0', 'limit=101', 'limit=-1', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=100001', 'offset=x']) expect((await get(f.w, resultsUrl(f.w.businessId, `?${bad}`))).statusCode, bad).toBe(400);
    });

    it('filters by run, metric, code, statuses and time bucket - and refuses any other or malformed filter', async () => {
      const f = await financialWorld(); const exec = (await post(f.w, f.w.businessId)).json();
      const list = async (query: string) => (await get(f.w, resultsUrl(f.w.businessId, query))).json().results as Array<{ metricCode: string; group: { timeBucket: string | null }; threshold: { status: string } }>;
      expect((await list(`?metricCode=revenue`)).map((r) => r.group.timeBucket)).toEqual(['2026-01', '2026-02']);
      expect((await list(`?metricId=${f.margin}`)).map((r) => r.metricCode)).toEqual(['margin', 'margin']);
      expect((await list(`?timeBucket=2026-02&calculationRunId=${exec.calculationRunId}`)).map((r) => r.metricCode)).toEqual(['cost', 'margin', 'margin_rate', 'revenue']);
      expect((await list(`?thresholdStatus=warning`)).map((r) => [r.metricCode, r.group.timeBucket])).toEqual([['revenue', '2026-02']]);
      expect((await list(`?calculationStatus=no_data`))).toEqual([]);
      expect((await list(`?metricCode=nothing_like_this`))).toEqual([]);
      expect((await list(`?calculationRunId=${randomUUID()}`))).toEqual([]);
      for (const bad of ['tenantId=x', 'businessId=x', 'sort=value', 'value=1', 'calculationRunId=nope', 'metricId=x', 'metricCode=Bad%20Code', 'metricCode=a%27%3B--', 'thresholdStatus=great', 'calculationStatus=done', 'timeBucket=2026-13-45x', 'timeBucket=']) {
        expect((await get(f.w, resultsUrl(f.w.businessId, `?${bad}`))).statusCode, bad).toBe(400);
      }
    });

    it('a run that read no dataset (target metrics only) has no dataset version in its lineage and no input', async () => {
      const w = await kit.world(); const ds = await sealedDataset(w, SALES);
      await reg(w, metric(ds.datasetId, { code: 'goal', metricType: 'target', aggregation: undefined, sourceField: undefined, target: 125.5, timeGrain: 'all_time' }));
      const exec = await post(w, w.businessId);
      expect(exec.statusCode, exec.body).toBe(201); expect(exec.json().datasets).toEqual([]);
      const r = (await get(w, resultsUrl(w.businessId))).json().results;
      expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ metricCode: 'goal', value: '125.5', datasetVersionId: null, sourceRowCount: null });
      expect((await counts(w.businessId)).metric_calculation_run_inputs).toBe(0);
    });

    it('stores and serves results with nothing to calculate as null values with status no_data', async () => {
      const w = await kit.world(); const ds = await sealedDataset(w, [{ other: 1, date: '2026-01-02T00:00:00Z' }]);
      await reg(w, metric(ds.datasetId, { code: 'ghost', aggregation: 'average', sourceField: 'missing', timeGrain: 'all_time' }));
      expect((await post(w, w.businessId)).statusCode).toBe(201);
      const r = (await get(w, resultsUrl(w.businessId))).json().results[0];
      expect(r).toMatchObject({ value: null, calculationStatus: 'no_data', threshold: { status: 'no_data', targetMet: false } });
      expect((await get(w, resultsUrl(w.businessId, '?calculationStatus=no_data'))).json().results).toHaveLength(1);
    });
  });

  describe('errors are sanitised', () => {
    it('an unexpected failure is a 500 with a generic body that carries none of the underlying detail', async () => {
      const failing = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), {
        biCalculations: {
          calculation: { calculateAndPersist: async () => { throw new Error('connect ECONNREFUSED postgresql://svc_user:Sup3rSecret@10.1.2.3:5432/prod'); } } as never,
          results: { list: async () => { throw new Error('relation "business_intelligence.metric_results" does not exist'); } } as never,
        },
      });
      await failing.ready();
      try {
        const f = await financialWorld();
        const exec = await failing.inject({ method: 'POST', url: base(f.w.businessId), headers: { ...kit.headers(f.w), 'idempotency-key': unique('k') }, payload: {} });
        const list = await failing.inject({ method: 'GET', url: resultsUrl(f.w.businessId), headers: kit.headers(f.w) });
        for (const res of [exec, list]) {
          expect(res.statusCode).toBe(500);
          expect(res.json().error).toMatchObject({ code: 'internal_error', message: 'An unexpected error occurred.' });
          expect(res.body).not.toMatch(/Sup3rSecret|ECONNREFUSED|postgresql|10\.1\.2\.3|svc_user|metric_results|does not exist/);
        }
      } finally { await failing.close(); }
    });

    it('execution refusals draw their text from a closed vocabulary: no id, SQL or tenant detail', async () => {
      const f = await financialWorld(); const draft = await reg(f.w, metric(f.ds.datasetId, { code: 'draftish', governanceStatus: 'draft' }));
      for (const res of [await post(f.w, f.w.businessId, { metricIds: [draft] }), await post(f.w, f.w.businessId, { calculationHandoffId: randomUUID() }), await post(f.w, f.w.businessId, { metricIds: [f.margin] })]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().error.message).toMatch(/^CalculationRun conflict: cannot be executed \([A-Z_]+\)$/);
        for (const leak of [f.w.ctx.tenantId, f.revenue, f.margin, draft, 'select', 'insert']) expect(res.body.toLowerCase(), leak).not.toContain(leak.toLowerCase());
      }
    });
  });
});
