/**
 * F-NA05-1 - POST /v1/businesses/:businessId/outcomes with a monitoredActionId that is not a valid monitored action OF THAT BUSINESS.
 * Before the fix: unknown id -> HTTP 500 (an unmapped foreign-key violation); an id belonging to another business or another tenant satisfied the
 * foreign key (FK checks are not subject to row-level security) and an observation was written against it.
 * After: every one of those answers the same controlled 404 and writes nothing. Real PostgreSQL, production buildApp.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { uc } from './helpers/abaFixtures.js';
import { createMonitoredAction } from './helpers/omFixtures.js';

const run = !!process.env.DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';

let admin: Pool;
let app: FastifyInstance;

interface World { ctx: TenantContext; token: string; bizId: string; monitoredActionId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('f1')}@fna05.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}

const roleId = async (code: string) => (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [code])).rows[0].id as string;

async function addMember(ctx: TenantContext, userId: string, role: string | null) {
  const c: TenantContext = { ...ctx, userId };
  const repo = new MembershipRepository();
  const m = await repo.create(c, userId);
  await repo.activate(c, m.id);
  if (role) await repo.assignRole(c, m.id, await roleId(role));
}

async function addBusiness(ctx: TenantContext): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'F-NA05-1 Biz',$4,'active')`, [id, ctx.tenantId, ctx.workspaceId, uc('f1-biz')]);
  return id;
}

/** A fresh tenant + workspace + one owner + one business that has one real monitored action. */
async function newWorld(): Promise<World & { second: { bizId: string; monitoredActionId: string } }> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'F1 Tenant',$2,'active','test')`, [tenantId, `f1-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'F1 WS',$3,'active')`, [workspaceId, tenantId, `f1-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await addMember(ctx, userId, 'owner');
  const bizId = await addBusiness(ctx);
  const monitoredActionId = await createMonitoredAction(ctx, bizId);
  const secondBiz = await addBusiness(ctx);                                  // a sibling business in the SAME workspace
  const secondAction = await createMonitoredAction(ctx, secondBiz);
  return { ctx, token, bizId, monitoredActionId, second: { bizId: secondBiz, monitoredActionId: secondAction } };
}

const headers = (p: { ctx: TenantContext; token: string }) => ({
  authorization: `Bearer ${p.token}`, 'x-tenant-id': p.ctx.tenantId, 'x-workspace-id': p.ctx.workspaceId, 'idempotency-key': uc('key'),
});
const body = (monitoredActionId: unknown) => ({ monitoredActionId, observationCode: uc('obs'), summary: 'outcome', effectiveAt: new Date().toISOString() });
const post = (p: { ctx: TenantContext; token: string }, bizId: string, monitoredActionId: unknown) =>
  app.inject({ method: 'POST', url: `/v1/businesses/${bizId}/outcomes`, headers: headers(p), payload: body(monitoredActionId) as never });

/** Row counts of every tenant-scoped table (except the API idempotency store and observability) for the given tenants. */
async function authoritativeRows(tenants: string[], ignore: string[] = []): Promise<Record<string, number>> {
  const tables = (await admin.query(
    `SELECT table_schema s, table_name t FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema NOT IN ('api','observability','information_schema','pg_catalog')
     GROUP BY 1,2 ORDER BY 1,2`)).rows as { s: string; t: string }[];
  const out: Record<string, number> = {};
  for (const { s, t } of tables.filter(({ s, t }) => !ignore.includes(`${s}.${t}`))) out[`${s}.${t}`] = Number((await admin.query(`SELECT count(*)::int n FROM "${s}"."${t}" WHERE tenant_id = ANY($1)`, [tenants])).rows[0].n);
  return out;
}
const changed = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => [k, `${before[k]} -> ${after[k]}`]));

const shape = (res: { statusCode: number; json(): { error?: { code?: string; message?: string } } }, ...ids: string[]) => {
  const e = res.json().error ?? {};
  let message = e.message ?? '';
  for (const id of ids) message = message.split(id).join('<ID>');
  return { status: res.statusCode, code: e.code, message, keys: Object.keys(e).sort() };
};

describe.runIf(run)('F-NA05-1 outcome recording: monitoredActionId classification (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  }, 120_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('a valid submission by an authorised principal still records the outcome (201, recorded)', async () => {
    const a = await newWorld();
    const res = await post(a, a.bizId, a.monitoredActionId);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'recorded' });
    const row = await admin.query(`SELECT monitored_action_id, business_id, tenant_id FROM outcome_monitoring.outcome_observations WHERE id = $1`, [res.json().id]);
    expect(row.rows[0]).toMatchObject({ monitored_action_id: a.monitoredActionId, business_id: a.bizId, tenant_id: a.ctx.tenantId });
  }, 60_000);

  it('an unknown but well-formed monitoredActionId answers a controlled 404 (never 500), with no SQL or constraint detail, and writes nothing', async () => {
    const a = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);   // warm-up: lazily provisioned rows exist before the snapshot
    const before = await authoritativeRows([a.ctx.tenantId]);
    const unknown = randomUUID();
    const res = await post(a, a.bizId, unknown);
    expect(res.statusCode).toBe(404);
    const err = res.json().error;
    expect(err.code).toBe('NotFoundError');
    expect(Object.keys(err).sort()).toEqual(['code', 'correlationId', 'message']);
    expect(JSON.stringify(res.json())).not.toMatch(/foreign key|violates|constraint|outcome_observations|23503|SELECT|INSERT|\bschema\b|\brelation\b/i);
    expect(changed(before, await authoritativeRows([a.ctx.tenantId]))).toEqual({});
  }, 60_000);

  it('a malformed monitoredActionId is a 400 validation error, writes nothing', async () => {
    const a = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);
    const before = await authoritativeRows([a.ctx.tenantId]);
    for (const bad of ['not-a-uuid', '', 123, null, "' OR 1=1 --"]) {
      const res = await post(a, a.bizId, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect(changed(before, await authoritativeRows([a.ctx.tenantId]))).toEqual({});
  }, 60_000);

  it("another business's monitored action (same tenant and workspace) is refused with the SAME 404 as an unknown id, and writes nothing", async () => {
    const a = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);
    const before = await authoritativeRows([a.ctx.tenantId]);
    const unknown = randomUUID();
    const foreignBusiness = await post(a, a.bizId, a.second.monitoredActionId);
    const unknownId = await post(a, a.bizId, unknown);
    expect(foreignBusiness.statusCode).toBe(404);
    expect(shape(foreignBusiness, a.second.monitoredActionId)).toEqual(shape(unknownId, unknown));
    expect(foreignBusiness.body).not.toContain(a.second.bizId);
    expect(changed(before, await authoritativeRows([a.ctx.tenantId]))).toEqual({});
  }, 60_000);

  it("another tenant's monitored action is refused with the SAME 404 as an unknown id, reveals nothing, and writes nothing in either tenant", async () => {
    const a = await newWorld(); const b = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);
    const before = await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]);
    const unknown = randomUUID();
    const foreignTenant = await post(a, a.bizId, b.monitoredActionId);
    const unknownId = await post(a, a.bizId, unknown);
    expect(foreignTenant.statusCode).toBe(404);
    expect(shape(foreignTenant, b.monitoredActionId)).toEqual(shape(unknownId, unknown));
    expect(foreignTenant.body).not.toContain(b.bizId);
    expect(foreignTenant.body).not.toContain(b.ctx.tenantId);
    expect(changed(before, await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]))).toEqual({});
  }, 120_000);

  it('a foreign business in the path still answers the existing business-scope 404 (authorisation unchanged), writes nothing', async () => {
    const a = await newWorld(); const b = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);
    const before = await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]);
    const res = await post(a, b.bizId, b.monitoredActionId);
    expect(res.statusCode).toBe(404);
    expect(changed(before, await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]))).toEqual({});
  }, 120_000);

  it('missing or invalid authentication is 401; an authenticated member without om:write is 403 - neither reaches the monitored-action lookup, nothing is written', async () => {
    const a = await newWorld();
    expect((await post(a, a.bizId, a.monitoredActionId)).statusCode).toBe(201);
    const nobody = await registerActiveUser();
    await addMember(a.ctx, nobody.userId, null);
    // audit.access_events records DENIED attempts by design (pre-existing, unchanged): it is the only table allowed to grow, and only by denial rows.
    const ignore = ['audit.access_events'];
    const before = await authoritativeRows([a.ctx.tenantId], ignore);
    const unauth = await app.inject({ method: 'POST', url: `/v1/businesses/${a.bizId}/outcomes`, headers: { 'x-tenant-id': a.ctx.tenantId, 'x-workspace-id': a.ctx.workspaceId, 'idempotency-key': uc('k') }, payload: body(a.monitoredActionId) as never });
    expect(unauth.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: `/v1/businesses/${a.bizId}/outcomes`, headers: { ...headers(a), authorization: 'Bearer not-a-real-token' }, payload: body(a.monitoredActionId) as never });
    expect(bad.statusCode).toBe(401);
    const noPerm = await post({ ctx: { ...a.ctx, userId: nobody.userId }, token: nobody.token }, a.bizId, a.monitoredActionId);
    expect(noPerm.statusCode).toBe(403);
    const noPermUnknown = await post({ ctx: { ...a.ctx, userId: nobody.userId }, token: nobody.token }, a.bizId, randomUUID());
    expect(noPermUnknown.statusCode).toBe(403);                                // an unprivileged caller learns nothing about which ids exist
    expect(changed(before, await authoritativeRows([a.ctx.tenantId], ignore))).toEqual({});
  }, 120_000);

  it('a rejected request does not consume the observation code: the same code can then be recorded against a valid action', async () => {
    const a = await newWorld();
    const code = uc('reuse');
    const rejected = await app.inject({ method: 'POST', url: `/v1/businesses/${a.bizId}/outcomes`, headers: headers(a), payload: { ...body(randomUUID()), observationCode: code } as never });
    expect(rejected.statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: `/v1/businesses/${a.bizId}/outcomes`, headers: headers(a), payload: { ...body(a.monitoredActionId), observationCode: code } as never });
    expect(ok.statusCode).toBe(201);
  }, 60_000);
});
