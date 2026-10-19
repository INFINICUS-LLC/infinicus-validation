/**
 * POS-1.5: a new order takes the business's DECLARED currency (migration 0185) instead of the platform.orders column default.
 * Live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection), migrated through 0185.
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
const ordersUrl = (bizId: string) => `/v1/businesses/${bizId}/orders`;
const declare = (s: Session, currency: string) => app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion: null } });
const createOrder = (s: Session, bizId = s.bizId) => app.inject({ method: 'POST', url: ordersUrl(bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const storedCurrency = async (orderId: string) => (await adminPool.query(`SELECT currency_code FROM platform.orders WHERE id = $1`, [orderId])).rows[0].currency_code as string;
const orderCount = async (bizId: string) => Number((await adminPool.query(`SELECT count(*)::int AS n FROM platform.orders WHERE business_id = $1`, [bizId])).rows[0].n);

describe.runIf(run)('POS-1.5 order currency - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('a business that declared a non-USD currency gets that currency on its new order (stored and returned)', async () => {
    const s = await setup('owner');
    expect((await declare(s, 'KWD')).statusCode).toBe(201);
    const r = await createOrder(s);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ businessId: s.bizId, currencyCode: 'KWD', operationalStatus: 'planned' });
    expect(await storedCurrency(r.json().id)).toBe('KWD');
    const read = await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}/${r.json().id}`, headers: hdr(s) });
    expect(read.json().currencyCode).toBe('KWD');
  });

  it('two businesses with different declared currencies get their own currency each', async () => {
    const a = await setup('owner'); const b = await setup('owner');
    await declare(a, 'EUR'); await declare(b, 'USD');
    expect((await createOrder(a)).json().currencyCode).toBe('EUR');
    expect((await createOrder(b)).json().currencyCode).toBe('USD');
  });

  it('an UNDECLARED business fails closed: 409, no order row, no silent USD (the tenant default_currency is not consulted)', async () => {
    const s = await setup('owner');
    expect((await adminPool.query(`SELECT default_currency FROM tenancy.tenants WHERE id = $1`, [s.ctx.tenantId])).rows[0].default_currency).toBe('USD');
    const r = await createOrder(s);
    expect(r.statusCode).toBe(409);
    expect(await orderCount(s.bizId)).toBe(0);
  });

  it('a later change of the declared currency applies to new orders only; existing orders keep theirs', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD');
    const first = (await createOrder(s)).json();
    const change = await app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency: 'EUR', expectedVersion: 1, reason: 'pos-1.5 test' } });
    expect(change.statusCode).toBe(201);
    const second = (await createOrder(s)).json();
    expect(second.currencyCode).toBe('EUR');
    expect(await storedCurrency(first.id)).toBe('KWD');
  });

  it('the caller cannot choose the currency: a currencyCode in the body is ignored and the declared one is stored', async () => {
    const s = await setup('owner');
    await declare(s, 'KWD');
    const r = await app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currencyCode: 'JPY' } as any });
    expect(r.statusCode).toBe(201);
    expect(r.json().currencyCode).toBe('KWD');
    expect(await storedCurrency(r.json().id)).toBe('KWD');
  });
});
