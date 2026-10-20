/**
 * POS-6b: discounts. A discount is a SIGNED line of the order (item_type 'discount'), so the total stays the sum of the lines. Owners and admins only
 * (permission bo:admin); exact in the currency; never below zero; the sale event does not count it as a unit sold; and the tender rules (applied payments equal
 * the total, enforced by the database) keep working on the discounted total. Live PostgreSQL + real Fastify application.
 * Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0206 (no new migration is needed for discounts).
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
  const email = `${uc('tn')}@tn-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','tn test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'TN API Tenant',$2,'active','test')`, [tenantId, `tna-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'TN API WS',$3,'active')`, [workspaceId, tenantId, `tna-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ TN Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('tna-biz')]);
  return { ctx, token, bizId };
}
const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const sessionsUrl = (bizId: string) => `/v1/businesses/${bizId}/register-sessions`;
const ordersUrl = (bizId: string) => `/v1/businesses/${bizId}/orders`;
const declare = (s: Session, currency: string) => app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion: null } });
const openRegister = (s: Session, openingCash = 0) => app.inject({ method: 'POST', url: sessionsUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash } });
const createOrder = (s: Session) => app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const addLine = (s: Session, orderId: string, unitPrice: number) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Item', quantity: 1, unitPrice } });
const complete = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/complete`, headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const getOrder = (s: Session, orderId: string) => app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}/${orderId}`, headers: hdr(s) });
const cash = (amountTendered: number, reference?: string) => ({ method: 'cash', amountTendered, ...(reference ? { reference } : {}) });
const paymentRows = async (orderId: string) => (await adminPool.query(`SELECT position, method, amount_tendered::float8 AS tendered, amount_applied::float8 AS applied, change_given::float8 AS change, reference FROM business_operations.order_payments WHERE order_id = $1 ORDER BY position`, [orderId])).rows;

/** A business with a declared currency, an open register and one order with a single line of the given price. */
async function ready(currency: string, price: number, openingCash = 0): Promise<{ s: Session; sessionId: string; orderId: string }> {
  const s = await setup('owner');
  expect((await declare(s, currency)).statusCode).toBe(201);
  const reg = await openRegister(s, openingCash);
  expect(reg.statusCode).toBe(201);
  const order = (await createOrder(s)).json();
  expect((await addLine(s, order.id, price)).statusCode).toBe(200);
  return { s, sessionId: reg.json().id, orderId: order.id };
}

const discountUrl = (s: Session, orderId: string) => `${ordersUrl(s.bizId)}/${orderId}/discounts`;
const discount = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: discountUrl(s, orderId), headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const removeLine = (s: Session, orderId: string, lineId: string) => app.inject({ method: 'DELETE', url: `${ordersUrl(s.bizId)}/${orderId}/line-items/${lineId}`, headers: hdr(s, { 'idempotency-key': uc('key') }) });
const discountRows = async (orderId: string) => (await adminPool.query(`SELECT item_type, description, quantity::float8 AS qty, unit_price::float8 AS unit, line_total::float8 AS total FROM business_operations.order_line_items WHERE order_id = $1 AND item_type = 'discount' ORDER BY line_number`, [orderId])).rows;
const totalOf = async (orderId: string) => Number((await adminPool.query(`SELECT total_amount::float8 AS t FROM platform.orders WHERE id = $1`, [orderId])).rows[0].t);

/** Another user in the SAME tenant, workspace and business as `s`, holding the given role (the cashier, the manager, ...). */
async function joinAs(s: Session, role: string | { permissions: string[] }): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const ctx: TenantContext = { ...s.ctx, userId };
  await grantRole(ctx, userId, role);
  return { ctx, token, bizId: s.bizId };
}

describe.runIf(run)('POS-6b discounts - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('an owner takes an amount off an open order: a signed line, a new server total, the reason in the description', async () => {
    const { s, orderId } = await ready('USD', 10);
    const r = await discount(s, orderId, { amount: 2.5, reason: 'Staff meal' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ totalAmount: 7.5, operationalStatus: 'planned' });
    const line = r.json().lineItems.find((l: any) => l.itemType === 'discount');
    expect(line).toMatchObject({ description: 'Discount: Staff meal', quantity: 1, unitPrice: -2.5, lineTotal: -2.5, productId: null });
    expect(await discountRows(orderId)).toEqual([{ item_type: 'discount', description: 'Discount: Staff meal', qty: 1, unit: -2.5, total: -2.5 }]);
    expect(await totalOf(orderId)).toBe(7.5);
  });

  it('KWD is exact to the fil; the discounted total is what is paid; the sale does not count the discount as a unit sold', async () => {
    const { s, orderId } = await ready('KWD', 4.25);
    expect((await discount(s, orderId, { amount: 0.125 })).json().totalAmount).toBe(4.125);
    const done = await complete(s, orderId, { payments: [cash(5)] });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ operationalStatus: 'completed', totalAmount: 4.125, changeDue: 0.875 });
    expect(await paymentRows(orderId)).toEqual([{ position: 1, method: 'cash', tendered: 5, applied: 4.125, change: 0.875, reference: null }]);
    const sale = await adminPool.query(`SELECT amount::float8 AS amount, quantity::float8 AS quantity FROM business_operations.business_events WHERE business_id = $1 AND event_type = 'sale' AND notes LIKE $2`, [s.bizId, 'Order %']);
    expect(sale.rows).toEqual([{ amount: 4.125, quantity: 1 }]);   // one product line; the discount line is money off, not a unit
  });

  it('only owners and admins may discount: a member (cashier), a viewer and a bo:write-only role are refused with 403 and nothing is stored', async () => {
    const { s, orderId } = await ready('USD', 10);
    for (const role of ['member', 'viewer', { permissions: ['bo:read', 'bo:write'] }] as const) {
      const who = await joinAs(s, role as any);
      const r = await discount(who, orderId, { amount: 1 });
      expect(r.statusCode, JSON.stringify(role)).toBe(403);
    }
    expect(await discountRows(orderId)).toEqual([]);
    expect(await totalOf(orderId)).toBe(10);
    const admin = await joinAs(s, 'admin');
    expect((await discount(admin, orderId, { amount: 1 })).statusCode).toBe(200);
    expect(await totalOf(orderId)).toBe(9);
  });

  it('refuses a bad discount with 400: more than the total, zero, negative, too many decimals for the currency, unknown fields, an over-long reason', async () => {
    const { s, orderId } = await ready('USD', 10);
    for (const body of [{ amount: 10.01 }, { amount: 0 }, { amount: -1 }, { amount: 0.125 }, { amount: 1, extra: true }, { amount: 1, reason: 'x'.repeat(201) }, {}]) {
      expect((await discount(s, orderId, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await discountRows(orderId)).toEqual([]);
    expect(await totalOf(orderId)).toBe(10);
    const jpy = await ready('JPY', 1000);
    expect((await discount(jpy.s, jpy.orderId, { amount: 150.5 })).statusCode).toBe(400);
    expect((await discount(jpy.s, jpy.orderId, { amount: 150 })).json().totalAmount).toBe(850);
  });

  it('a discount can take the whole order; a zero-total order completes with no payment', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await discount(s, orderId, { amount: 10 })).json().totalAmount).toBe(0);
    expect((await discount(s, orderId, { amount: 0.01 })).statusCode).toBe(400);   // nothing left to take off
    const done = await complete(s, orderId, { payments: [] });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ operationalStatus: 'completed', totalAmount: 0, payments: [] });
  });

  it('at most five discounts per order', async () => {
    const { s, orderId } = await ready('USD', 100);
    for (let i = 0; i < 5; i += 1) expect((await discount(s, orderId, { amount: 1 })).statusCode).toBe(200);
    expect((await discount(s, orderId, { amount: 1 })).statusCode).toBe(400);
    expect(await totalOf(orderId)).toBe(95);
  });

  it('a completed or voided order cannot be discounted (409)', async () => {
    const { s, orderId } = await ready('USD', 10);
    expect((await complete(s, orderId, { payments: [cash(10)] })).statusCode).toBe(200);
    expect((await discount(s, orderId, { amount: 1 })).statusCode).toBe(409);
    expect(await discountRows(orderId)).toEqual([]);
  });

  it('removing a product line that would leave the discounts larger than the order is refused (409) and changes nothing; removing the discount first works', async () => {
    const { s, orderId } = await ready('USD', 10);
    const lineId = (await getOrder(s, orderId)).json().lineItems[0].id as string;
    const second = await addLine(s, orderId, 1);
    expect(second.statusCode).toBe(200);                                   // total 11
    const d = await discount(s, orderId, { amount: 8 });                    // total 3
    expect(d.json().totalAmount).toBe(3);
    const discountLineId = d.json().lineItems.find((l: any) => l.itemType === 'discount').id;
    const refused = await removeLine(s, orderId, lineId);                   // would leave 1 - 8 = -7
    expect(refused.statusCode).toBe(409);
    expect(await totalOf(orderId)).toBe(3);
    expect((await getOrder(s, orderId)).json().lineItems).toHaveLength(3);
    expect((await removeLine(s, orderId, discountLineId)).json().totalAmount).toBe(11);
    expect((await removeLine(s, orderId, lineId)).json().totalAmount).toBe(1);
  });

  it('the generic add-line route no longer accepts item type discount (400); the discount route is the only way', async () => {
    const { s, orderId } = await ready('USD', 10);
    const r = await app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Sneaky', quantity: 1, unitPrice: 1, itemType: 'discount' } });
    expect(r.statusCode).toBe(400);
    expect(await discountRows(orderId)).toEqual([]);
  });

  it('the same Idempotency-Key replays instead of discounting twice; a missing key is refused', async () => {
    const { s, orderId } = await ready('USD', 10);
    const key = uc('same');
    const first = await discount(s, orderId, { amount: 1 }, key);
    const again = await discount(s, orderId, { amount: 1 }, key);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect((await discountRows(orderId))).toHaveLength(1);
    expect(await totalOf(orderId)).toBe(9);
    const none = await app.inject({ method: 'POST', url: discountUrl(s, orderId), headers: hdr(s), payload: { amount: 1 } });
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
    expect((await discountRows(orderId))).toHaveLength(1);
  });

  it('discounts sent at the same moment cannot together take the total below zero (the order row is locked): 8 x 4.00 off a 10.00 order -> exactly two succeed', async () => {
    const { s, orderId } = await ready('USD', 10);
    const results = await Promise.all(Array.from({ length: 8 }, () => discount(s, orderId, { amount: 4 })));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.filter((c) => c === 400)).toHaveLength(6);
    expect(await totalOf(orderId)).toBe(2);
    expect(await discountRows(orderId)).toHaveLength(2);
  });

  it("another tenant cannot discount this order: it is not found (404) and nothing changes", async () => {
    const { orderId } = await ready('USD', 10);
    const other = await setup('owner');
    const r = await discount(other, orderId, { amount: 1 });
    expect(r.statusCode).toBe(404);
    expect(await discountRows(orderId)).toEqual([]);
  });
});
