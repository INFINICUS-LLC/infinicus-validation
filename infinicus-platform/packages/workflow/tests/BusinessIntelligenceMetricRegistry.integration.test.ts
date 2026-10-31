/**
 * BI-2-DEV-02: the BI-09 metric registry persisted in PostgreSQL, under the application role (RLS enforced). Proves: a registered metric is stored as a header plus a
 * governed version 1 (canonical snapshot, hash, dataset, generated governance status), a revision is the next append-only version, every registry rule failure writes
 * nothing, tenant / workspace / business isolation and RLS hold, the database itself refuses scope and chain violations, concurrent writers are serialized, ungoverned
 * (Stage 2D) definitions are untouched and keep their codes, and the stored vocabularies match the live CHECK constraints. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, withTenantTransaction, MetricDefinitionRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceMetricRegistryService, PERSISTABLE_STATUSES, PERSISTABLE_TIME_GRAINS } from '../src/BusinessIntelligenceMetricRegistryService.js';
import { METRIC_AGGREGATIONS, METRIC_TYPES, metricContentHash, type MetricDefinitionContent, type MetricDefinitionInput } from '../src/index.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() });

describe.runIf(run)('BusinessIntelligenceMetricRegistryService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const svc = new BusinessIntelligenceMetricRegistryService();
  let seq = 0;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  async function dataset(w: World, domain = 'financial'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,$6,'ds','active')`,
      [id, w.tenantId, w.workspaceId, w.businessId, `ds-${++seq}-${Date.now()}`, domain]);
    return id;
  }
  const base = (ds: string, over: MetricDefinitionInput = {}): MetricDefinitionInput =>
    ({ name: 'Revenue', code: `Revenue ${++seq}`, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', ...over });
  const counts = async (w: World) => ({
    defs: Number((await q(`SELECT count(*) n FROM business_intelligence.metric_definitions WHERE business_id = $1`, [w.businessId]))[0].n),
    vers: Number((await q(`SELECT count(*) n FROM business_intelligence.metric_definition_versions WHERE business_id = $1`, [w.businessId]))[0].n),
  });
  const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };

  it('stores a registered metric as a header and a governed version 1; the header takes its domain from the dataset', async () => {
    const w = await createWorld(admin, 'Reg1'); const ds = await dataset(w, 'sales_revenue');
    const r = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'Net Sales', description: 'd', currency: 'USD', target: 5, thresholds: { low: 1 }, owner: 'cfo', dimensions: ['region'], filters: [{ f: 1 }] })));
    expect(r.metric).toMatchObject({ metricId: expect.any(String), code: 'net_sales', version: 1, scope: { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId } });
    expect(r.lineage).toMatchObject({ metricCode: 'net_sales', warehouseDatasetId: ds, datasetContractId: null, version: 1 });
    const [def] = await q(`SELECT * FROM business_intelligence.metric_definitions WHERE id = $1`, [r.metric.metricId]);
    expect(def).toMatchObject({ metric_code: 'net_sales', domain: 'sales_revenue', metric_type: 'base', name: 'Revenue', unit: 'usd', currency_code: 'USD', status: 'active', latest_version: 1, business_id: w.businessId });
    const [v] = await q(`SELECT * FROM business_intelligence.metric_definition_versions WHERE metric_definition_id = $1`, [r.metric.metricId]);
    expect(v).toMatchObject({ version_number: 1, aggregation_method: 'sum', time_grain: 'month', warehouse_dataset_id: ds, governance_status: 'draft', dimensional_filters: [{ f: 1 }] });
    expect(v.definition_content).toMatchObject({ code: 'net_sales', owner: 'cfo', target: 5, thresholds: { low: 1 }, dimensions: ['region'] });
    const { metricId: _a, scope: _b, createdAt: _c, updatedAt: _d, ...content } = r.metric;
    expect(v.content_hash).toBe(metricContentHash(content as MetricDefinitionContent));
    expect(v.calculation_specification).toMatchObject({ sourceField: 'amount', dependencies: [], dimensions: ['region'], target: 5 });
  });

  it('stores count_distinct as the table\'s distinct_count and a derived metric with no aggregation as NULL', async () => {
    const w = await createWorld(admin, 'Reg2'); const ds = await dataset(w);
    const a = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { aggregation: 'count_distinct' })));
    const b = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { metricType: 'derived', aggregation: undefined, dependencies: [a.metric.metricId], timeGrain: 'all_time' })));
    const rows = await q(`SELECT metric_definition_id, aggregation_method, time_grain FROM business_intelligence.metric_definition_versions WHERE business_id = $1`, [w.businessId]);
    expect(rows.find((r) => r.metric_definition_id === a.metric.metricId)).toMatchObject({ aggregation_method: 'distinct_count' });
    expect(rows.find((r) => r.metric_definition_id === b.metric.metricId)).toMatchObject({ aggregation_method: null, time_grain: 'all_time' });
  });

  it('a revision is the next append-only version; the header follows it; the registry reads back exactly what was committed', async () => {
    const w = await createWorld(admin, 'Reg3'); const ds = await dataset(w);
    const v1 = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'margin' })));
    const v2 = ok(await svc.revise(ctxOf(w), w.businessId, v1.metric.metricId, base(ds, { code: 'margin', unit: 'eur', governanceStatus: 'approved' })));
    expect(v2.metric).toMatchObject({ version: 2, unit: 'eur', createdAt: v1.metric.createdAt });
    const [def] = await q(`SELECT latest_version, unit FROM business_intelligence.metric_definitions WHERE id = $1`, [v1.metric.metricId]);
    expect(def).toMatchObject({ latest_version: 2, unit: 'eur' });
    const vers = await q(`SELECT version_number, governance_status, definition_content->>'unit' AS unit FROM business_intelligence.metric_definition_versions WHERE metric_definition_id = $1 ORDER BY version_number`, [v1.metric.metricId]);
    expect(vers).toEqual([{ version_number: 1, governance_status: 'draft', unit: 'usd' }, { version_number: 2, governance_status: 'approved', unit: 'eur' }]);
    const listed = await svc.list(ctxOf(w), w.businessId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ metricId: v1.metric.metricId, version: 2, unit: 'eur', governanceStatus: 'approved' });
    await expect(admin.query(`UPDATE business_intelligence.metric_definition_versions SET time_grain = 'day' WHERE metric_definition_id = $1`, [v1.metric.metricId])).rejects.toThrow(/append-only/);
    await expect(admin.query(`DELETE FROM business_intelligence.metric_definition_versions WHERE metric_definition_id = $1`, [v1.metric.metricId])).rejects.toThrow(/append-only/);
  });

  it('every registry rule failure writes nothing', async () => {
    const w = await createWorld(admin, 'Reg4'); const other = await addBusiness(admin, w); const ds = await dataset(w); const foreignDs = await dataset(other);
    const a = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'a' })));
    const b = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'b', metricType: 'derived', aggregation: undefined, dependencies: [a.metric.metricId] })));
    const before = await counts(w);
    const cases: Array<[string, Promise<{ ok: boolean; code?: string }>]> = [
      ['duplicate code', svc.register(ctxOf(w), w.businessId, base(ds, { code: 'A' }))],
      ['unknown dependency', svc.register(ctxOf(w), w.businessId, base(ds, { code: 'c', metricType: 'derived', aggregation: undefined, dependencies: [randomUUID()] }))],
      ['circular revision', svc.revise(ctxOf(w), w.businessId, a.metric.metricId, base(ds, { code: 'a', metricType: 'derived', aggregation: undefined, dependencies: [b.metric.metricId] }))],
      ['dataset of a sibling business', svc.register(ctxOf(w), w.businessId, base(foreignDs, { code: 'd' }))],
      ['dataset that does not exist', svc.register(ctxOf(w), w.businessId, base(randomUUID(), { code: 'e' }))],
      ['dataset id that is not a uuid', svc.register(ctxOf(w), w.businessId, base('not-a-uuid', { code: 'f' }))],
      ['invalid definition', svc.register(ctxOf(w), w.businessId, { name: 'x' })],
      ['unsupported time grain', svc.register(ctxOf(w), w.businessId, base(ds, { code: 'g', timeGrain: 'fortnight' }))],
      ['unsupported status', svc.register(ctxOf(w), w.businessId, base(ds, { code: 'h', status: 'draft' }))],
      ['a revision that changes nothing', svc.revise(ctxOf(w), w.businessId, a.metric.metricId, base(ds, { code: 'a' }))],
      ['a revision of an unknown metric', svc.revise(ctxOf(w), w.businessId, randomUUID(), base(ds, { code: 'z' }))],
    ];
    const expected = ['METRIC_CODE_DUPLICATE', 'METRIC_DEPENDENCY_INVALID', 'METRIC_DEPENDENCY_INVALID', 'DATASET_NOT_FOUND', 'DATASET_NOT_FOUND', 'DATASET_NOT_FOUND', 'METRIC_DEFINITION_INVALID', 'METRIC_NOT_PERSISTABLE', 'METRIC_NOT_PERSISTABLE', 'METRIC_VERSION_INVALID', 'METRIC_NOT_FOUND'];
    const results = await Promise.all(cases.map(([, p]) => p));
    results.forEach((r, i) => expect({ case: cases[i]![0], ok: r.ok, code: r.code }).toEqual({ case: cases[i]![0], ok: false, code: expected[i] }));
    expect(await counts(w)).toEqual(before);
  });

  it('isolates tenants, workspaces and businesses: a foreign business is a plain not-found, registries do not mix, dependencies cannot cross', async () => {
    const w = await createWorld(admin, 'Reg5'); const sibling = await addBusiness(admin, w); const foreign = await createWorld(admin, 'Reg5x');
    const ds = await dataset(w); const sibDs = await dataset(sibling);
    const a = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'shared' })));
    await expect(svc.register(ctxOf(foreign), w.businessId, base(ds))).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(svc.list(ctxOf(foreign), w.businessId)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(svc.register(ctxOf(w), randomUUID(), base(ds))).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(svc.register(ctxOf(w), 'not-a-uuid', base(ds))).rejects.toMatchObject({ name: 'NotFoundError' });
    ok(await svc.register(ctxOf(w), sibling.businessId, base(sibDs, { code: 'shared' })));
    expect(await svc.list(ctxOf(w), w.businessId)).toHaveLength(1);
    expect(await svc.list(ctxOf(w), sibling.businessId)).toHaveLength(1);
    const cross = await svc.register(ctxOf(w), sibling.businessId, base(sibDs, { code: 'dep', metricType: 'derived', aggregation: undefined, dependencies: [a.metric.metricId] }));
    expect(cross).toMatchObject({ ok: false, code: 'METRIC_DEPENDENCY_INVALID' });
    const seen = await withTenantTransaction(ctxOf(foreign), async (c) => (await c.query('SELECT count(*) n FROM business_intelligence.metric_definition_versions')).rows[0].n);
    expect(Number(seen)).toBe(0);
  });

  it('serializes concurrent writers: four registrations of one code give exactly one metric; four identical revisions give exactly one new version', async () => {
    const w = await createWorld(admin, 'Reg6'); const ds = await dataset(w);
    const regs = await Promise.all([1, 2, 3, 4].map(() => svc.register(ctxOf(w), w.businessId, base(ds, { code: 'race' }))));
    expect(regs.filter((r) => r.ok)).toHaveLength(1);
    expect(regs.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['METRIC_CODE_DUPLICATE', 'METRIC_CODE_DUPLICATE', 'METRIC_CODE_DUPLICATE']);
    expect((await counts(w)).defs).toBe(1);
    const id = (regs.find((r) => r.ok) as { metric: { metricId: string } }).metric.metricId;
    const revs = await Promise.all([1, 2, 3, 4].map(() => svc.revise(ctxOf(w), w.businessId, id, base(ds, { code: 'race', unit: 'eur' }))));
    expect(revs.filter((r) => r.ok)).toHaveLength(1);
    expect((await q(`SELECT latest_version FROM business_intelligence.metric_definitions WHERE id = $1`, [id]))[0].latest_version).toBe(2);
  });

  it('keeps Stage 2D (ungoverned) definitions working: they own their code, cannot be revised through the registry, and cannot be given an ungoverned version once governed', async () => {
    const w = await createWorld(admin, 'Reg7'); const ds = await dataset(w);
    const legacy = new MetricDefinitionRepository();
    const created = await legacy.create(ctxOf(w), { businessId: w.businessId, metricCode: 'legacy_kpi', domain: 'financial', metricType: 'base', name: 'L', unit: 'usd', aggregationMethod: 'sum', timeGrain: 'month' });
    expect(await legacy.findLatestVersion(ctxOf(w), created.definition.id)).toMatchObject({ versionNumber: 1, aggregationMethod: 'sum' });
    expect(await svc.list(ctxOf(w), w.businessId)).toEqual([]);
    expect(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'Legacy KPI' }))).toMatchObject({ ok: false, code: 'METRIC_CODE_DUPLICATE' });
    expect(await svc.revise(ctxOf(w), w.businessId, created.definition.id, base(ds, { code: 'legacy_kpi' }))).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    const governed = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'governed' })));
    await expect(legacy.createVersion(ctxOf(w), governed.metric.metricId, { aggregationMethod: 'sum', timeGrain: 'month' })).rejects.toThrow(/ungoverned version/);
    expect((await q(`SELECT latest_version FROM business_intelligence.metric_definitions WHERE id = $1`, [governed.metric.metricId]))[0].latest_version).toBe(1);
  });

  describe('the database refuses what the service would not write (direct writes as the admin)', () => {
    const insertVersion = (w: World, metricId: string, o: { n: number; ds: string | null; content?: unknown; hash?: string | null; tenant?: string; business?: string }) =>
      admin.query(
        `INSERT INTO business_intelligence.metric_definition_versions (metric_definition_id, tenant_id, workspace_id, business_id, version_number, aggregation_method, time_grain, warehouse_dataset_id, definition_content, content_hash)
         VALUES ($1,$2,$3,$4,$5,'sum','month',$6,$7::jsonb,$8)`,
        [metricId, o.tenant ?? w.tenantId, w.workspaceId, o.business ?? w.businessId, o.n, o.ds, o.content === undefined ? null : JSON.stringify(o.content), o.hash === undefined ? null : o.hash]);
    const snap = (ds: string, version: number, extra: Record<string, unknown> = {}) => ({ governanceStatus: 'draft', warehouseDatasetId: ds, version, ...extra });
    const HASH = 'a'.repeat(64);

    it('refuses a version in another scope, on another business\'s dataset, off the version chain, or with an incomplete or inconsistent snapshot', async () => {
      const w = await createWorld(admin, 'Reg8'); const sib = await addBusiness(admin, w); const ds = await dataset(w); const sibDs = await dataset(sib);
      const m = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'guarded' }))).metric.metricId;
      const bad: Array<[string, () => Promise<unknown>, RegExp]> = [
        ['business differs from the definition', () => insertVersion(w, m, { n: 2, ds, content: snap(ds, 2), hash: HASH, business: sib.businessId }), /scope does not match/],
        ['dataset of a sibling business', () => insertVersion(w, m, { n: 2, ds: sibDs, content: snap(sibDs, 2), hash: HASH }), /dataset is not in the definition scope/],
        ['skips a version', () => insertVersion(w, m, { n: 3, ds, content: snap(ds, 3), hash: HASH }), /must be 2, not 3/],
        ['repeats a version', () => insertVersion(w, m, { n: 1, ds, content: snap(ds, 1), hash: HASH }), /must be 2, not 1|duplicate key/],
        ['snapshot without a hash', () => insertVersion(w, m, { n: 2, ds, content: snap(ds, 2), hash: null }), /snapshot_complete/],
        ['snapshot without a dataset', () => insertVersion(w, m, { n: 2, ds: null, content: snap(ds, 2), hash: HASH }), /snapshot_complete|dataset is not in the definition scope/],
        ['snapshot naming another dataset', () => insertVersion(w, m, { n: 2, ds, content: snap(sibDs, 2), hash: HASH }), /snapshot_complete/],
        ['snapshot naming another version', () => insertVersion(w, m, { n: 2, ds, content: snap(ds, 5), hash: HASH }), /snapshot_complete/],
        ['snapshot with an empty governance status', () => insertVersion(w, m, { n: 2, ds, content: snap(ds, 2, { governanceStatus: '' }), hash: HASH }), /snapshot_complete/],
        ['malformed hash', () => insertVersion(w, m, { n: 2, ds, content: snap(ds, 2), hash: 'XYZ' }), /content_hash_check/],
        ['a snapshot that is not an object', () => insertVersion(w, m, { n: 2, ds, content: [1], hash: HASH }), /definition_content_check/],
      ];
      for (const [name, p, re] of bad) await expect(p(), name).rejects.toThrow(re);
      expect((await counts(w)).vers).toBe(1);
    });

    it('never lets a definition change its code or scope, or lower its latest version', async () => {
      const w = await createWorld(admin, 'Reg9'); const ds = await dataset(w);
      const m = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'fixed' }))).metric.metricId;
      await expect(admin.query(`UPDATE business_intelligence.metric_definitions SET metric_code = 'other' WHERE id = $1`, [m])).rejects.toThrow(/identity/);
      await expect(admin.query(`UPDATE business_intelligence.metric_definitions SET business_id = $2 WHERE id = $1`, [m, (await addBusiness(admin, w)).businessId])).rejects.toThrow(/identity/);
      await expect(admin.query(`UPDATE business_intelligence.metric_definitions SET latest_version = 0 WHERE id = $1`, [m])).rejects.toThrow(/backwards/);
      await expect(admin.query(`UPDATE business_intelligence.metric_definitions SET name = 'renamed', status = 'deprecated' WHERE id = $1`, [m])).resolves.toBeTruthy();
    });

    it('the application role can neither rewrite nor remove a version, and sees only its own scope', async () => {
      const w = await createWorld(admin, 'Reg10'); const ds = await dataset(w);
      const m = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'rls' }))).metric.metricId;
      await expect(withTenantTransaction(ctxOf(w), (c) => c.query(`UPDATE business_intelligence.metric_definition_versions SET time_grain = 'day' WHERE metric_definition_id = $1`, [m]))).rejects.toThrow(/append-only/);
      await expect(withTenantTransaction(ctxOf(w), (c) => c.query(`DELETE FROM business_intelligence.metric_definition_versions WHERE metric_definition_id = $1`, [m]))).rejects.toThrow(/append-only/);
      const other = await createWorld(admin, 'Reg10x');
      const rows = await withTenantTransaction(ctxOf(other), async (c) => (await c.query(`SELECT count(*) n FROM business_intelligence.metric_definitions WHERE id = $1`, [m])).rows[0].n);
      expect(Number(rows)).toBe(0);
      await expect(withTenantTransaction(ctxOf(other), (c) => c.query(
        `INSERT INTO business_intelligence.metric_definitions (tenant_id, workspace_id, business_id, metric_code, domain, metric_type, name, unit) VALUES ($1,$2,$3,'x','financial','base','n','u')`,
        [w.tenantId, w.workspaceId, w.businessId]))).rejects.toThrow();
    });
  });

  it('builds the BI-10 calculation hand-off from the stored registry: approved active metrics only, dependency-closed, ordered by code', async () => {
    const w = await createWorld(admin, 'Reg11'); const ds = await dataset(w);
    const rev = ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'revenue', governanceStatus: 'approved' })));
    ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'draftish' })));
    ok(await svc.register(ctxOf(w), w.businessId, base(ds, { code: 'margin', metricType: 'derived', aggregation: undefined, dependencies: [rev.metric.metricId], governanceStatus: 'approved' })));
    const req = { warehouseSnapshotId: 'snap-1', correlationId: randomUUID() };
    const h = await svc.calculationHandoff(ctxOf(w), w.businessId, req);
    expect(h.ok && h.handoff.metrics.map((m) => m.code)).toEqual(['margin', 'revenue']);
    expect(h.ok && h.handoff).toMatchObject({ targetBlock: 'BI-10', status: 'ready', warehouseSnapshotId: 'snap-1', scope: { businessId: w.businessId } });
    const dep = (await q(`SELECT id FROM business_intelligence.metric_definitions WHERE business_id = $1 AND metric_code = 'draftish'`, [w.businessId]))[0].id;
    expect(await svc.calculationHandoff(ctxOf(w), w.businessId, { ...req, metricIds: [dep] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
    expect(await svc.calculationHandoff(ctxOf(w), w.businessId, { ...req, metricIds: [rev.metric.metricId] })).toMatchObject({ ok: true });
    const empty = await createWorld(admin, 'Reg11e');
    expect(await svc.calculationHandoff(ctxOf(empty), empty.businessId, req)).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
    await expect(svc.calculationHandoff(ctxOf(empty), w.businessId, req)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('live-schema parity: what the service accepts to persist is exactly what the table CHECK constraints accept', async () => {
    const def = async (table: string, name: string) => (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [name, `business_intelligence.${table}`]))[0].d as string;
    const values = (d: string) => [...d.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(values(await def('metric_definition_versions', 'metric_definition_versions_time_grain_check'))).toEqual([...PERSISTABLE_TIME_GRAINS].sort());
    expect(values(await def('metric_definitions', 'metric_definitions_status_check'))).toEqual([...PERSISTABLE_STATUSES].sort());
    expect(values(await def('metric_definitions', 'metric_definitions_metric_type_check'))).toEqual([...METRIC_TYPES].sort());
    const stored = new Set(values(await def('metric_definition_versions', 'metric_definition_versions_aggregation_method_check')));
    expect([...METRIC_AGGREGATIONS].map((a) => (a === 'count_distinct' ? 'distinct_count' : a)).sort()).toEqual([...stored].sort());
  });
});
