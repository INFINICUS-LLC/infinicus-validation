/**
 * POS-4: orders are taken in the business's open register session (migration 0202), in the business's declared currency; a sale is
 * recorded only into a session that is still open; a session summary counts the orders taken in it.
 * Live PostgreSQL + real Fastify application (RLS enforced for the app role). Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0202.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let adminPool: Pool;
let app: FastifyInstance;

interface Session { ctx: TenantContext; token: string; bizId: string }

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('rl')}@rl-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','rl test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'RL API Tenant',$2,'active','test')`, [tenantId, `rla-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'RL API WS',$3,'active')`, [workspaceId, tenantId, `rla-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ RL Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('rla-biz')]);
  return { ctx, token, bizId };
}
const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const sessionsUrl = (bizId: string) => `/v1/businesses/${bizId}/register-sessions`;
const ordersUrl = (bizId: string) => `/v1/businesses/${bizId}/orders`;
const declare = (s: Session, currency: string) => app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion: null } });
const openRegister = (s: Session, openingCash = 0) => app.inject({ method: 'POST', url: sessionsUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash } });
const closeRegister = (s: Session, sessionId: string, closingCash = 0) => app.inject({ method: 'POST', url: `${sessionsUrl(s.bizId)}/${sessionId}/close`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { closingCash } });
const createOrder = (s: Session) => app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const addLine = (s: Session, orderId: string, unitPrice: number) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Item', quantity: 1, unitPrice } });
const complete = (s: Session, orderId: string) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/complete`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const voidOrder = (s: Session, orderId: string) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/void`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const summary = (s: Session, sessionId: string, bizId = s.bizId) => app.inject({ method: 'GET', url: `${sessionsUrl(bizId)}/${sessionId}/summary`, headers: hdr(s) });
const orderCount = async (bizId: string) => Number((await adminPool.query(`SELECT count(*)::int AS n FROM platform.orders WHERE business_id = $1`, [bizId])).rows[0].n);
const saleEvents = async (bizId: string) => Number((await adminPool.query(`SELECT count(*)::int AS n FROM business_operations.business_events WHERE business_id = $1 AND event_type = 'sale'`, [bizId])).rows[0].n);

describe.runIf(run)('POS-4 register link - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('the migration is recorded', async () => {
    expect((await adminPool.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0202_link_orders_to_register_sessions.sql'`)).rows[0].n).toBe(1);
  });

  it('opening a register needs a declared currency, records it on the session, and refuses a second open session', async () => {
    const s = await setup('owner');
    expect((await openRegister(s)).statusCode).toBe(409);                      // undeclared: fail closed
    await declare(s, 'KWD');
    const r = await openRegister(s, 25.5);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'open', currencyCode: 'KWD', openingCash: 25.5 });
    expect((await openRegister(s)).statusCode).toBe(409);                      // one open session per business
  });

  it('opening cash must be exact in the currency: KWD allows 3 decimals, JPY none; nothing is rounded silently', async () => {
    const kwd = await setup('owner'); await declare(kwd, 'KWD');
    expect((await openRegister(kwd, 0.1255)).statusCode).toBe(400);
    expect((await openRegister(kwd, 10.125)).statusCode).toBe(201);
    const jpy = await setup('owner'); await declare(jpy, 'JPY');
    expect((await openRegister(jpy, 10.5)).statusCode).toBe(400);
    expect((await openRegister(jpy, 1000)).statusCode).toBe(201);
    const rows = await adminPool.query(`SELECT count(*)::int n FROM business_operations.register_sessions WHERE business_id = ANY($1::uuid[])`, [[kwd.bizId, jpy.bizId]]);
    expect(rows.rows[0].n).toBe(2);
  });

  it('an order cannot be created without an open register (409, no row); with one it carries the session id', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD');
    expect((await createOrder(s)).statusCode).toBe(409);
    expect(await orderCount(s.bizId)).toBe(0);
    const session = (await openRegister(s)).json();
    const o = await createOrder(s);
    expect(o.statusCode).toBe(201);
    expect(o.json()).toMatchObject({ registerSessionId: session.id, currencyCode: 'KWD' });
    expect((await closeRegister(s, session.id)).statusCode).toBe(200);
    expect((await createOrder(s)).statusCode).toBe(409);                      // closed again: no register
  });

  it('a sale cannot be recorded into a closed register session; the order stays open and can be voided', async () => {
    const s = await setup('owner');
    await declare(s, 'USD');
    const session = (await openRegister(s)).json();
    const order = (await createOrder(s)).json();
    await addLine(s, order.id, 4.5);
    expect((await closeRegister(s, session.id)).statusCode).toBe(200);
    expect((await complete(s, order.id)).statusCode).toBe(409);
    expect(await saleEvents(s.bizId)).toBe(0);
    expect((await voidOrder(s, order.id)).statusCode).toBe(200);
  });

  it('an order taken before register linking (no session) cannot be completed, only voided', async () => {
    const s = await setup('owner');
    await declare(s, 'USD'); await openRegister(s);
    const legacy = randomUUID();
    await adminPool.query(`INSERT INTO platform.orders (id, tenant_id, workspace_id, business_id, order_number, order_date, currency_code, operational_status) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,'USD','planned')`, [legacy, s.ctx.tenantId, s.ctx.workspaceId, s.bizId, `LEG-${legacy.slice(0, 8)}`]);
    await addLine(s, legacy, 2);
    expect((await complete(s, legacy)).statusCode).toBe(409);
    expect(await saleEvents(s.bizId)).toBe(0);
    expect((await voidOrder(s, legacy)).statusCode).toBe(200);
  });

  it('the database refuses an order linked to a register session of ANOTHER business', async () => {
    const a = await setup('owner'); const b = await setup('owner');
    await declare(a, 'USD'); await declare(b, 'USD');
    const sessionA = (await openRegister(a)).json();
    await openRegister(b);
    const orderB = (await createOrder(b)).json();
    await expect(adminPool.query(`UPDATE platform.orders SET register_session_id = $1 WHERE id = $2`, [sessionA.id, orderB.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('the session summary counts the orders taken in it and sums only completed ones, in the session currency', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD');
    const session = (await openRegister(s)).json();
    const o1 = (await createOrder(s)).json(); await addLine(s, o1.id, 1.125); expect((await complete(s, o1.id)).statusCode).toBe(200);
    const o2 = (await createOrder(s)).json(); await addLine(s, o2.id, 0.5); expect((await complete(s, o2.id)).statusCode).toBe(200);
    const o3 = (await createOrder(s)).json(); await addLine(s, o3.id, 9); expect((await voidOrder(s, o3.id)).statusCode).toBe(200);
    (await createOrder(s)).json();                                              // left planned
    const r = await summary(s, session.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ordersPlanned: 1, ordersCompleted: 2, ordersVoided: 1, completedSalesTotal: 1.625, session: { id: session.id, currencyCode: 'KWD' } });
  });

  it('the summary is business-scoped: another business\'s session id, or an unknown one, is 404; unauthenticated is 401', async () => {
    const a = await setup('owner'); const b = await setup('owner');
    await declare(a, 'USD'); const sessionA = (await openRegister(a)).json();
    expect((await summary(b, sessionA.id, b.bizId)).statusCode).toBe(404);     // other tenant: invisible
    expect((await summary(a, randomUUID())).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${sessionsUrl(a.bizId)}/${sessionA.id}/summary` })).statusCode).toBe(401);
    const second = await setup('owner');                                        // same-tenant different business is impossible to forge by path:
    expect((await summary(a, sessionA.id, second.bizId)).statusCode).not.toBe(200);
  });
});
