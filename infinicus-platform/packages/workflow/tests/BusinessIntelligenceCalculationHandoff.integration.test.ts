/**
 * BI-2-DEV-04: the BI-09 -> BI-10 calculation hand-off read from PostgreSQL under the application role (RLS enforced). Proves: the hand-off is built from the
 * stored governed registry only (approved + active, latest version), its identity is derived and replays identically (also under concurrency), createdAt is the
 * stored version time, a revision changes the identity, the business scope and RLS isolate it, a large registry is handed over whole (no silent truncation at the
 * read API's page size), and reading it writes nothing. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, getPool, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceCalculationHandoffService } from '../src/BusinessIntelligenceCalculationHandoffService.js';
import { BusinessIntelligenceMetricRegistryService } from '../src/BusinessIntelligenceMetricRegistryService.js';
import type { MetricDefinitionInput } from '../src/index.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() });

describe.runIf(run)('BI-2-DEV-04 calculation hand-off service (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const writer = new BusinessIntelligenceMetricRegistryService();
  const svc = new BusinessIntelligenceCalculationHandoffService();
  let seq = 0;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  async function dataset(w: World, domain = 'financial'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,$6,'ds','active')`,
      [id, w.tenantId, w.workspaceId, w.businessId, `ds-${++seq}-${Date.now()}`, domain]);
    return id;
  }
  const base = (ds: string, over: MetricDefinitionInput = {}): MetricDefinitionInput =>
    ({ name: 'Metric', code: `m_${++seq}`, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
  const reg = async (w: World, input: MetricDefinitionInput): Promise<string> => {
    const r = await writer.register(ctxOf(w), w.businessId, input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  };
  const handoff = async (w: World, over: { metricIds?: string[]; correlationId?: string; businessId?: string; ctx?: TenantContext } = {}) =>
    svc.calculationHandoff(over.ctx ?? ctxOf(w), over.businessId ?? w.businessId, { correlationId: over.correlationId ?? 'corr-1', ...(over.metricIds ? { metricIds: over.metricIds } : {}) });
  const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };
  const tableState = async (w: World) => (await q(
    `SELECT (SELECT count(*) FROM business_intelligence.metric_definitions WHERE business_id = $1) AS defs,
            (SELECT count(*) FROM business_intelligence.metric_definition_versions WHERE business_id = $1) AS vers,
            (SELECT md5(coalesce(string_agg(id::text || content_hash || created_at::text, ',' ORDER BY id), '')) FROM business_intelligence.metric_definition_versions WHERE business_id = $1) AS fingerprint,
            (SELECT count(*) FROM audit.audit_events WHERE tenant_id = $2) AS audits`, [w.businessId, w.tenantId]))[0];

  it('hands over the approved, active metrics at their latest version, dependency-closed and ordered by code; the snapshot id is null (D-A)', async () => {
    const w = await createWorld(admin, 'H1'); const ds = await dataset(w);
    const rev = await reg(w, base(ds, { code: 'revenue', unit: 'usd' }));
    await reg(w, base(ds, { code: 'draftish', governanceStatus: 'draft' }));
    await reg(w, base(ds, { code: 'old', status: 'deprecated' }));
    const rev2 = await writer.revise(ctxOf(w), w.businessId, rev, base(ds, { code: 'revenue', unit: 'eur' })); expect(rev2.ok).toBe(true);
    await reg(w, base(ds, { code: 'margin', metricType: 'derived', aggregation: undefined, dependencies: [rev], timeGrain: 'all_time' }));
    const h = ok(await handoff(w)).handoff;
    expect(h.metrics.map((m) => m.code)).toEqual(['margin', 'revenue']);
    expect(h.metricVersions).toEqual(expect.arrayContaining([{ metricId: rev, version: 2 }]));
    expect(h.metrics.find((m) => m.code === 'revenue')).toMatchObject({ unit: 'eur', version: 2 });
    expect(h).toMatchObject({ targetBlock: 'BI-10', status: 'ready', warehouseSnapshotId: null, correlationId: 'corr-1', scope: { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId } });
    expect(h.calculationHandoffId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('createdAt (D-C) is the stored creation time of the newest handed-over version, in UTC, and is stable across replays', async () => {
    const w = await createWorld(admin, 'H2'); const ds = await dataset(w);
    await reg(w, base(ds, { code: 'a' })); await reg(w, base(ds, { code: 'b' }));
    const newest = (await q(`SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM business_intelligence.metric_definition_versions WHERE business_id = $1`, [w.businessId]))[0].t;
    const first = ok(await handoff(w)).handoff;
    expect(first.createdAt).toBe(newest);
    await new Promise((r) => setTimeout(r, 25));
    expect(ok(await handoff(w)).handoff.createdAt).toBe(first.createdAt);
  });

  it('replays identically: same identity, same content; a different request correlation id changes only the correlation id (D-B, D-D)', async () => {
    const w = await createWorld(admin, 'H3'); const ds = await dataset(w);
    await reg(w, base(ds, { code: 'a' })); await reg(w, base(ds, { code: 'b' }));
    const one = ok(await handoff(w, { correlationId: 'req-1' })).handoff; const two = ok(await handoff(w, { correlationId: 'req-2' })).handoff;
    expect(two.calculationHandoffId).toBe(one.calculationHandoffId);
    expect({ ...two, correlationId: '' }).toEqual({ ...one, correlationId: '' });
    expect([one.correlationId, two.correlationId]).toEqual(['req-1', 'req-2']);
  });

  it('is identical under concurrent callers', async () => {
    const w = await createWorld(admin, 'H4'); const ds = await dataset(w);
    for (const c of ['a', 'b', 'c']) await reg(w, base(ds, { code: c }));
    const all = await Promise.all(Array.from({ length: 16 }, () => handoff(w)));
    const bodies = new Set(all.map((r) => JSON.stringify(ok(r).handoff)));
    expect(bodies.size).toBe(1);
  });

  it('a revision, a new approval or a new metric changes the identity; a draft revision of an unrelated metric does not', async () => {
    const w = await createWorld(admin, 'H5'); const ds = await dataset(w);
    const a = await reg(w, base(ds, { code: 'a' })); const b = await reg(w, base(ds, { code: 'b' }));
    const d0 = await reg(w, base(ds, { code: 'd', governanceStatus: 'draft' }));
    const id0 = ok(await handoff(w)).handoff.calculationHandoffId;
    expect((await writer.revise(ctxOf(w), w.businessId, d0, base(ds, { code: 'd', governanceStatus: 'draft', unit: 'eur' }))).ok).toBe(true);
    expect(ok(await handoff(w)).handoff.calculationHandoffId).toBe(id0);
    expect((await writer.revise(ctxOf(w), w.businessId, a, base(ds, { code: 'a', unit: 'eur' }))).ok).toBe(true);
    const id1 = ok(await handoff(w)).handoff.calculationHandoffId;
    expect(id1).not.toBe(id0);
    expect((await writer.revise(ctxOf(w), w.businessId, d0, base(ds, { code: 'd', governanceStatus: 'approved', unit: 'eur' }))).ok).toBe(true);
    const id2 = ok(await handoff(w)).handoff.calculationHandoffId; expect(id2).not.toBe(id1);
    await reg(w, base(ds, { code: 'e' }));
    expect(ok(await handoff(w)).handoff.calculationHandoffId).not.toBe(id2);
    expect(ok(await handoff(w, { metricIds: [b] })).handoff.calculationHandoffId).not.toBe(id0);
  });

  it('refuses unknown, unapproved and dependency-open selections with the rule codes, and an empty registry with NO_METRICS_SELECTED', async () => {
    const w = await createWorld(admin, 'H6'); const ds = await dataset(w);
    const a = await reg(w, base(ds, { code: 'a' })); const draft = await reg(w, base(ds, { code: 'draftish', governanceStatus: 'draft' }));
    const m = await reg(w, base(ds, { code: 'm', metricType: 'derived', aggregation: undefined, dependencies: [a] }));
    expect(await handoff(w, { metricIds: [draft] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
    expect(await handoff(w, { metricIds: [randomUUID()] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    expect(await handoff(w, { metricIds: [m] })).toMatchObject({ ok: false, code: 'HANDOFF_INVALID' });
    expect(await handoff(w, { metricIds: [m, a] })).toMatchObject({ ok: true });
    const empty = await createWorld(admin, 'H6e');
    expect(await handoff(empty)).toMatchObject({ ok: false, code: 'NO_METRICS_SELECTED' });
  });

  it('is scoped to the business: a sibling business, another tenant and the Stage 2D (ungoverned) definitions never contribute, and a foreign business id is NotFound', async () => {
    const a = await createWorld(admin, 'H7a'); const sib = await addBusiness(admin, a); const b = await createWorld(admin, 'H7b');
    const dsA = await dataset(a); const dsS = await dataset(sib); const dsB = await dataset(b);
    const mine = await reg(a, base(dsA, { code: 'mine' })); const theirs = await reg(sib, base(dsS, { code: 'sibling' })); const foreign = await reg(b, base(dsB, { code: 'foreign' }));
    await q(`INSERT INTO business_intelligence.metric_definitions (tenant_id, workspace_id, business_id, metric_code, domain, metric_type, name, unit, status) VALUES ($1,$2,$3,'legacy','financial','base','Legacy','usd','active')`, [a.tenantId, a.workspaceId, a.businessId]);
    const h = ok(await handoff(a)).handoff;
    expect(h.metrics.map((m) => m.code)).toEqual(['mine']);
    expect(JSON.stringify(h)).not.toMatch(new RegExp(`${theirs}|${foreign}|${b.tenantId}|legacy`));
    expect(await handoff(a, { metricIds: [theirs] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    expect(await handoff(a, { metricIds: [foreign] })).toMatchObject({ ok: false, code: 'METRIC_NOT_FOUND' });
    expect(mine).toBeTruthy();
    await expect(handoff(a, { businessId: b.businessId })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(handoff(b, { businessId: a.businessId })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(handoff(a, { ctx: { ...ctxOf(a), tenantId: b.tenantId } })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(handoff(a, { businessId: 'not-a-uuid' })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('an upper-case business id reaches the same business; a soft-deleted business is NotFound', async () => {
    const w = await createWorld(admin, 'H8'); const ds = await dataset(w); await reg(w, base(ds, { code: 'a' }));
    const lower = ok(await handoff(w)).handoff; const upper = ok(await handoff(w, { businessId: w.businessId.toUpperCase() })).handoff;
    expect(upper).toEqual(lower);
    expect(upper.scope.businessId).toBe(w.businessId);
    await admin.query(`UPDATE platform.businesses SET deleted_at = now() WHERE id = $1`, [w.businessId]);
    await expect(handoff(w)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('hands over a registry larger than the read API page size whole (no silent truncation; D-F: no cap is documented, none is applied)', async () => {
    const w = await createWorld(admin, 'H9'); const ds = await dataset(w);
    const n = 105;
    for (let i = 0; i < n; i += 1) await reg(w, base(ds, { code: `bulk_${String(i).padStart(3, '0')}` }));
    const h = ok(await handoff(w)).handoff;
    expect(h.metrics).toHaveLength(n); expect(h.metricVersions).toHaveLength(n);
    expect(h.metrics.map((m) => m.code)).toEqual([...h.metrics.map((m) => m.code)].sort());
    expect(ok(await handoff(w)).handoff.calculationHandoffId).toBe(h.calculationHandoffId);
  }, 180_000);

  it('reading a hand-off writes nothing: no insert, update or delete is issued, and the registry and audit state are unchanged', async () => {
    const w = await createWorld(admin, 'H10'); const ds = await dataset(w);
    const a = await reg(w, base(ds, { code: 'a' })); await reg(w, base(ds, { code: 'b', governanceStatus: 'draft' }));
    const before = await tableState(w);
    const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await originalConnect(); const original = client.query.bind(client);
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
      return client;
    }) as never);
    try { ok(await handoff(w)); await handoff(w, { metricIds: [a] }); await handoff(w, { metricIds: [randomUUID()] }); } finally { vi.restoreAllMocks(); }
    expect(statements.length).toBeGreaterThan(0);
    const writes = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|MERGE|COPY)\b/i.test(s));
    expect(writes).toEqual([]);
    expect(await tableState(w)).toEqual(before);
  });

  it('the stored header status is authoritative: a metric retired or deprecated after approval (without a new version) is no longer handed over', async () => {
    const w = await createWorld(admin, 'H12'); const ds = await dataset(w);
    const keep = await reg(w, base(ds, { code: 'keep' })); const gone = await reg(w, base(ds, { code: 'gone' }));
    const before = ok(await handoff(w)).handoff;
    expect(before.metrics.map((m) => m.code)).toEqual(['gone', 'keep']);
    await admin.query(`UPDATE business_intelligence.metric_definitions SET status = 'retired' WHERE id = $1`, [gone]);
    const after = ok(await handoff(w)).handoff;
    expect(after.metrics.map((m) => m.code)).toEqual(['keep']);
    expect(after.metrics[0]).toMatchObject({ metricId: keep, status: 'active' });
    expect(after.calculationHandoffId).not.toBe(before.calculationHandoffId);
    expect(await handoff(w, { metricIds: [gone] })).toMatchObject({ ok: false, code: 'METRIC_NOT_APPROVED' });
  });

  it('the write service\'s hand-off is the same deterministic hand-off (one identity rule, no random id, no clock)', async () => {
    const w = await createWorld(admin, 'H11'); const ds = await dataset(w);
    await reg(w, base(ds, { code: 'a' })); await reg(w, base(ds, { code: 'b' }));
    const viaWriter = await writer.calculationHandoff(ctxOf(w), w.businessId, { warehouseSnapshotId: null, correlationId: 'c' });
    const viaReader = await handoff(w, { correlationId: 'c' });
    expect(ok(viaWriter).handoff).toEqual(ok(viaReader).handoff);
    expect(ok(await writer.calculationHandoff(ctxOf(w), w.businessId, { warehouseSnapshotId: null, correlationId: 'c' })).handoff).toEqual(ok(viaWriter).handoff);
  });
});
