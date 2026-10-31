/**
 * BI-2-DEV-03 - the governed BI-09 metric registry read API (real PostgreSQL, production buildApp, application role).
 * GET /v1/businesses/:businessId/bi/metrics[/:metricId]: read-only, bi:read, tenant / workspace / business isolation from the authenticated context, uniform 404
 * for anything outside the caller's business (no enumeration), only governed definitions, domain from the metric's own dataset, bounded deterministic pages,
 * no mutation, no internal fields. Metrics are registered by the REAL registry service (BusinessIntelligenceMetricRegistryService) over real datasets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, MetricDefinitionRepository, UserRepository, type BiMetricRegistryReadRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceMetricRegistryService, METRIC_AGGREGATIONS, METRIC_TYPES, PERSISTABLE_STATUSES, PERSISTABLE_TIME_GRAINS, type MetricDefinitionInput } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
let app: FastifyInstance; let admin: Pool; const tenantIds: string[] = []; let kit: ReturnType<typeof dalKit>;
const registry = new BusinessIntelligenceMetricRegistryService();
const get = (w: { ctx: TenantContext; token: string }, url: string) => app.inject({ method: 'GET', url, headers: kit.headers(w) });
const base = (businessId: string) => `/v1/businesses/${businessId}/bi/metrics`;
const SUMMARY_KEYS = ['aggregation', 'code', 'currency', 'domain', 'governanceStatus', 'metricId', 'metricType', 'name', 'owner', 'status', 'timeGrain', 'unit', 'updatedAt', 'version', 'warehouseDatasetId'];
const DETAIL_KEYS = [...SUMMARY_KEYS, 'contentHash', 'createdAt', 'dependencies', 'description', 'dimensions', 'filters', 'formula', 'sourceField', 'target', 'thresholds', 'versions'].sort();

describe.runIf(run)('BI-2-DEV-03: governed metric registry read API', () => {
  let a: World; let b: World; let sibling: string;
  let dsFin: string; let dsInv: string; let dsSib: string; let dsB: string;
  const ids: Record<string, string> = {};

  async function dataset(w: { ctx: TenantContext }, businessId: string, domain: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,$6,'ds','active')`,
      [id, w.ctx.tenantId, w.ctx.workspaceId, businessId, unique('ds'), domain]);
    return id;
  }
  const input = (ds: string, over: MetricDefinitionInput): MetricDefinitionInput => ({ name: 'Metric', warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', sourceField: 'amount', unit: 'usd', timeGrain: 'month', ...over });
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
    a = await kit.world(); b = await kit.world();
    sibling = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.ctx.tenantId, a.ctx.workspaceId, unique('sib')])).rows[0].id;
    dsFin = await dataset(a, a.businessId, 'financial'); dsInv = await dataset(a, a.businessId, 'inventory_supply');
    dsSib = await dataset(a, sibling, 'financial'); dsB = await dataset(b, b.businessId, 'financial');

    ids.cost = await register(a, a.businessId, { name: 'Cost', code: 'cost', governanceStatus: 'approved', owner: 'cfo' }, dsFin);
    ids.revenue = await register(a, a.businessId, { name: 'Revenue', code: 'revenue', governanceStatus: 'approved', owner: 'cfo', currency: 'USD', target: 100, thresholds: { low: 10 }, dimensions: ['region'], filters: [{ field: 'region', op: 'eq', value: 'north' }], description: 'Net revenue' }, dsFin);
    const rev2 = await registry.revise(a.ctx, a.businessId, ids.revenue, input(dsFin, { name: 'Revenue', code: 'revenue', governanceStatus: 'approved', owner: 'cfo', currency: 'USD', target: 100, thresholds: { low: 10 }, dimensions: ['region'], filters: [{ field: 'region', op: 'eq', value: 'north' }], description: 'Net revenue', unit: 'eur' }));
    expect(rev2.ok, JSON.stringify(rev2)).toBe(true);
    ids.margin = await register(a, a.businessId, { name: 'Margin', code: 'margin', metricType: 'derived', aggregation: undefined, dependencies: [ids.revenue, ids.cost], formula: { op: 'subtract', args: [ids.revenue, ids.cost] }, timeGrain: 'all_time', governanceStatus: 'approved' }, dsInv);
    ids.alpha = await register(a, a.businessId, { name: 'Alpha', code: 'alpha', aggregation: 'count_distinct', timeGrain: 'day', status: 'deprecated' }, dsInv);
    ids.sibling = await register(a, sibling, { name: 'Revenue', code: 'revenue' }, dsSib);
    ids.foreign = await register(b, b.businessId, { name: 'Revenue', code: 'revenue' }, dsB);
    const legacy = await new MetricDefinitionRepository().create(a.ctx, { businessId: a.businessId, metricCode: 'legacy_kpi', domain: 'financial', metricType: 'base', name: 'Legacy', unit: 'usd', aggregationMethod: 'sum', timeGrain: 'month' });
    ids.legacy = legacy.definition.id;
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

  /** A user who is an active member of tenant A's workspace holding exactly the given permissions through a tenant-owned role (none = no role at all). */
  async function memberWith(permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = reg.json().id as string; await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId, userId };
    const memberships = new MembershipRepository(); const m = await memberships.create(ctx, userId); await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI metric read test role','workspace') RETURNING id`, [a.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }
  const listOf = (res: { json: () => { metrics: Array<Record<string, unknown>> } }) => res.json().metrics;
  const codes = (res: { json: () => { metrics: Array<Record<string, unknown>> } }) => listOf(res).map((m) => m.code);

  describe('listing', () => {
    it('returns the business\'s governed metrics ordered by code, with the domain of each metric\'s own dataset; Stage 2D, sibling-business and other-tenant definitions never appear', async () => {
      const res = await get(a, base(a.businessId));
      expect(res.statusCode, res.body).toBe(200);
      expect(codes(res)).toEqual(['alpha', 'cost', 'margin', 'revenue']);
      const byCode = Object.fromEntries(listOf(res).map((m) => [m.code as string, m]));
      expect(byCode.revenue).toMatchObject({ metricId: ids.revenue, name: 'Revenue', metricType: 'base', aggregation: 'sum', unit: 'eur', currency: 'USD', timeGrain: 'month', status: 'active', governanceStatus: 'approved', owner: 'cfo', version: 2, warehouseDatasetId: dsFin, domain: 'financial' });
      expect(byCode.margin).toMatchObject({ metricType: 'derived', aggregation: null, timeGrain: 'all_time', warehouseDatasetId: dsInv, domain: 'inventory_supply' });
      expect(byCode.alpha).toMatchObject({ aggregation: 'count_distinct', timeGrain: 'day', status: 'deprecated', domain: 'inventory_supply' });
      expect(res.body).not.toContain(ids.legacy); expect(res.body).not.toContain(ids.sibling); expect(res.body).not.toContain(ids.foreign);
      expect(res.body).not.toContain('legacy_kpi');
    });

    it('every item is exactly the documented allow-list: no tenant, workspace, correlation or storage fields', async () => {
      const res = await get(a, base(a.businessId));
      for (const m of listOf(res)) expect(Object.keys(m).sort()).toEqual([...SUMMARY_KEYS].sort());
      for (const secret of ['tenantId', 'workspaceId', 'tenant_id', 'workspace_id', 'correlation', 'definition_content', a.ctx.tenantId, a.ctx.workspaceId]) expect(res.body, secret).not.toContain(secret);
    });

    it('filters by dataset, status and time grain, alone and together; a filter only narrows', async () => {
      expect(codes(await get(a, `${base(a.businessId)}?datasetId=${dsFin}`))).toEqual(['cost', 'revenue']);
      expect(codes(await get(a, `${base(a.businessId)}?datasetId=${dsInv}`))).toEqual(['alpha', 'margin']);
      expect(codes(await get(a, `${base(a.businessId)}?status=deprecated`))).toEqual(['alpha']);
      expect(codes(await get(a, `${base(a.businessId)}?status=active`))).toEqual(['cost', 'margin', 'revenue']);
      expect(codes(await get(a, `${base(a.businessId)}?timeGrain=month`))).toEqual(['cost', 'revenue']);
      expect(codes(await get(a, `${base(a.businessId)}?timeGrain=all_time`))).toEqual(['margin']);
      expect(codes(await get(a, `${base(a.businessId)}?datasetId=${dsInv}&status=active&timeGrain=all_time`))).toEqual(['margin']);
      expect(codes(await get(a, `${base(a.businessId)}?datasetId=${dsFin}&timeGrain=day`))).toEqual([]);
    });

    it('a dataset of another business or tenant, or one that does not exist, filters to an empty list and reveals nothing', async () => {
      for (const ds of [dsSib, dsB, randomUUID()]) {
        const res = await get(a, `${base(a.businessId)}?datasetId=${ds}`);
        expect(res.statusCode).toBe(200); expect(listOf(res)).toEqual([]);
      }
    });

    it('pages deterministically: limit and offset boundaries, concatenated pages equal the full list, beyond the end is empty', async () => {
      const all = codes(await get(a, base(a.businessId)));
      const p1 = codes(await get(a, `${base(a.businessId)}?limit=2&offset=0`)); const p2 = codes(await get(a, `${base(a.businessId)}?limit=2&offset=2`));
      expect([...p1, ...p2]).toEqual(all);
      expect(codes(await get(a, `${base(a.businessId)}?limit=1&offset=3`))).toEqual([all[3]]);
      expect(codes(await get(a, `${base(a.businessId)}?offset=4`))).toEqual([]);
      expect(codes(await get(a, `${base(a.businessId)}?offset=100000`))).toEqual([]);
      expect((await get(a, `${base(a.businessId)}?limit=100`)).statusCode).toBe(200);
      const echoed = (await get(a, `${base(a.businessId)}?limit=3&offset=1`)).json();
      expect({ limit: echoed.limit, offset: echoed.offset }).toEqual({ limit: 3, offset: 1 });
      expect((await get(a, base(a.businessId))).json()).toMatchObject({ limit: 20, offset: 0 });
      for (let i = 0; i < 3; i++) expect(codes(await get(a, `${base(a.businessId)}?limit=3`))).toEqual(all.slice(0, 3));
    });

    it('an empty registry is an empty list, not an error', async () => {
      const res = await get(b, base(b.businessId) + `?status=retired`);
      expect(res.statusCode).toBe(200); expect(listOf(res)).toEqual([]);
      expect(codes(await get(a, `${base(sibling)}`))).toEqual(['revenue']);
    });

    it('rejects malformed requests before touching the database: bad ids, unknown parameters, unsupported or injected values, out-of-range paging', async () => {
      const bad = [
        `/v1/businesses/not-a-uuid/bi/metrics`, `${base(a.businessId)}?datasetId=not-a-uuid`, `${base(a.businessId)}?status=draft`, `${base(a.businessId)}?status=active%27%20OR%201%3D1--`,
        `${base(a.businessId)}?timeGrain=fortnight`, `${base(a.businessId)}?domain=financial`, `${base(a.businessId)}?code=revenue`, `${base(a.businessId)}?tenantId=${b.ctx.tenantId}`,
        `${base(a.businessId)}?limit=0`, `${base(a.businessId)}?limit=101`, `${base(a.businessId)}?limit=abc`, `${base(a.businessId)}?offset=-1`, `${base(a.businessId)}?offset=100001`,
        `${base(a.businessId)}/not-a-uuid`, `${base(a.businessId)}/${ids.revenue}?versionLimit=0`, `${base(a.businessId)}/${ids.revenue}?versionLimit=101`, `${base(a.businessId)}/${ids.revenue}?limit=5`,
      ];
      for (const url of bad) { const res = await get(a, url); expect(res.statusCode, url).toBe(400); }
    });
  });

  describe('detail', () => {
    it('returns the latest definition in full with its versions newest first, and exactly the documented fields', async () => {
      const res = await get(a, `${base(a.businessId)}/${ids.revenue}`);
      expect(res.statusCode, res.body).toBe(200);
      const m = res.json();
      expect(Object.keys(m).sort()).toEqual(DETAIL_KEYS);
      expect(m).toMatchObject({
        metricId: ids.revenue, code: 'revenue', name: 'Revenue', description: 'Net revenue', metricType: 'base', aggregation: 'sum', sourceField: 'amount', dependencies: [], dimensions: ['region'],
        filters: [{ field: 'region', op: 'eq', value: 'north' }], formula: null, timeGrain: 'month', unit: 'eur', currency: 'USD', target: 100, thresholds: { low: 10 }, owner: 'cfo',
        governanceStatus: 'approved', status: 'active', version: 2, warehouseDatasetId: dsFin, domain: 'financial',
      });
      expect(m.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(m.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(m.versions[0]).toMatchObject({ governanceStatus: 'approved', timeGrain: 'month' }); expect(m.versions[0].contentHash).toBe(m.contentHash);
      expect(m.versions[1].contentHash).not.toBe(m.contentHash);
      expect(res.body).not.toContain(a.ctx.tenantId);
    });

    it('shows a derived metric with its dependencies and formula, and no aggregation', async () => {
      const m = (await get(a, `${base(a.businessId)}/${ids.margin}`)).json();
      expect(m).toMatchObject({ metricType: 'derived', aggregation: null, timeGrain: 'all_time', dependencies: [ids.revenue, ids.cost], formula: { op: 'subtract', args: [ids.revenue, ids.cost] }, domain: 'inventory_supply' });
    });

    it('versionLimit bounds the version history', async () => {
      expect((await get(a, `${base(a.businessId)}/${ids.revenue}?versionLimit=1`)).json().versions.map((v: { version: number }) => v.version)).toEqual([2]);
      expect((await get(a, `${base(a.businessId)}/${ids.cost}`)).json().versions).toHaveLength(1);
    });

    it('the stored response and a list item agree for the same metric', async () => {
      const item = listOf(await get(a, base(a.businessId))).find((m) => m.metricId === ids.revenue)!;
      const detail = (await get(a, `${base(a.businessId)}/${ids.revenue}`)).json();
      for (const k of SUMMARY_KEYS) expect(detail[k], k).toEqual(item[k]);
    });
  });

  describe('authorization', () => {
    const urls = () => [base(a.businessId), `${base(a.businessId)}/${ids.revenue}`];
    it('401 without a session or with a bad one', async () => {
      for (const url of urls()) {
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
        expect((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer not-a-real-token', 'x-tenant-id': a.ctx.tenantId, 'x-workspace-id': a.ctx.workspaceId } })).statusCode, url).toBe(401);
      }
    });

    it('403 for a member without bi:read, including one who holds only bo:read and da:read; 200 with bi:read alone', async () => {
      const none = await memberWith([]); const other = await memberWith(['bo:read', 'da:read']); const only = await memberWith(['bi:read']);
      for (const url of urls()) {
        expect((await get(none, url)).statusCode, `none ${url}`).toBe(403);
        expect((await get(other, url)).statusCode, `other ${url}`).toBe(403);
        expect((await get(only, url)).statusCode, `bi:read ${url}`).toBe(200);
      }
    });

    it('fails closed when the tenant or workspace context is missing or contradicts the session', async () => {
      const missing = async (headers: Record<string, string>) => (await app.inject({ method: 'GET', url: base(a.businessId), headers })).statusCode;
      expect([400, 401, 403]).toContain(await missing({ authorization: `Bearer ${a.token}` }));
      expect([400, 401, 403]).toContain(await missing({ authorization: `Bearer ${a.token}`, 'x-tenant-id': a.ctx.tenantId }));
      // A session claiming a tenant and workspace it has no membership in is refused and nothing is served: the platform answers 401, 403 or its own
      // "membership not found" 404 (the tenant always comes from the session's membership, never from the header alone).
      const spoofs = [
        { token: b.token, url: base(a.businessId), tenant: a.ctx.tenantId, workspace: a.ctx.workspaceId },
        { token: a.token, url: base(b.businessId), tenant: b.ctx.tenantId, workspace: b.ctx.workspaceId },
        { token: a.token, url: base(b.businessId), tenant: a.ctx.tenantId, workspace: a.ctx.workspaceId },
      ];
      for (const sp of spoofs) {
        const res = await app.inject({ method: 'GET', url: sp.url, headers: { authorization: `Bearer ${sp.token}`, 'x-tenant-id': sp.tenant, 'x-workspace-id': sp.workspace } });
        expect([401, 403, 404], sp.url).toContain(res.statusCode);
        expect(res.body).not.toContain('"metrics"'); expect(res.body).not.toContain('contentHash');
      }
    });

    it('there is no mutation surface: POST, PUT, PATCH and DELETE on every path are refused and change nothing', async () => {
      const count = async () => (await admin.query(
        `SELECT (SELECT count(*) FROM business_intelligence.metric_definitions WHERE tenant_id = $1)::int d, (SELECT count(*) FROM business_intelligence.metric_definition_versions WHERE tenant_id = $1)::int v`, [a.ctx.tenantId])).rows[0];
      const before = await count();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        for (const url of urls()) {
          const res = await app.inject({ method, url, headers: kit.headers(a, { 'idempotency-key': unique('k') }), payload: { code: 'injected', name: 'x' } });
          expect([404, 405], `${method} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
        }
      }
      expect(await count()).toEqual(before);
    });
  });

  describe('isolation and no enumeration', () => {
    it('a metric id of another business, another tenant, a Stage 2D definition, or one that does not exist is the same 404', async () => {
      const kinds: Record<string, string> = { sibling: ids.sibling, foreign: ids.foreign, legacy: ids.legacy, random: randomUUID() };
      const results = await Promise.all(Object.values(kinds).map((id) => get(a, `${base(a.businessId)}/${id}`)));
      for (const [i, res] of results.entries()) expect(res.statusCode, Object.keys(kinds)[i]).toBe(404);
      const shapes = new Set(results.map((r) => JSON.stringify(Object.keys(r.json().error).sort()) + r.json().error.code));
      expect(shapes.size).toBe(1);
      // the same id is reachable through its own business only
      expect((await get(a, `${base(sibling)}/${ids.sibling}`)).statusCode).toBe(200);
      expect((await get(a, `${base(sibling)}/${ids.revenue}`)).statusCode).toBe(404);
    });

    it('a business of another tenant or workspace is a 404 for the caller; the tenants never see each other\'s registry', async () => {
      expect((await get(b, base(a.businessId))).statusCode).toBe(404);
      expect((await get(b, `${base(a.businessId)}/${ids.revenue}`)).statusCode).toBe(404);
      expect((await get(a, base(b.businessId))).statusCode).toBe(404);
      expect((await get(a, base(randomUUID()))).statusCode).toBe(404);
      expect(codes(await get(b, base(b.businessId)))).toEqual(['revenue']);
      expect(listOf(await get(b, base(b.businessId)))[0]).toMatchObject({ metricId: ids.foreign });
    });
  });

  describe('governance', () => {
    it('reads change nothing: definitions, versions, hashes and Stage 2D rows are byte-identical before and after repeated reads, and no duplicate can appear', async () => {
      const snap = async () => JSON.stringify((await admin.query(
        `SELECT d.id, d.metric_code, d.status, d.latest_version, d.updated_at, v.version_number, v.content_hash, v.definition_content, v.created_at
           FROM business_intelligence.metric_definitions d LEFT JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id
          WHERE d.tenant_id = $1 ORDER BY d.id, v.version_number`, [a.ctx.tenantId])).rows);
      const before = await snap();
      for (let i = 0; i < 3; i++) for (const url of [base(a.businessId), `${base(a.businessId)}/${ids.revenue}`, `${base(a.businessId)}/${ids.legacy}`]) await get(a, url);
      expect(await snap()).toBe(before);
      const dup = await admin.query(`SELECT metric_code, count(*) FROM business_intelligence.metric_definitions WHERE business_id = $1 GROUP BY 1 HAVING count(*) > 1`, [a.businessId]);
      expect(dup.rows).toEqual([]);
    });

    it('the BI-08 dataset tables are untouched by reads', async () => {
      const snap = async () => JSON.stringify((await admin.query(`SELECT id, domain, status, latest_version, updated_at FROM business_intelligence.analytical_datasets WHERE tenant_id = $1 ORDER BY id`, [a.ctx.tenantId])).rows);
      const before = await snap(); await get(a, base(a.businessId)); await get(a, `${base(a.businessId)}/${ids.margin}`);
      expect(await snap()).toBe(before);
    });

    it('the domain is read from the metric\'s dataset, not from a stored copy: changing the dataset\'s domain changes what the API shows', async () => {
      const ds = await dataset(a, a.businessId, 'sales_revenue');
      const id = await register(a, a.businessId, { name: 'Dom', code: 'domain_probe' }, ds);
      expect((await get(a, `${base(a.businessId)}/${id}`)).json().domain).toBe('sales_revenue');
      await admin.query(`UPDATE business_intelligence.analytical_datasets SET domain = 'marketing' WHERE id = $1`, [ds]);
      expect((await get(a, `${base(a.businessId)}/${id}`)).json().domain).toBe('marketing');
      expect((await admin.query(`SELECT domain FROM business_intelligence.metric_definitions WHERE id = $1`, [id])).rows[0].domain).toBe('sales_revenue');
    });

    it('only valid time grains, statuses, metric types and aggregations are ever returned', async () => {
      const list = listOf(await get(a, base(a.businessId)));
      for (const m of list) {
        expect(PERSISTABLE_TIME_GRAINS as readonly string[]).toContain(m.timeGrain); expect(PERSISTABLE_STATUSES as readonly string[]).toContain(m.status);
        expect(METRIC_TYPES as readonly string[]).toContain(m.metricType); if (m.aggregation !== null) expect(METRIC_AGGREGATIONS as readonly string[]).toContain(m.aggregation);
      }
    });

    it('live-schema parity: the filter vocabularies the API accepts are exactly what the table CHECK constraints accept', async () => {
      const def = async (table: string, name: string) => (await admin.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [name, `business_intelligence.${table}`])).rows[0].d as string;
      const values = (d: string) => [...d.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(values(await def('metric_definition_versions', 'metric_definition_versions_time_grain_check'))).toEqual([...PERSISTABLE_TIME_GRAINS].sort());
      expect(values(await def('metric_definitions', 'metric_definitions_status_check'))).toEqual([...PERSISTABLE_STATUSES].sort());
      for (const g of PERSISTABLE_TIME_GRAINS) expect((await get(a, `${base(a.businessId)}?timeGrain=${g}`)).statusCode, g).toBe(200);
      for (const s of PERSISTABLE_STATUSES) expect((await get(a, `${base(a.businessId)}?status=${s}`)).statusCode, s).toBe(200);
    });

    it('a retired metric is still listed under its stored status (the read API reports; it does not hide or change state)', async () => {
      const ds = await dataset(a, a.businessId, 'financial');
      const id = await register(a, a.businessId, { name: 'Old', code: 'zz_retired', status: 'retired' }, ds);
      expect(codes(await get(a, `${base(a.businessId)}?status=retired`))).toEqual(['zz_retired']);
      expect((await get(a, `${base(a.businessId)}/${id}`)).json().status).toBe('retired');
    });
  });

  describe('database failure', () => {
    it('a repository failure is a non-sensitive 500: nothing from the underlying error reaches the caller', async () => {
      const boom = new Error('connection to 10.0.0.5:5432 failed: password=hunter2 relation business_intelligence.metric_definitions');
      const failing = { list: async () => { throw boom; }, get: async () => { throw boom; } } as unknown as BiMetricRegistryReadRepository;
      const broken = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), { biMetrics: { repository: failing } });
      await broken.ready();
      try {
        for (const url of [base(a.businessId), `${base(a.businessId)}/${ids.revenue}`]) {
          const res = await broken.inject({ method: 'GET', url, headers: kit.headers(a) });
          expect(res.statusCode, url).toBe(500);
          for (const leak of ['10.0.0.5', 'hunter2', 'business_intelligence', 'connection to']) expect(res.body, leak).not.toContain(leak);
          expect(res.json().error).toMatchObject({ code: expect.any(String), correlationId: expect.any(String) });
        }
      } finally { await broken.close(); }
    });
  });
});
