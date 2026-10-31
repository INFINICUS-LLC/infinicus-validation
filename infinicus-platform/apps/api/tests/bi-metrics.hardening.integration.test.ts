/**
 * BI-2-DEV-03-R2 - hardening of the governed metric registry read API (real PostgreSQL, production buildApp, application role).
 * (1) Identifiers: either letter case resolves to the same authorized resource and is canonicalized to lower case; malformed ones are refused before any database
 *     access; out-of-scope and nonexistent ids stay indistinguishable. (2) A soft-deleted business is not readable and reveals nothing, and the API never touches
 *     the registry rows. The original 24 behavioral tests live in bi-metrics.integration.test.ts and are unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, getPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceMetricRegistryService, type MetricDefinitionInput } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
let app: FastifyInstance; let admin: Pool; const tenantIds: string[] = []; let kit: ReturnType<typeof dalKit>;
const registry = new BusinessIntelligenceMetricRegistryService();
const get = (w: { ctx: TenantContext; token: string }, url: string) => app.inject({ method: 'GET', url, headers: kit.headers(w) });
const base = (businessId: string) => `/v1/businesses/${businessId}/bi/metrics`;

describe.runIf(run)('BI-2-DEV-03-R2: metric registry read API hardening', () => {
  let a: World; let b: World; let sibling: string; let soft: string;
  let dsA: string; let dsSib: string; let dsB: string; let dsSoft: string;
  const ids: Record<string, string> = {};

  async function dataset(w: { ctx: TenantContext }, businessId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,'financial','ds','active')`,
      [id, w.ctx.tenantId, w.ctx.workspaceId, businessId, unique('ds')]);
    return id;
  }
  async function register(w: { ctx: TenantContext }, businessId: string, ds: string, code: string, over: MetricDefinitionInput = {}): Promise<string> {
    const r = await registry.register(w.ctx, businessId, { name: code, code, warehouseDatasetId: ds, metricType: 'base', aggregation: 'sum', unit: 'usd', timeGrain: 'month', governanceStatus: 'approved', ...over });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { metric: { metricId: string } }).metric.metricId;
  }
  const newBusiness = async (w: World): Promise<string> =>
    (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Extra',$3,'active') RETURNING id`, [w.ctx.tenantId, w.ctx.workspaceId, unique('biz')])).rows[0].id;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await kit.world(); b = await kit.world();
    sibling = await newBusiness(a); soft = await newBusiness(a);
    dsA = await dataset(a, a.businessId); dsSib = await dataset(a, sibling); dsB = await dataset(b, b.businessId); dsSoft = await dataset(a, soft);
    ids.alpha = await register(a, a.businessId, dsA, 'alpha'); ids.beta = await register(a, a.businessId, dsA, 'beta', { timeGrain: 'day' });
    ids.sibling = await register(a, sibling, dsSib, 'alpha'); ids.foreign = await register(b, b.businessId, dsB, 'alpha');
    ids.softA = await register(a, soft, dsSoft, 'soft_a'); ids.softB = await register(a, soft, dsSoft, 'soft_b');
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

  async function memberWith(permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = reg.json().id as string; await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId, userId };
    const memberships = new MembershipRepository(); const m = await memberships.create(ctx, userId); await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI metric hardening role','workspace') RETURNING id`, [a.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }
  /** Status, error code and the message with the requested id masked: what a caller can observe about a refusal. */
  const observable = (res: { statusCode: number; json: () => { error?: { code: string; message: string } } }, requested: string) => {
    const e = res.json().error; return { status: res.statusCode, code: e?.code, message: e?.message.replace(new RegExp(requested, 'gi'), '<id>') };
  };

  describe('identifier case and canonical form', () => {
    it('an upper-case business id resolves to exactly the lower-case result (list), and the response carries canonical lower-case ids', async () => {
      const lower = await get(a, base(a.businessId)); const upper = await get(a, base(a.businessId.toUpperCase()));
      expect(upper.statusCode, upper.body).toBe(200); expect(upper.json()).toEqual(lower.json());
      for (const m of upper.json().metrics) { expect(m.metricId).toBe(m.metricId.toLowerCase()); expect(m.warehouseDatasetId).toBe(m.warehouseDatasetId.toLowerCase()); }
      expect(upper.body).not.toMatch(/[0-9A-F]{8}-[0-9A-F]{4}/);
    });

    it('upper-case and mixed-case business and metric ids resolve the same detail', async () => {
      const lower = await get(a, `${base(a.businessId)}/${ids.alpha}`);
      const mixed = (s: string) => s.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
      for (const [biz, met] of [[a.businessId.toUpperCase(), ids.alpha.toUpperCase()], [mixed(a.businessId), mixed(ids.alpha)], [a.businessId, ids.alpha.toUpperCase()], [a.businessId.toUpperCase(), ids.alpha]]) {
        const res = await get(a, `${base(biz!)}/${met!}`);
        expect(res.statusCode, `${biz} ${met}`).toBe(200); expect(res.json()).toEqual(lower.json());
      }
    });

    it('an upper-case dataset filter equals the lower-case one; an upper-case foreign dataset still filters to nothing', async () => {
      const lower = await get(a, `${base(a.businessId)}?datasetId=${dsA}`); const upper = await get(a, `${base(a.businessId)}?datasetId=${dsA.toUpperCase()}`);
      expect(upper.statusCode).toBe(200); expect(upper.json()).toEqual(lower.json()); expect(upper.json().metrics).toHaveLength(2);
      for (const ds of [dsSib, dsB]) expect((await get(a, `${base(a.businessId)}?datasetId=${ds.toUpperCase()}`)).json().metrics).toEqual([]);
    });

    it('upper-case never broadens access: out-of-scope and nonexistent ids give the same refusal in either case', async () => {
      const kinds = { sibling: ids.sibling, foreign: ids.foreign, random: randomUUID() };
      for (const [kind, id] of Object.entries(kinds)) {
        const lower = await get(a, `${base(a.businessId)}/${id}`); const upper = await get(a, `${base(a.businessId)}/${id.toUpperCase()}`);
        expect(lower.statusCode, kind).toBe(404); expect(upper.statusCode, kind).toBe(404);
        expect(observable(upper, id)).toEqual(observable(lower, id));
      }
      const refusals = await Promise.all(Object.values(kinds).map(async (id) => observable(await get(a, `${base(a.businessId)}/${id.toUpperCase()}`), id)));
      expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
      // the sibling business's metric is not reachable through this business in upper case, and another tenant still cannot use an upper-case business id
      expect((await get(a, `${base(sibling.toUpperCase())}/${ids.alpha.toUpperCase()}`)).statusCode).toBe(404);
      expect((await get(b, base(a.businessId.toUpperCase()))).statusCode).toBe(404);
      expect((await get(b, `${base(a.businessId.toUpperCase())}/${ids.alpha.toUpperCase()}`)).statusCode).toBe(404);
    });

    it('authorization still applies to upper-case ids: no session is 401, no bi:read is 403, bi:read alone is 200', async () => {
      const url = `${base(a.businessId.toUpperCase())}/${ids.alpha.toUpperCase()}`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await get(await memberWith([]), url)).statusCode).toBe(403);
      expect((await get(await memberWith(['bi:read']), url)).statusCode).toBe(200);
    });
  });

  describe('malformed identifiers never reach the database', () => {
    const bad = (m: string) => [
      `/v1/businesses/not-a-uuid/bi/metrics`, `/v1/businesses/${a.businessId.replace(/-/g, '')}/bi/metrics`, `/v1/businesses/%7B${a.businessId}%7D/bi/metrics`, `/v1/businesses/${a.businessId}%0A/bi/metrics`,
      `/v1/businesses/%20${a.businessId}/bi/metrics`, `/v1/businesses/urn:uuid:${a.businessId}/bi/metrics`, `/v1/businesses/${a.businessId}0/bi/metrics`, `/v1/businesses/${a.businessId.slice(0, 35)}/bi/metrics`,
      `${base(a.businessId)}/not-a-uuid`, `${base(a.businessId)}/${m}%0A`, `${base(a.businessId)}/%20${m}`, `${base(a.businessId)}/${m.replace(/-/g, '')}`, `${base(a.businessId)}/%7B${m}%7D`,
      `${base(a.businessId)}?datasetId=not-a-uuid`, `${base(a.businessId)}?datasetId=${dsA}%0A`, `${base(a.businessId)}?datasetId=%27%20OR%201%3D1--`, `${base(a.businessId)}?datasetId=${dsA.replace(/-/g, '')}`,
    ];
    it('every malformed identifier is a 400, and no pool connection or query is taken at all (not even for the session)', async () => {
      const connect = vi.spyOn(getPool(), 'connect'); const query = vi.spyOn(getPool(), 'query');
      for (const url of bad(ids.alpha)) {
        const res = await get(a, url);
        expect(res.statusCode, url).toBe(400);
        expect(res.body, url).not.toMatch(/invalid input syntax|business_intelligence|SELECT/i);
      }
      expect(connect).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    });

    it('control: a well-formed request does use the pool, so the zero above is a real signal', async () => {
      const connect = vi.spyOn(getPool(), 'connect');
      expect((await get(a, base(a.businessId))).statusCode).toBe(200);
      expect(connect).toHaveBeenCalled();
    });
  });

  describe('a soft-deleted business', () => {
    const registrySnapshot = async () => JSON.stringify((await admin.query(
      `SELECT d.id, d.metric_code, d.status, d.latest_version, d.updated_at, v.version_number, v.content_hash, v.definition_content, v.created_at
         FROM business_intelligence.metric_definitions d LEFT JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id
        WHERE d.tenant_id = $1 ORDER BY d.id, v.version_number`, [a.ctx.tenantId])).rows);

    it('is readable while active, then refused for list and detail exactly like a business that does not exist, without touching any registry row, and readable again once restored', async () => {
      const urls = () => [base(soft), `${base(soft)}/${ids.softA}`, `${base(soft)}/${ids.softB}`];
      // 1. active: an authorized caller can read it
      const list = await get(a, base(soft)); expect(list.statusCode, list.body).toBe(200);
      expect(list.json().metrics.map((m: { code: string }) => m.code)).toEqual(['soft_a', 'soft_b']);
      expect((await get(a, `${base(soft)}/${ids.softA}`)).statusCode).toBe(200);
      const before = await registrySnapshot();

      // 2. soft-deleted (fixture: the platform's soft-delete marker; production deletion behavior is untouched)
      await admin.query(`UPDATE platform.businesses SET deleted_at = now() WHERE id = $1`, [soft]);
      try {
        const random = randomUUID();
        const randomList = observable(await get(a, base(random)), random); const randomDetail = observable(await get(a, `${base(random)}/${ids.softA}`), random);
        const softList = await get(a, base(soft)); const softDetail = await get(a, `${base(soft)}/${ids.softA}`); const softDetailB = await get(a, `${base(soft)}/${ids.softB}`);
        for (const res of [softList, softDetail, softDetailB]) expect(res.statusCode, res.body).toBe(404);
        // 4. nothing reveals that the business or its metrics exist: same status, code and message shape as a business that never existed
        expect(observable(softList, soft)).toEqual(randomList); expect(observable(softDetail, soft)).toEqual(randomDetail);
        for (const res of [softList, softDetail]) { for (const leak of ['soft_a', 'soft_b', ids.softA, ids.softB, 'deleted', 'Extra']) expect(res.body, leak).not.toContain(leak); }
        // the deleted business's metric ids are not reachable through another business either
        expect((await get(a, `${base(a.businessId)}/${ids.softA}`)).statusCode).toBe(404);
        expect((await get(a, `${base(sibling)}/${ids.softA}`)).statusCode).toBe(404);
        // 5. authorization and tenant context are still enforced, and they precede the business lookup (so they cannot be used to probe existence)
        for (const url of urls()) expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
        const none = await memberWith([]); const only = await memberWith(['bi:read']);
        for (const url of urls()) { expect((await get(none, url)).statusCode, `no bi:read ${url}`).toBe(403); expect((await get(only, url)).statusCode, `bi:read ${url}`).toBe(404); }
        expect((await get(none, base(randomUUID()))).statusCode, 'no bi:read on a business that never existed').toBe(403);   // same 403 as for the soft-deleted one: no existence signal
        expect([400, 401, 403]).toContain((await app.inject({ method: 'GET', url: base(soft), headers: { authorization: `Bearer ${a.token}` } })).statusCode);
        for (const url of urls()) expect((await get(b, url)).statusCode, `other tenant ${url}`).toBe(404);
        expect(observable(await get(b, base(soft)), soft)).toEqual(randomList);
        // upper-case does not change the outcome
        expect((await get(a, base(soft.toUpperCase()))).statusCode).toBe(404);
        expect((await get(a, `${base(soft.toUpperCase())}/${ids.softA.toUpperCase()}`)).statusCode).toBe(404);
        // 3. the API mutated no registry row (definitions, versions, hashes, timestamps)
        expect(await registrySnapshot()).toBe(before);
      } finally {
        await admin.query(`UPDATE platform.businesses SET deleted_at = NULL WHERE id = $1`, [soft]);
      }
      // restored: access returns, so the refusal above came from the soft-delete and from nothing else
      expect((await get(a, base(soft))).statusCode).toBe(200);
      expect((await get(a, `${base(soft)}/${ids.softA}`)).statusCode).toBe(200);
      expect(await registrySnapshot()).toBe(before);
    });
  });
});
