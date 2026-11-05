/**
 * POS2-03: GET /v1/businesses/:businessId/pos-readiness on live PostgreSQL + the real Fastify application (RLS enforced for the app role).
 * The readiness verdicts are checked against what order creation actually does, so the report cannot drift from the enforced contract.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, EntitlementRepository, type TenantContext } from '@infinicus/database';
import { EntitlementService } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let adminPool: Pool;
let app: FastifyInstance;
const entitlements = new EntitlementService();

interface Session { ctx: TenantContext; token: string; bizId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('oc')}@oc-api.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}

async function grantRole(ctx: TenantContext, userId: string, role: string | { permissions: string[] }): Promise<void> {
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  let roleId: string;
  if (typeof role === 'string') {
    roleId = (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  } else {
    roleId = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','oc test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'OC API Tenant',$2,'active','test')`, [tenantId, `oca-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'OC API WS',$3,'active')`, [workspaceId, tenantId, `oca-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ OC Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('oca-biz')]);
  return { ctx, token, bizId };
}
const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const openRegister = (s: Session, openingCash = 0) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash } });
const closeRegister = (s: Session, sessionId: string, closingCash = 0) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions/${sessionId}/close`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { closingCash } });
/** Declare a currency and open the register (orders need both). */
const declareAndOpen = async (s: Session, currency: string): Promise<string> => {
  expect((await declare(s, currency)).statusCode).toBe(201);
  const r = await openRegister(s);
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};

const readinessUrl = (bizId: string) => `/v1/businesses/${bizId}/pos-readiness`;
const readiness = (s: { ctx: TenantContext; token: string }, bizId: string) => app.inject({ method: 'GET', url: readinessUrl(bizId), headers: hdr(s) });
const declare = (s: Session, currency: string, expectedVersion: number | null = null, reason?: string) =>
  app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion, ...(reason ? { reason } : {}) } });
const createOrder = (s: Session) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/orders`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const status = (body: any, id: string) => body.checks.find((c: any) => c.id === id);
async function grant(ctx: TenantContext, capability: string): Promise<void> {
  const c = await adminPool.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await EntitlementRepository.grant(c, ctx.tenantId, { capability, sourceType: 'operator_grant', sourceReference: `fx-${randomUUID()}`, effectiveFrom: new Date(Date.now() - 86_400_000) });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const counts = async (bizId: string, tenantId: string) => JSON.stringify((await adminPool.query(
  `SELECT (SELECT count(*) FROM platform.orders WHERE business_id=$1) o, (SELECT count(*) FROM business_operations.register_sessions WHERE business_id=$1) r,
          (SELECT count(*) FROM billing.entitlements WHERE tenant_id=$2) e, (SELECT count(*) FROM business_operations.business_events WHERE business_id=$1) ev,
          (SELECT count(*) FROM billing.subscriptions WHERE tenant_id=$2) s`, [bizId, tenantId])).rows[0]);

describe.runIf(run)('POS2-03 POS readiness - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('a new business is NOT_READY with stable reasons; the report agrees with order creation being refused', async () => {
    const s = await setup('owner');
    const r = await readiness(s, s.bizId);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ contract: 'pos-readiness/1', businessId: s.bizId, configuration: 'NOT_READY', session: 'NOT_READY' });
    expect(b.blockingReasons).toEqual(['CURRENCY_NOT_DECLARED', 'PREREQUISITE_NOT_MET', 'REGISTER_NOT_OPEN', 'PREREQUISITE_NOT_MET']);
    expect(status(b, 'CURRENCY_DECLARED')).toMatchObject({ requirement: 'REQUIRED', status: 'FAIL', reasonCode: 'CURRENCY_NOT_DECLARED' });
    expect(status(b, 'CURRENCY_SUPPORTED').status).toBe('SKIPPED');
    expect(status(b, 'BUSINESS_ACTIVE').status).toBe('PASS');
    expect(status(b, 'CATALOG_HAS_ACTIVE_PRODUCT')).toMatchObject({ requirement: 'ADVISORY', status: 'FAIL', reasonCode: 'NO_ACTIVE_PRODUCTS' });
    for (const id of ['TAX_CONFIGURATION', 'INVENTORY_CONFIGURATION', 'BRANCH_CONFIGURATION']) expect(status(b, id)).toMatchObject({ status: 'NOT_APPLICABLE', requirement: 'ADVISORY' });
    expect((await createOrder(s)).statusCode).toBe(409);
  });

  it('declared currency but no register: configuration READY, session NOT_READY - and order creation is refused for exactly that reason', async () => {
    const s = await setup('owner');
    expect((await declare(s, 'KWD')).statusCode).toBe(201);
    const b = (await readiness(s, s.bizId)).json();
    expect(b).toMatchObject({ configuration: 'READY', session: 'NOT_READY', blockingReasons: ['REGISTER_NOT_OPEN', 'PREREQUISITE_NOT_MET'] });
    const refused = await createOrder(s);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('no register session is open');
  });

  it('with an open register in the declared currency it is READY/READY and an order is accepted', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD');
    expect((await openRegister(s)).statusCode).toBe(201);
    const b = (await readiness(s, s.bizId)).json();
    expect(b).toMatchObject({ configuration: 'READY', session: 'READY', blockingReasons: [] });
    expect(status(b, 'REGISTER_OPEN').status).toBe('PASS'); expect(status(b, 'REGISTER_CURRENCY_MATCHES').status).toBe('PASS');
    expect((await createOrder(s)).statusCode).toBe(201);
  });

  it('a register in another currency than the declared one is NOT_READY (REGISTER_CURRENCY_MISMATCH) and order creation is refused', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD'); await openRegister(s);
    expect((await declare(s, 'USD', 1, 'switch')).statusCode).toBe(201);
    const b = (await readiness(s, s.bizId)).json();
    expect(b).toMatchObject({ configuration: 'READY', session: 'NOT_READY', blockingReasons: ['REGISTER_CURRENCY_MISMATCH'] });
    expect(status(b, 'REGISTER_OPEN').status).toBe('PASS');
    const refused = await createOrder(s);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('not in the business\'s declared currency');
  });

  it('closing the register makes the session NOT_READY again', async () => {
    const s = await setup('owner');
    await declare(s, 'USD');
    const id = (await openRegister(s)).json().id as string;
    expect((await readiness(s, s.bizId)).json().session).toBe('READY');
    expect((await closeRegister(s, id)).statusCode).toBe(200);
    expect((await readiness(s, s.bizId)).json().session).toBe('NOT_READY');
  });

  it('a draft business reports BUSINESS_NOT_ACTIVE as ADVISORY only: configuration stays READY and orders are still accepted (no behaviour is invented)', async () => {
    const s = await setup('owner');
    await adminPool.query(`UPDATE platform.businesses SET status = 'draft' WHERE id = $1`, [s.bizId]);
    await declare(s, 'KWD'); await openRegister(s);
    const b = (await readiness(s, s.bizId)).json();
    expect(status(b, 'BUSINESS_ACTIVE')).toMatchObject({ requirement: 'ADVISORY', status: 'FAIL', reasonCode: 'BUSINESS_NOT_ACTIVE' });
    expect(b).toMatchObject({ configuration: 'READY', session: 'READY', blockingReasons: [] });
    expect((await createOrder(s)).statusCode).toBe(201);
  });

  it('is deterministic and writes nothing', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD'); await openRegister(s);
    const before = await counts(s.bizId, s.ctx.tenantId);
    const a = (await readiness(s, s.bizId)).body; const b2 = (await readiness(s, s.bizId)).body;
    expect(a).toBe(b2);
    expect(await counts(s.bizId, s.ctx.tenantId)).toBe(before);
  });

  it('is independent of billing entitlement: a suspended tenant and a Growth-only tenant get the same report as an unconfigured one', async () => {
    const plain = await setup('owner'); const suspended = await setup('owner'); const growth = await setup('owner');
    for (const s of [plain, suspended, growth]) { await declare(s, 'KWD'); await openRegister(s); }
    await grant(growth.ctx, 'intelligence.growth');                              // no pos.core: POS writes are 403 for this tenant
    await entitlements.suspend(suspended.ctx, 'pos2_03_test');                   // suspended: POS writes are 402 for this tenant
    const norm = (s: Session, body: any) => JSON.stringify({ ...body, businessId: 'X' });
    const reports = [];
    for (const s of [plain, suspended, growth]) { const r = await readiness(s, s.bizId); expect(r.statusCode).toBe(200); reports.push(norm(s, r.json())); }
    expect(new Set(reports).size).toBe(1);
    expect(JSON.parse(reports[0]!)).toMatchObject({ configuration: 'READY', session: 'READY' });
    expect((await createOrder(growth)).statusCode).toBe(403);
    expect((await createOrder(suspended)).statusCode).toBe(402);
  });

  it('is tenant and workspace isolated, authenticated and permission-gated', async () => {
    const a = await setup('owner'); const other = await setup('owner');
    expect((await readiness(other, a.bizId)).statusCode).toBe(404);                      // another tenant's business
    expect((await readiness(a, randomUUID())).statusCode).toBe(404);                      // unknown business
    const ws2 = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS2',$3,'active')`, [ws2, a.ctx.tenantId, uc('ws2')]);
    const m = new MembershipRepository(); const ctx2: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: ws2, userId: a.ctx.userId };
    const mem = await m.create(ctx2, a.ctx.userId); await m.activate(ctx2, mem.id);
    await m.assignRole(ctx2, mem.id, (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = 'owner'`)).rows[0].id);
    expect((await readiness({ ctx: ctx2, token: a.token }, a.bizId)).statusCode).toBe(404);   // same tenant, another workspace
    expect((await app.inject({ method: 'GET', url: readinessUrl(a.bizId) })).statusCode).toBe(401);
    const noRead = await setup({ permissions: ['bo:write'] });
    expect((await readiness(noRead, noRead.bizId)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/businesses/not-a-uuid/pos-readiness', headers: hdr(a) })).statusCode).toBe(400);
  });
});

describe.skipIf(run)('POS2-03 POS readiness (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
