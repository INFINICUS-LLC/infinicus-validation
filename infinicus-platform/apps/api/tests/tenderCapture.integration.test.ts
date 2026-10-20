/**
 * POS-5: tender capture (migrations 0203-0206). Payments are recorded inside the transaction that completes an order; the applied amounts equal the
 * order total exactly; cash change is exact in the currency; the ledger is append-only and the database refuses inconsistent payments.
 * Live PostgreSQL + real Fastify application (RLS enforced for the app role). Requires DATABASE_URL and ADMIN_DATABASE_URL, migrated through 0206.
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
const closeRegister = (s: Session, sessionId: string, closingCash: number) => app.inject({ method: 'POST', url: `${sessionsUrl(s.bizId)}/${sessionId}/close`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { closingCash } });
const summary = (s: Session, sessionId: string) => app.inject({ method: 'GET', url: `${sessionsUrl(s.bizId)}/${sessionId}/summary`, headers: hdr(s) });
const createOrder = (s: Session) => app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
const addLine = (s: Session, orderId: string, unitPrice: number) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Item', quantity: 1, unitPrice } });
const complete = (s: Session, orderId: string, body: unknown, key = uc('key')) => app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/complete`, headers: hdr(s, { 'idempotency-key': key }), payload: body as any });
const getOrder = (s: Session, orderId: string) => app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}/${orderId}`, headers: hdr(s) });
const cash = (amountTendered: number, reference?: string) => ({ method: 'cash', amountTendered, ...(reference ? { reference } : {}) });
const card = (amountTendered: number, reference?: string) => ({ method: 'card', amountTendered, ...(reference ? { reference } : {}) });
const paymentRows = async (orderId: string) => (await adminPool.query(`SELECT position, method, amount_tendered::float8 AS tendered, amount_applied::float8 AS applied, change_given::float8 AS change, reference FROM business_operations.order_payments WHERE order_id = $1 ORDER BY position`, [orderId])).rows;
const paymentCount = async (bizId: string) => Number((await adminPool.query(`SELECT count(*)::int n FROM business_operations.order_payments WHERE business_id = $1`, [bizId])).rows[0].n);
const statusOf = async (orderId: string) => (await adminPool.query(`SELECT operational_status FROM platform.orders WHERE id = $1`, [orderId])).rows[0].operational_status as string;

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

describe.runIf(run)('POS-5 tender capture - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('POS-6d reads the canonical summary beyond the first page using BO read alone', async () => {
    const s = await setup({ permissions: ['bo:read'] });
    await adminPool.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status)
      SELECT $1,$2,'AA Earlier ' || n,$3 || n,'active' FROM generate_series(1,25) n`, [s.ctx.tenantId, s.ctx.workspaceId, uc('earlier')]);
    const list = await app.inject({ method: 'GET', url: '/v1/businesses?page=1&pageSize=20', headers: hdr(s) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((b: any) => b.id === s.bizId)).toBe(false);
    const result = await app.inject({ method: 'GET', url: '/v1/businesses/' + s.bizId, headers: hdr(s) });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ id: s.bizId, legalName: 'ZZ TN Biz', businessCode: expect.any(String), status: 'active', industry: null });
  });

  it('POS-6d refuses unauthenticated, unprivileged, foreign-tenant and foreign-workspace summary reads', async () => {
    const s = await setup({ permissions: ['bo:read'] });
    const url = '/v1/businesses/' + s.bizId;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const noRead = await setup({ permissions: ['bo:write'] });
    expect((await app.inject({ method: 'GET', url: '/v1/businesses/' + noRead.bizId, headers: hdr(noRead) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: hdr(noRead) })).statusCode).toBe(403);
    const other = await setup({ permissions: ['bo:read'] });
    expect((await app.inject({ method: 'GET', url, headers: hdr(other) })).statusCode).toBe(404);
    const workspaceId = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'Other',$3,'active')`, [workspaceId, s.ctx.tenantId, uc('other-ws')]);
    const sibling = { ...s, ctx: { ...s.ctx, workspaceId } };
    await grantRole(sibling.ctx, s.ctx.userId, { permissions: ['bo:read'] });
    expect((await app.inject({ method: 'GET', url, headers: hdr(sibling) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/businesses/not-a-uuid', headers: hdr(s) })).statusCode).toBe(400);
    await adminPool.query('UPDATE platform.businesses SET deleted_at = now() WHERE id = $1', [s.bizId]);
    expect((await app.inject({ method: 'GET', url, headers: hdr(s) })).statusCode).toBe(404);
  });

  it('POS-6c records three entered tenders once and reconciles only applied cash, with KWD change', async () => {
    const { s, orderId, sessionId } = await ready('KWD', 1.375);
    const payments = [card(0.5, 'SLIP-6C'), { method: 'other', amountTendered: 0.25 }, cash(1)];
    const key = uc('split-checkout');
    const result = await complete(s, orderId, { payments }, key);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ operationalStatus: 'completed', totalAmount: 1.375, changeDue: 0.375 });
    expect(await paymentRows(orderId)).toEqual([
      { position: 1, method: 'card', tendered: 0.5, applied: 0.5, change: 0, reference: 'SLIP-6C' },
      { position: 2, method: 'other', tendered: 0.25, applied: 0.25, change: 0, reference: null },
      { position: 3, method: 'cash', tendered: 1, applied: 0.625, change: 0.375, reference: null },
    ]);
    expect((await complete(s, orderId, { payments }, key)).json()).toEqual(result.json());
    expect(await paymentCount(s.bizId)).toBe(3);
    expect((await summary(s, sessionId)).json()).toMatchObject({ tenders: { card: 0.5, other: 0.25, cash: 0.625 }, expectedCash: 0.625 });
  });

  it('POS-6b pages completed sales without skipping equal timestamps or duplicating rows when a new sale arrives', async () => {
    const { s, orderId } = await ready('KWD', 1.375);
    expect((await complete(s, orderId, { payments: [cash(2)] })).statusCode).toBe(200);
    const ids = [orderId];
    for (let n = 0; n < 6; n++) {
      const created = await createOrder(s); expect(created.statusCode).toBe(201);
      const id = created.json().id; ids.push(id);
      expect((await addLine(s, id, 1.375)).statusCode).toBe(200);
      expect((await complete(s, id, { payments: [cash(2)] })).statusCode).toBe(200);
    }
    // Identical timestamps with sub-millisecond precision exercise the ID tie-breaker and prevent JS Date truncation from hiding rows.
    await adminPool.query(`UPDATE platform.orders SET created_at = '2026-01-01T00:00:00.123456Z' WHERE id = ANY($1::uuid[])`, [ids]);
    const first = await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed&limit=2`, headers: hdr(s) });
    expect(first.statusCode).toBe(200);
    const expected = [...ids].sort().reverse();
    expect(first.json().orders.map((o: { id: string }) => o.id)).toEqual(expected.slice(0, 2));
    const newer = (await createOrder(s)).json().id;
    await addLine(s, newer, 2); await complete(s, newer, { payments: [cash(2)] });
    const seen: string[] = first.json().orders.map((o: { id: string }) => o.id);
    for (let page = 0; page < 5; page++) {
      const next = await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed&limit=2&before=${seen.at(-1)}`, headers: hdr(s) });
      expect(next.statusCode).toBe(200);
      const rows = next.json().orders as { id: string; operationalStatus: string; currencyCode: string; totalAmount: number }[];
      expect(rows.every(row => row.operationalStatus === 'completed' && row.currencyCode === 'KWD' && row.totalAmount === 1.375)).toBe(true);
      if (rows.length === 0) break;
      seen.push(...rows.map(row => row.id));
    }
    expect(seen).toEqual(expected);
    const refreshed = await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed&limit=2`, headers: hdr(s) });
    expect(refreshed.json().orders[0].id).toBe(newer);
    const detail = (await getOrder(s, orderId)).json();
    expect(detail.lineItems).toHaveLength(1); expect(detail.payments).toHaveLength(1);
    expect(detail).toMatchObject({ totalAmount: 1.375, changeDue: 0.625 });
  });

  it('POS-6b cursors are business/tenant-scoped, invalid IDs are refused and viewers may read history', async () => {
    const { s, orderId } = await ready('USD', 1);
    const another = await ready('USD', 1);
    const otherBusiness = await adminPool.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,'Other history business',$3) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, uc('hist')]);
    const foreign = await adminPool.query(`INSERT INTO platform.orders (tenant_id, workspace_id, business_id, order_number, order_date) VALUES ($1,$2,$3,$4,CURRENT_DATE) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, otherBusiness.rows[0].id, uc('hist-order')]);
    for (const cursor of [another.orderId, foreign.rows[0].id, randomUUID()]) {
      expect((await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed&before=${cursor}`, headers: hdr(s) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?before=invalid`, headers: hdr(s) })).statusCode).toBe(400);
    const viewer = await registerActiveUser(); await grantRole(s.ctx, viewer.userId, 'viewer');
    expect((await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed&before=${orderId}`, headers: hdr({ ctx: s.ctx, token: viewer.token }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${ordersUrl(s.bizId)}?status=completed` })).statusCode).toBe(401);
  });

  it('selects the BO catalog by its own ID, snapshots server pricing and records catalog provenance', async () => {
    const { s, orderId } = await ready('KWD', 1);
    const product = await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/products`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { name: 'Espresso', price: 1.375 } });
    expect(product.statusCode).toBe(201);
    const productId = product.json().id;
    const path = `${ordersUrl(s.bizId)}/${orderId}/line-items`;
    const key = uc('catalog');
    const request = { method: 'POST' as const, url: path, headers: hdr(s, { 'idempotency-key': key }), payload: { catalogProductId: productId, quantity: 2 } };
    const result = await app.inject(request);
    expect(result.statusCode).toBe(200);
    const line = result.json().lineItems.at(-1);
    expect(line).toMatchObject({ productId: null, description: 'Espresso', quantity: 2, unitPrice: 1.375, lineTotal: 2.75 });
    expect((await app.inject(request)).json()).toEqual(result.json());
    const events = await adminPool.query(`SELECT payload FROM business_operations.order_events WHERE order_id = $1 AND payload->>'kind' = 'catalog_line_added'`, [orderId]);
    expect(events.rows).toEqual([{ payload: { kind: 'catalog_line_added', catalogProductId: productId, lineItemId: line.id } }]);
    // A cached tile cannot override the price or smuggle a canonical product identity.
    expect((await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { ...request.payload, unitPrice: 0 } })).statusCode).toBe(400);
    await adminPool.query(`UPDATE business_operations.products SET active = false WHERE id = $1`, [productId]);
    expect((await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }) })).statusCode).toBe(404);
  });

  it('rejects a catalog selection from another business in the same workspace', async () => {
    const { s, orderId, sessionId } = await ready('USD', 1);
    const another = await adminPool.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,'Other',$3) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, uc('other')]);
    const product = await adminPool.query(`INSERT INTO business_operations.products (tenant_id, workspace_id, business_id, name, price) VALUES ($1,$2,$3,'Other product',5) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, another.rows[0].id]);
    expect((await app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { catalogProductId: product.rows[0].id, quantity: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/businesses/${s.bizId}/products/${product.rows[0].id}`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { price: 0 } })).statusCode).toBe(404);
    expect((await closeRegister({ ...s, bizId: another.rows[0].id }, sessionId, 0)).statusCode).toBe(404);
    expect(Number((await adminPool.query(`SELECT price FROM business_operations.products WHERE id = $1`, [product.rows[0].id])).rows[0].price)).toBe(5);
    expect((await getOrder(s, orderId)).json().lineItems).toHaveLength(1);
  });

  it('refuses every order read/mutation through the wrong business URL, including within one workspace', async () => {
    const { s, orderId } = await ready('USD', 2);
    const lineId = (await getOrder(s, orderId)).json().lineItems[0].id;
    const other = await adminPool.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,'Other',$3) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, uc('other')]);
    const base = `${ordersUrl(other.rows[0].id)}/${orderId}`;
    const requests = [
      { method: 'GET' as const, url: base },
      { method: 'POST' as const, url: `${base}/line-items`, payload: { description: 'Forged', quantity: 1, unitPrice: 2 } },
      { method: 'DELETE' as const, url: `${base}/line-items/${lineId}` },
      { method: 'POST' as const, url: `${base}/line-items/${lineId}/quantity`, payload: { quantity: 2 } },
      { method: 'POST' as const, url: `${base}/void`, payload: {} },
      { method: 'POST' as const, url: `${base}/complete`, payload: { payments: [cash(10)] } },
    ];
    for (const request of requests) expect((await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }) })).statusCode, request.url).toBe(404);
    expect((await getOrder(s, orderId)).json()).toMatchObject({ operationalStatus: 'planned', totalAmount: 2 });
    expect(await paymentCount(s.bizId)).toBe(0);
  });

  it('sets quantities atomically with currency rounding, replays retries and retains captured discounts/tax', async () => {
    const { s, orderId } = await ready('KWD', 1.375);
    const lineId = (await getOrder(s, orderId)).json().lineItems[0].id;
    const url = `${ordersUrl(s.bizId)}/${orderId}/line-items/${lineId}/quantity`;
    const key = uc('qty');
    const request = { method: 'POST' as const, url, headers: hdr(s, { 'idempotency-key': key }), payload: { quantity: 3 } };
    const changed = await app.inject(request);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ totalAmount: 4.125 });
    expect(changed.json().lineItems[0]).toMatchObject({ id: lineId, quantity: 3, unitPrice: 1.375, lineTotal: 4.125 });
    expect((await app.inject(request)).json()).toEqual(changed.json());
    expect((await app.inject({ ...request, payload: { quantity: 4 } })).statusCode).toBe(409);
    for (const quantity of [0, -1, 0.00001, 1_000_000_001]) {
      expect((await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { quantity } })).statusCode).toBe(400);
    }
    await adminPool.query(`UPDATE business_operations.order_line_items SET discount_rate = 0.1, tax_rate = 0.05 WHERE id = $1`, [lineId]);
    const adjusted = await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { quantity: 2 } });
    expect(adjusted.json().totalAmount).toBe(2.599);
    expect((await complete(s, orderId, { payments: [cash(3)] })).statusCode).toBe(200);
    expect((await app.inject({ ...request, headers: hdr(s, { 'idempotency-key': uc('key') }) })).statusCode).toBe(409);
    expect((await getOrder(s, orderId)).json()).toMatchObject({ totalAmount: 2.599, changeDue: 0.401 });
  });

  it('quantity writes require permission and an idempotency key; foreign lines and tenants remain inaccessible', async () => {
    const { s, orderId } = await ready('USD', 1);
    const lineId = (await getOrder(s, orderId)).json().lineItems[0].id;
    const url = `${ordersUrl(s.bizId)}/${orderId}/line-items/${lineId}/quantity`;
    expect((await app.inject({ method: 'POST', url, headers: hdr(s), payload: { quantity: 2 } })).statusCode).toBe(400);
    const viewer = await registerActiveUser();
    await grantRole(s.ctx, viewer.userId, 'viewer');
    expect((await app.inject({ method: 'POST', url, headers: hdr({ ctx: s.ctx, token: viewer.token }, { 'idempotency-key': uc('key') }), payload: { quantity: 2 } })).statusCode).toBe(403);
    const another = await setup();
    expect((await app.inject({ method: 'POST', url, headers: hdr(another, { 'idempotency-key': uc('key') }), payload: { quantity: 2 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items/${randomUUID()}/quantity`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { quantity: 2 } })).statusCode).toBe(404);
  });

  it('serializes competing complete/void requests: one terminal result, at most one sale and payment', async () => {
    const { s, orderId } = await ready('USD', 2);
    const results = await Promise.all([
      complete(s, orderId, { payments: [cash(10)] }),
      app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/void`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { reason: 'Cancel' } }),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const order = (await getOrder(s, orderId)).json();
    const count = Number((await adminPool.query(`SELECT count(*) n FROM business_operations.business_events WHERE correlation_id = $1 AND event_type = 'sale'`, [orderId])).rows[0].n);
    expect(count).toBe(order.operationalStatus === 'completed' ? 1 : 0);
    expect(order.payments).toHaveLength(count);
  });

  it('serializes cart edits with completion so the sale, total and payment describe the same cart', async () => {
    const { s, orderId } = await ready('KWD', 1.375);
    const lineId = (await getOrder(s, orderId)).json().lineItems[0].id;
    const results = await Promise.all([
      app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/line-items/${lineId}/quantity`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { quantity: 2 } }),
      complete(s, orderId, { payments: [cash(10)] }),
    ]);
    expect(results[1].statusCode).toBe(200);
    expect([200, 409]).toContain(results[0].statusCode);
    const order = (await getOrder(s, orderId)).json();
    expect(order.totalAmount).toBe(order.lineItems[0].lineTotal);
    expect(order.payments[0].amountApplied).toBe(order.totalAmount);
    expect(Number((await adminPool.query(`SELECT amount FROM business_operations.business_events WHERE correlation_id = $1 AND event_type = 'sale'`, [orderId])).rows[0].amount)).toBe(order.totalAmount);
  });

  it('serializes register close with cash completion so counted cash never omits a committed sale', async () => {
    const { s, orderId, sessionId } = await ready('USD', 2, 10);
    const [sale, close] = await Promise.all([complete(s, orderId, { payments: [cash(5)] }), closeRegister(s, sessionId, 12)]);
    expect(close.statusCode).toBe(200);
    expect([200, 409]).toContain(sale.statusCode);
    const stored = (await getOrder(s, orderId)).json();
    expect(close.json().expectedCash).toBe(10 + stored.payments.reduce((sum: number, p: { amountApplied: number }) => sum + p.amountApplied, 0));
  });

  it('the migrations are recorded and the table is row-level-secured (forced) with its policy', async () => {
    const rec = await adminPool.query(`SELECT filename FROM _migrations WHERE filename ~ '^020[3-6]_' ORDER BY filename`);
    expect(rec.rows.map((r) => r.filename)).toEqual(['0203_create_order_payments.sql', '0204_create_order_payments_indexes.sql', '0205_create_order_payments_rls.sql', '0206_order_payments_append_only_and_consistency.sql']);
    const rls = await adminPool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'business_operations.order_payments'::regclass`);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await adminPool.query(`SELECT count(*)::int n FROM pg_policies WHERE tablename = 'order_payments' AND policyname = 'order_payments_isolation'`)).rows[0].n).toBe(1);
  });

  it('cash over the total: the sale is applied exactly and the change is returned (USD)', async () => {
    const { s, orderId } = await ready('USD', 4.5);
    const r = await complete(s, orderId, { payments: [cash(5)] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ operationalStatus: 'completed', totalAmount: 4.5, changeDue: 0.5 });
    expect(r.json().payments).toHaveLength(1);
    expect(r.json().payments[0]).toMatchObject({ position: 1, method: 'cash', currencyCode: 'USD', amountTendered: 5, amountApplied: 4.5, changeGiven: 0.5, reference: null });
    expect(await paymentRows(orderId)).toEqual([{ position: 1, method: 'cash', tendered: 5, applied: 4.5, change: 0.5, reference: null }]);
    expect((await getOrder(s, orderId)).json().payments).toHaveLength(1);   // reading the order later shows its tender
  });

  it('KWD is exact to the fil: 1.375 due, 2 handed over, 0.625 back', async () => {
    const { s, orderId } = await ready('KWD', 1.375);
    const r = await complete(s, orderId, { payments: [cash(2)] });
    expect(r.statusCode).toBe(200);
    expect(r.json().payments[0]).toMatchObject({ amountTendered: 2, amountApplied: 1.375, changeGiven: 0.625 });
    expect(r.json().changeDue).toBe(0.625);
  });

  it('split tender: card for part, cash for the rest with change; applied adds up to the total', async () => {
    const { s, orderId } = await ready('USD', 10);
    const r = await complete(s, orderId, { payments: [card(4, 'SLIP-0042'), cash(20)] });
    expect(r.statusCode).toBe(200);
    expect(await paymentRows(orderId)).toEqual([
      { position: 1, method: 'card', tendered: 4, applied: 4, change: 0, reference: 'SLIP-0042' },
      { position: 2, method: 'cash', tendered: 20, applied: 6, change: 14, reference: null },
    ]);
    expect(r.json().changeDue).toBe(14);
  });

  it('refusals leave the order open and write nothing: no payment, underpaid, card overpaid, payment after fully paid, zero or bad amounts', async () => {
    const { s, orderId } = await ready('USD', 10);
    for (const body of [{}, { payments: [] }, { payments: [cash(4)] }, { payments: [card(11)] }, { payments: [card(10), cash(1)] }, { payments: [cash(0)] }, { payments: [cash(-5)] },
      { payments: [{ method: 'cheque', amountTendered: 10 }] }, { payments: [cash(10.005)] }]) {
      const r = await complete(s, orderId, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await statusOf(orderId)).toBe('planned');
    expect(await paymentCount(s.bizId)).toBe(0);
    expect((await complete(s, orderId, { payments: [cash(10)] })).statusCode).toBe(200);   // and it can still be completed correctly afterwards
  });

  it('amounts must be exact in the currency: JPY has no decimals, KWD allows three', async () => {
    const jpy = await ready('JPY', 300);
    expect((await complete(jpy.s, jpy.orderId, { payments: [cash(300.5)] })).statusCode).toBe(400);
    expect((await complete(jpy.s, jpy.orderId, { payments: [cash(500)] })).json()).toMatchObject({ changeDue: 200 });
    const kwd = await ready('KWD', 0.125);
    expect((await complete(kwd.s, kwd.orderId, { payments: [cash(0.1255)] })).statusCode).toBe(400);
    expect((await complete(kwd.s, kwd.orderId, { payments: [cash(0.125)] })).statusCode).toBe(200);
  });

  it('an order with a zero total takes no payment; one with a payment is refused', async () => {
    const free = await ready('USD', 0);
    expect((await complete(free.s, free.orderId, { payments: [cash(1)] })).statusCode).toBe(400);
    const r = await complete(free.s, free.orderId, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().payments).toEqual([]);
  });

  it('the reference is a slip number, never a card number: 13+ digits (with spaces or hyphens) are refused, in the API', async () => {
    const { s, orderId } = await ready('USD', 3);
    for (const reference of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', 'x'.repeat(65)]) {
      expect((await complete(s, orderId, { payments: [card(3, reference)] })).statusCode, reference).toBe(400);
    }
    expect(await paymentCount(s.bizId)).toBe(0);
    expect((await complete(s, orderId, { payments: [card(3, 'SLIP 123456')] })).statusCode).toBe(200);
  });

  it('the body cannot carry the currency, the applied amount, the change or anything else: unknown keys are refused', async () => {
    const { s, orderId } = await ready('USD', 3);
    for (const payment of [{ ...cash(3), currencyCode: 'EUR' }, { ...cash(3), amountApplied: 1 }, { ...cash(3), changeGiven: 5 }, { ...cash(3), registerSessionId: randomUUID() }]) {
      expect((await complete(s, orderId, { payments: [payment] })).statusCode, JSON.stringify(payment)).toBe(400);
    }
    expect((await complete(s, orderId, { payments: [cash(3)], tenant: 'x' })).statusCode).toBe(400);
    expect(await paymentCount(s.bizId)).toBe(0);
  });

  it('replaying the same Idempotency-Key records the payments once; a second completion with a new key is a 409 and adds nothing', async () => {
    const { s, orderId } = await ready('USD', 4);
    const key = uc('replay');
    const a = await complete(s, orderId, { payments: [cash(5)] }, key);
    const b = await complete(s, orderId, { payments: [cash(5)] }, key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().payments).toHaveLength(1);
    expect(await paymentCount(s.bizId)).toBe(1);
    expect((await complete(s, orderId, { payments: [cash(5)] })).statusCode).toBe(409);
    expect(await paymentCount(s.bizId)).toBe(1);
  });

  it('two simultaneous completions of one order record one sale and one set of payments', async () => {
    const { s, orderId } = await ready('USD', 6);
    const [x, y] = await Promise.all([complete(s, orderId, { payments: [cash(6)] }), complete(s, orderId, { payments: [cash(6)] })]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect(await paymentCount(s.bizId)).toBe(1);
    expect(Number((await adminPool.query(`SELECT count(*)::int n FROM business_operations.business_events WHERE business_id = $1 AND event_type = 'sale'`, [s.bizId])).rows[0].n)).toBe(1);
  });

  it('the ledger is append-only: UPDATE and DELETE are refused by the database, even for the admin role', async () => {
    const { s, orderId } = await ready('USD', 2);
    await complete(s, orderId, { payments: [cash(2)] });
    await expect(adminPool.query(`UPDATE business_operations.order_payments SET amount_applied = 1, amount_tendered = 1 WHERE order_id = $1`, [orderId])).rejects.toMatchObject({ code: '23000' });
    await expect(adminPool.query(`DELETE FROM business_operations.order_payments WHERE order_id = $1`, [orderId])).rejects.toMatchObject({ code: '23000' });
    expect(await paymentCount(s.bizId)).toBe(1);
  });

  it('the database refuses an inconsistent payment at commit: for a planned order, a surplus payment, a wrong currency and a wrong session', async () => {
    const planned = await ready('USD', 5);
    const done = await ready('USD', 5);
    await complete(done.s, done.orderId, { payments: [cash(5)] });
    const other = await ready('USD', 1);
    const insert = (o: { s: Session; sessionId: string; orderId: string }, over: { session?: string; currency?: string; position?: number } = {}) =>
      `INSERT INTO business_operations.order_payments (tenant_id, workspace_id, business_id, order_id, register_session_id, position, method, currency_code, amount_tendered, amount_applied, change_given)
       VALUES ('${o.s.ctx.tenantId}','${o.s.ctx.workspaceId}','${o.s.bizId}','${o.orderId}','${over.session ?? o.sessionId}',${over.position ?? 1},'cash','${over.currency ?? 'USD'}',5,5,0)`;
    const commitFails = async (sql: string) => {
      const c = await adminPool.connect();
      try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); return null; } catch (e) { await c.query('ROLLBACK').catch(() => undefined); return (e as { code?: string; message?: string }); } finally { c.release(); }
    };
    expect((await commitFails(insert(planned)))?.code).toBe('23000');                                 // order is not completed
    expect((await commitFails(insert(done, { position: 2 })))?.code).toBe('23000');                    // applied would exceed the total
    expect((await commitFails(insert(done, { position: 2, currency: 'EUR' })))?.code).toBe('23000');   // wrong currency
    expect((await commitFails(insert(done, { position: 2, session: other.sessionId })))?.code).toBeDefined();   // other business's session: foreign key
    expect(await paymentCount(planned.s.bizId)).toBe(0);
    expect(await paymentCount(done.s.bizId)).toBe(1);
  });

  it('the database refuses a payment shape that breaks the money rules: change on card, applied above tendered, a card-number reference', async () => {
    const { s, sessionId, orderId } = await ready('USD', 5);
    const row = (method: string, tendered: number, applied: number, change: number, reference: string | null) =>
      adminPool.query(`INSERT INTO business_operations.order_payments (tenant_id, workspace_id, business_id, order_id, register_session_id, position, method, currency_code, amount_tendered, amount_applied, change_given, reference)
        VALUES ($1,$2,$3,$4,$5,1,$6,'USD',$7,$8,$9,$10)`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, orderId, sessionId, method, tendered, applied, change, reference]);
    await expect(row('card', 6, 5, 1, null)).rejects.toMatchObject({ code: '23514' });
    await expect(row('cash', 5, 6, -1, null)).rejects.toMatchObject({ code: '23514' });
    await expect(row('cash', 5, 5, 0, '4111 1111 1111 1111')).rejects.toMatchObject({ code: '23514' });
    await expect(row('cash', 5, 4, 0, null)).rejects.toMatchObject({ code: '23514' });
  });

  it('register reconciliation uses the cash actually applied: card is not cash, change is excluded, the summary shows the tenders', async () => {
    const s = await setup('owner');
    await declare(s, 'USD');
    const reg = (await openRegister(s, 100)).json();
    const o1 = (await createOrder(s)).json(); await addLine(s, o1.id, 4.5); await complete(s, o1.id, { payments: [cash(5)] });     // drawer +4.50 (0.50 change given back)
    const o2 = (await createOrder(s)).json(); await addLine(s, o2.id, 3); await complete(s, o2.id, { payments: [card(3)] });         // not cash
    const o3 = (await createOrder(s)).json(); await addLine(s, o3.id, 2); await addLine(s, o3.id, 1);
    await complete(s, o3.id, { payments: [{ method: 'other', amountTendered: 1 }, cash(2)] });                                        // other 1, cash 2
    const sum = (await summary(s, reg.id)).json();
    expect(sum).toMatchObject({ ordersCompleted: 3, completedSalesTotal: 10.5, tenders: { cash: 6.5, card: 3, other: 1 }, expectedCash: 106.5 });
    const closed = await closeRegister(s, reg.id, 106);
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'closed', expectedCash: 106.5, variance: -0.5 });
  });

  it('a register opened before 0202 (no currency) keeps the old reconciliation: every sale of the business counts as cash', async () => {
    const s = await setup('owner');
    await declare(s, 'USD');
    const legacy = randomUUID();
    await adminPool.query(`INSERT INTO business_operations.register_sessions (id, tenant_id, workspace_id, business_id, opening_cash, status, currency_code) VALUES ($1,$2,$3,$4,50,'open',NULL)`, [legacy, s.ctx.tenantId, s.ctx.workspaceId, s.bizId]);
    await adminPool.query(`INSERT INTO business_operations.business_events (tenant_id, workspace_id, business_id, event_type, amount) VALUES ($1,$2,$3,'sale',7)`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId]);
    const closed = await closeRegister(s, legacy, 57);
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ expectedCash: 57, variance: 0 });
  });
});
