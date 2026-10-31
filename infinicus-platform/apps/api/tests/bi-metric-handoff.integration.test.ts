/**
 * BI-2-DEV-04 - the BI-09 -> BI-10 calculation hand-off read API (real PostgreSQL, production buildApp, application role).
 * GET /v1/businesses/:businessId/bi/metric-handoff: read-only, bi:read, tenant / workspace / business isolation from the authenticated context, uniform 404 for
 * anything outside the caller's business, approved + active governed metrics only, a derived (deterministic) identity that replays identically (also concurrently),
 * a stored (not clock) createdAt, the request correlation id carried unchanged, stable sanitized error mapping, and nothing written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceMetricRegistryService, type MetricDefinitionInput } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
let app: FastifyInstance; let admin: Pool; const tenantIds: string[] = []; let kit: ReturnType<typeof dalKit>;
const registry = new BusinessIntelligenceMetricRegistryService();
const url = (businessId: string, query = '') => `/v1/businesses/${businessId}/bi/metric-handoff${query}`;
const get = (w: { ctx: TenantContext; token: string }, path: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url: path, headers: { ...kit.headers(w), ...extra } });
const HANDOFF_KEYS = ['businessId', 'calculationHandoffId', 'correlationId', 'createdAt', 'metricVersions', 'metrics', 'status', 'targetBlock', 'warehouseSnapshotId'];
const METRIC_KEYS = ['aggregation', 'code', 'createdAt', 'currency', 'dependencies', 'description', 'dimensions', 'filters', 'formula', 'governanceStatus', 'metricId', 'metricType', 'name', 'owner', 'sourceField', 'status', 'target', 'thresholds', 'timeGrain', 'unit', 'updatedAt', 'version', 'warehouseDatasetId'];
const withoutCorrelation = (body: string) => { const j = JSON.parse(body); return { ...j, correlationId: undefined }; };

describe.runIf(run)('BI-2-DEV-04: BI-09 -> BI-10 calculation hand-off API', () => {
  let a: World; let b: World; let sibling: string; let empty: World;
  let dsA: string; let dsSib: string; let dsB: string;
  const ids: Record<string, string> = {};

  async function dataset(w: { ctx: TenantContext }, businessId: string, domain = 'financial'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,$6,'ds','active')`,
      [id, w.ctx.tenantId, w.ctx.workspaceId, businessId, unique('ds'), domain]);
    return id;
  }
  const input = (ds: string, over: MetricDefinitionInput): MetricDefinitionInput => ({ name: 'Metric', warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
  async function register(w: { ctx: TenantContext }, businessId: string, over: MetricDefinitionInput, ds: string): Promise<string> {
    const r = await registry.register(w.ctx, businessId, input(ds, over));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  }

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await kit.world(); b = await kit.world(); empty = await kit.world();
    sibling = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.ctx.tenantId, a.ctx.workspaceId, unique('sib')])).rows[0].id;
    dsA = await dataset(a, a.businessId); dsSib = await dataset(a, sibling); dsB = await dataset(b, b.businessId);
    ids.cost = await register(a, a.businessId, { name: 'Cost', code: 'cost', owner: 'cfo' }, dsA);
    ids.revenue = await register(a, a.businessId, { name: 'Revenue', code: 'revenue', owner: 'cfo', currency: 'USD', target: 100, thresholds: { low: 10 }, dimensions: ['region'], filters: [{ field: 'region', op: 'eq', value: 'north' }], description: 'Net revenue' }, dsA);
    const rev2 = await registry.revise(a.ctx, a.businessId, ids.revenue, input(dsA, { name: 'Revenue', code: 'revenue', owner: 'cfo', currency: 'USD', target: 100, thresholds: { low: 10 }, dimensions: ['region'], filters: [{ field: 'region', op: 'eq', value: 'north' }], description: 'Net revenue', unit: 'eur' }));
    expect(rev2.ok, JSON.stringify(rev2)).toBe(true);
    ids.margin = await register(a, a.businessId, { name: 'Margin', code: 'margin', metricType: 'derived', aggregation: undefined, dependencies: [ids.revenue, ids.cost], formula: { op: 'subtract', args: [ids.revenue, ids.cost] }, timeGrain: 'all_time' }, dsA);
    ids.draft = await register(a, a.businessId, { name: 'Draft', code: 'draftish', governanceStatus: 'draft' }, dsA);
    ids.old = await register(a, a.businessId, { name: 'Old', code: 'old_kpi', status: 'deprecated' }, dsA);
    ids.sibling = await register(a, sibling, { name: 'Sibling', code: 'sibling_only' }, dsSib);
    ids.foreign = await register(b, b.businessId, { name: 'Foreign', code: 'foreign_only' }, dsB);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]); await c.query('COMMIT'); }
      catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    }
    await admin?.end(); await closePool();
  });

  async function memberWith(permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = reg.json().id as string; await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId, userId };
    const memberships = new MembershipRepository(); const m = await memberships.create(ctx, userId); await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI hand-off test role','workspace') RETURNING id`, [a.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }
  // Scoped to this file's own tenants: other test files run concurrently against the same database and legitimately create metrics, so a table-wide count is a race, not evidence.
  const state = async () => (await admin.query(
    `SELECT (SELECT count(*) FROM business_intelligence.metric_definitions WHERE tenant_id = ANY($1::uuid[])) AS defs,
            (SELECT count(*) FROM business_intelligence.metric_definition_versions WHERE tenant_id = ANY($1::uuid[])) AS vers,
            (SELECT md5(coalesce(string_agg(id::text || content_hash, ',' ORDER BY id), '')) FROM business_intelligence.metric_definition_versions WHERE tenant_id = ANY($1::uuid[])) AS fingerprint,
            (SELECT count(*) FROM business_intelligence.analytical_datasets WHERE tenant_id = ANY($1::uuid[])) AS datasets, (SELECT count(*) FROM audit.audit_events WHERE tenant_id = $2) AS audits`,
    [[a.ctx.tenantId, b.ctx.tenantId, empty.ctx.tenantId], a.ctx.tenantId])).rows[0];

  describe('content', () => {
    it('returns the approved, active metrics at their latest version, ordered by code, in the BI-10 contract shape', async () => {
      const res = await get(a, url(a.businessId));
      expect(res.statusCode, res.body).toBe(200);
      const h = res.json();
      expect(Object.keys(h).sort()).toEqual(HANDOFF_KEYS);
      expect(h).toMatchObject({ targetBlock: 'BI-10', status: 'ready', businessId: a.businessId, warehouseSnapshotId: null });
      expect(h.metrics.map((m: { code: string }) => m.code)).toEqual(['cost', 'margin', 'revenue']);
      for (const m of h.metrics) expect(Object.keys(m).sort()).toEqual(METRIC_KEYS);
      const byCode = Object.fromEntries(h.metrics.map((m: { code: string }) => [m.code, m]));
      expect(byCode.revenue).toMatchObject({ metricId: ids.revenue, version: 2, unit: 'eur', currency: 'USD', target: 100, dimensions: ['region'], filters: [{ field: 'region', op: 'eq', value: 'north' }], status: 'active', governanceStatus: 'approved', warehouseDatasetId: dsA });
      expect(byCode.margin).toMatchObject({ metricType: 'derived', aggregation: null, dependencies: [ids.revenue, ids.cost], timeGrain: 'all_time' });
      expect(h.metricVersions).toEqual([{ metricId: ids.cost, version: 1 }, { metricId: ids.margin, version: 1 }, { metricId: ids.revenue, version: 2 }]);
      for (const hidden of [ids.draft, ids.old, ids.sibling, ids.foreign, 'draftish', 'old_kpi', 'sibling_only', 'foreign_only']) expect(res.body, hidden).not.toContain(hidden);
    });

    it('contains no tenant, workspace, storage or authentication detail', async () => {
      const res = await get(a, url(a.businessId));
      for (const secret of ['tenantId', 'workspaceId', 'tenant_id', 'workspace_id', 'definition_content', 'rawSessionToken', a.ctx.tenantId, a.ctx.workspaceId, a.token]) expect(res.body, secret).not.toContain(secret);
    });

    it('an explicit selection hands over exactly those metrics when they are dependency-closed', async () => {
      const res = await get(a, url(a.businessId, `?metricIds=${ids.cost}&metricIds=${ids.revenue}`));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().metrics.map((m: { code: string }) => m.code)).toEqual(['cost', 'revenue']);
      const one = await get(a, url(a.businessId, `?metricIds=${ids.cost}`));
      expect(one.json().metrics.map((m: { code: string }) => m.code)).toEqual(['cost']);
    });

    it('createdAt (D-C) is the stored creation time of the newest handed-over version, not the request time', async () => {
      const res = await get(a, url(a.businessId));
      const stored = (await admin.query(`SELECT to_char(max(v.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM business_intelligence.metric_definition_versions v JOIN business_intelligence.metric_definitions d ON d.id = v.metric_definition_id AND v.version_number = d.latest_version WHERE d.id = ANY($1)`, [[ids.cost, ids.revenue, ids.margin]])).rows[0].t;
      expect(res.json().createdAt).toBe(stored);
      expect(Date.parse(res.json().createdAt)).toBeLessThan(Date.now() - 1);
    });
  });

  describe('deterministic identity, replay and correlation (D-B, D-C, D-D)', () => {
    it('replays identically; a different request correlation id changes only the correlation id, and the response header and body agree', async () => {
      const one = await get(a, url(a.businessId), { 'x-correlation-id': 'req-one' });
      await new Promise((r) => setTimeout(r, 20));
      const two = await get(a, url(a.businessId), { 'x-correlation-id': 'req-two' });
      expect(one.statusCode).toBe(200); expect(two.statusCode).toBe(200);
      expect(two.json().calculationHandoffId).toBe(one.json().calculationHandoffId);
      expect(withoutCorrelation(two.body)).toEqual(withoutCorrelation(one.body));
      expect([one.json().correlationId, two.json().correlationId]).toEqual(['req-one', 'req-two']);
      expect([one.headers['x-correlation-id'], two.headers['x-correlation-id']]).toEqual(['req-one', 'req-two']);
      const generated = await get(a, url(a.businessId));
      expect(generated.json().correlationId).toBe(generated.headers['x-correlation-id']);
      expect(generated.json().correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(generated.json().calculationHandoffId).toBe(one.json().calculationHandoffId);
    });

    it('is identical for concurrent callers (24 parallel requests)', async () => {
      const all = await Promise.all(Array.from({ length: 24 }, () => get(a, url(a.businessId), { 'x-correlation-id': 'same' })));
      expect(all.every((r) => r.statusCode === 200)).toBe(true);
      expect(new Set(all.map((r) => r.body)).size).toBe(1);
    });

    it('selection order, duplicates and upper-case ids do not change the identity; an upper-case business id reaches the same hand-off', async () => {
      const q1 = `?metricIds=${ids.cost}&metricIds=${ids.revenue}`;
      const q2 = `?metricIds=${ids.revenue.toUpperCase()}&metricIds=${ids.cost}&metricIds=${ids.cost.toUpperCase()}`;
      const r1 = await get(a, url(a.businessId, q1)); const r2 = await get(a, url(a.businessId, q2));
      expect(r2.statusCode, r2.body).toBe(200);
      expect(withoutCorrelation(r2.body)).toEqual(withoutCorrelation(r1.body));
      const upper = await get(a, url(a.businessId.toUpperCase()));
      expect(upper.statusCode, upper.body).toBe(200);
      expect(withoutCorrelation(upper.body)).toEqual(withoutCorrelation((await get(a, url(a.businessId))).body));
      expect(upper.json().businessId).toBe(a.businessId);
    });

    it('a different metric selection is a different hand-off', async () => {
      const all = await get(a, url(a.businessId)); const part = await get(a, url(a.businessId, `?metricIds=${ids.cost}`));
      expect(part.json().calculationHandoffId).not.toBe(all.json().calculationHandoffId);
    });

    it('a new version of a handed-over metric changes the identity and the metric version; the older identity stays reproducible only from the older state', async () => {
      const w = await kit.world(); const ds = await dataset(w, w.businessId);
      const m = await register(w, w.businessId, { name: 'Solo', code: 'solo' }, ds);
      const first = await get(w, url(w.businessId));
      expect(first.json().metricVersions).toEqual([{ metricId: m, version: 1 }]);
      expect((await registry.revise(w.ctx, w.businessId, m, input(ds, { name: 'Solo', code: 'solo', unit: 'eur' }))).ok).toBe(true);
      const second = await get(w, url(w.businessId));
      expect(second.json().metricVersions).toEqual([{ metricId: m, version: 2 }]);
      expect(second.json().calculationHandoffId).not.toBe(first.json().calculationHandoffId);
      expect(Date.parse(second.json().createdAt)).toBeGreaterThanOrEqual(Date.parse(first.json().createdAt));
    });
  });

  describe('authorization and isolation', () => {
    it('requires authentication (401) and bi:read (403); bi:read alone is enough', async () => {
      expect((await app.inject({ method: 'GET', url: url(a.businessId) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: url(a.businessId), headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
      const none = await memberWith([]); const other = await memberWith(['bo:read']); const reader = await memberWith(['bi:read']);
      for (const w of [none, other]) { const res = await get(w, url(a.businessId)); expect(res.statusCode, res.body).toBe(403); expect(res.body).not.toContain(ids.cost); }
      const res = await get(reader, url(a.businessId));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().metrics).toHaveLength(3);
    });

    it('a caller without bi:read learns nothing about whether the business exists (403 for a real and an unknown business alike)', async () => {
      const none = await memberWith([]);
      const real = await get(none, url(a.businessId)); const unknown = await get(none, url(randomUUID()));
      expect([real.statusCode, unknown.statusCode]).toEqual([403, 403]);
    });

    it('another tenant, a sibling workspace business, and an unknown business are indistinguishable 404s; no id or code of another party appears', async () => {
      const bearerOfB = await get(b, url(a.businessId)); const unknown = await get(a, url(randomUUID())); const siblingOfA = await get(a, url(empty.businessId));
      for (const res of [bearerOfB, unknown, siblingOfA]) {
        expect(res.statusCode, res.body).toBe(404);
        for (const leak of [a.ctx.tenantId, b.ctx.tenantId, ids.cost, ids.foreign, 'foreign_only']) expect(res.body, leak).not.toContain(leak);
      }
      expect(Object.keys(bearerOfB.json().error).sort()).toEqual(['code', 'correlationId', 'message']);
    });

    it('a business of the same workspace is reachable only with its own registry: the sibling business hand-off holds only its own metric', async () => {
      const res = await get(a, url(sibling));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().metrics.map((m: { code: string }) => m.code)).toEqual(['sibling_only']);
      expect(res.body).not.toContain(ids.cost);
    });

    it('a metric id of another business or tenant is the same 404 as one that does not exist', async () => {
      const bodies = [] as unknown[];
      for (const id of [ids.sibling, ids.foreign, randomUUID()]) {
        const res = await get(a, url(a.businessId, `?metricIds=${id}`));
        expect(res.statusCode, res.body).toBe(404);
        const { error } = res.json(); bodies.push({ ...error, correlationId: undefined });
        expect(res.body).not.toContain(id);
      }
      expect(bodies[1]).toEqual(bodies[0]); expect(bodies[2]).toEqual(bodies[0]);
    });

    it('a spoofed tenant or workspace header does not widen scope', async () => {
      const res = await get(a, url(a.businessId), { 'x-tenant-id': b.ctx.tenantId, 'x-workspace-id': b.ctx.workspaceId });
      expect(res.body).not.toContain(ids.foreign);
      expect(res.statusCode === 200 ? res.json().metrics.map((m: { code: string }) => m.code) : []).not.toContain('foreign_only');
    });

    it('a soft-deleted business is a 404', async () => {
      const w = await kit.world(); const ds = await dataset(w, w.businessId); await register(w, w.businessId, { name: 'Gone', code: 'gone' }, ds);
      expect((await get(w, url(w.businessId))).statusCode).toBe(200);
      await admin.query(`UPDATE platform.businesses SET deleted_at = now() WHERE id = $1`, [w.businessId]);
      expect((await get(w, url(w.businessId))).statusCode).toBe(404);
    });
  });

  describe('input validation and error mapping (D-E)', () => {
    it.each([
      ['a malformed business id', () => url('not-a-uuid')],
      ['a malformed metric id', () => url(a.businessId, '?metricIds=nope')],
      ['one malformed id among valid ones', () => url(a.businessId, `?metricIds=${ids.cost}&metricIds=nope`)],
      ['an empty metric id', () => url(a.businessId, '?metricIds=')],
      ['a braced uuid', () => url(a.businessId, `?metricIds={${ids.cost}}`)],
      ['an unknown query parameter', () => url(a.businessId, '?limit=5')],
      ['a tenant id smuggled in the query', () => url(a.businessId, `?tenantId=${b.ctx.tenantId}`)],
      ['a snapshot id (not accepted in v1)', () => url(a.businessId, '?warehouseSnapshotId=snap')],
    ])('refuses %s with 400 before any database access', async (_label, path) => {
      const res = await get(a, path());
      expect(res.statusCode, res.body).toBe(400);
      expect(Object.keys(res.json().error).sort()).toEqual(['code', 'correlationId', 'message']);
      expect(res.body).not.toMatch(/SELECT|business_intelligence|postgres|stack/i);
    });

    it('maps rule failures to stable typed statuses with fixed sanitized messages: unknown 404, not approved / dependency-open / nothing to hand over 409', async () => {
      const notApproved = await get(a, url(a.businessId, `?metricIds=${ids.draft}`));
      const deprecated = await get(a, url(a.businessId, `?metricIds=${ids.old}`));
      const open = await get(a, url(a.businessId, `?metricIds=${ids.margin}`));
      const nothing = await get(empty, url(empty.businessId));
      const unknown = await get(a, url(a.businessId, `?metricIds=${randomUUID()}`));
      expect([notApproved.statusCode, deprecated.statusCode, open.statusCode, nothing.statusCode, unknown.statusCode]).toEqual([409, 409, 409, 409, 404]);
      expect(notApproved.json().error.code).toBe('ConflictError'); expect(unknown.json().error.code).toBe('NotFoundError');
      for (const res of [notApproved, deprecated, open, nothing, unknown]) {
        for (const leak of [ids.draft, ids.old, ids.margin, ids.revenue, 'draftish', 'old_kpi', a.ctx.tenantId]) expect(res.body, leak).not.toContain(leak);
      }
      expect(notApproved.json().error.message).toBe(deprecated.json().error.message);
    });

    it('an unexpected failure is a 500 with a generic body that carries none of the underlying detail', async () => {
      const failing = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), {
        biMetricHandoff: { service: { calculationHandoff: async () => { throw new Error('connect ECONNREFUSED postgresql://svc_user:Sup3rSecret@10.1.2.3:5432/prod'); } } as never },
      });
      await failing.ready();
      try {
        const res = await failing.inject({ method: 'GET', url: url(a.businessId), headers: kit.headers(a) });
        expect(res.statusCode).toBe(500);
        expect(res.json().error).toMatchObject({ code: 'internal_error', message: 'An unexpected error occurred.' });
        expect(res.body).not.toMatch(/Sup3rSecret|ECONNREFUSED|postgresql|10\.1\.2\.3|svc_user/);
      } finally { await failing.close(); }
    });
  });

  describe('read-only', () => {
    it('serving hand-offs, including refusals, changes no registry row, dataset or audit event', async () => {
      const before = await state();
      await get(a, url(a.businessId)); await get(a, url(a.businessId, `?metricIds=${ids.cost}`)); await get(a, url(a.businessId, `?metricIds=${ids.draft}`));
      await get(a, url(a.businessId, `?metricIds=${randomUUID()}`)); await get(a, url('bad')); await get(b, url(a.businessId));
      await Promise.all(Array.from({ length: 8 }, () => get(a, url(a.businessId))));
      expect(await state()).toEqual(before);
    });

    it('offers no mutation verb on the path', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({ method, url: url(a.businessId), headers: kit.headers(a), payload: {} });
        expect([404, 405], `${method} ${res.statusCode}`).toContain(res.statusCode);
      }
    });
  });
});
