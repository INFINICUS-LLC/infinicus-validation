/**
 * POS2-04 decision gate - CURRENT-STATE TRIPWIRE (characterization, not new behaviour). It pins the facts the POS2-04 decision record rests on, on live
 * PostgreSQL + the real Fastify application: completing a POS sale changes no stock today, a POS catalogue line carries no inventory association, and the
 * catalogue has no inventory link. These tests are meant to be replaced, consciously, by the POS2-04 tests once the owner rules (see
 * docs/implementation-queue/POS2-04-INVENTORY-SALE-EFFECT-DECISION-RECORD.md). Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures).
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
const openRegister = (s: Session, openingCash = 0) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash } });
const closeRegister = (s: Session, sessionId: string, closingCash = 0) => app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions/${sessionId}/close`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { closingCash } });
/** Declare a currency and open the register (orders need both). */
const declareAndOpen = async (s: Session, currency: string): Promise<string> => {
  expect((await declare(s, currency)).statusCode).toBe(201);
  const r = await openRegister(s);
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};

const ordersUrl = (bizId: string) => `/v1/businesses/${bizId}/orders`;
const declare = (s: Session, currency: string) => app.inject({ method: 'PUT', url: `/v1/businesses/${s.bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency, expectedVersion: null } });
const stockRows = async (bizId: string) => (await adminPool.query(
  `SELECT (SELECT count(*) FROM business_operations.inventory_movements WHERE business_id=$1)::int AS movements, (SELECT count(*) FROM business_operations.inventory_balances WHERE business_id=$1)::int AS balances`, [bizId])).rows[0];

describe.runIf(run)('POS2-04 decision gate: current state of the sale -> inventory path - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await adminPool?.end(); await closePool(); });

  it('completing a sale (a catalogue line and a free-text line) records the completion evidence but changes no stock; the catalogue line carries no inventory association', async () => {
    const s = await setup('owner');
    expect((await declare(s, 'KWD')).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash: 0 } })).statusCode).toBe(201);
    // A tracked-looking stock item exists for the business (created directly: no POS path creates stock), so "no movement" cannot be because there is nothing to move.
    const item = (await adminPool.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,'Tea leaves') RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, uc('sku')])).rows[0].id as string;
    const product = await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/products`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { name: 'Tea', price: 1.5 } });
    expect(product.statusCode).toBeLessThan(300);
    const order = await app.inject({ method: 'POST', url: ordersUrl(s.bizId), headers: hdr(s, { 'idempotency-key': uc('key') }), payload: {} });
    const orderId = order.json().id as string;
    const lineUrl = `${ordersUrl(s.bizId)}/${orderId}/line-items`;
    expect((await app.inject({ method: 'POST', url: lineUrl, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { catalogProductId: product.json().id, quantity: 2.5 } })).statusCode).toBeLessThan(300);
    expect((await app.inject({ method: 'POST', url: lineUrl, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { description: 'Delivery', quantity: 1, unitPrice: 1 } })).statusCode).toBeLessThan(300);
    const before = await stockRows(s.bizId);
    const done = await app.inject({ method: 'POST', url: `${ordersUrl(s.bizId)}/${orderId}/complete`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { payments: [{ method: 'cash', amountTendered: 4.75 }] } });
    expect(done.statusCode).toBe(200);
    expect(done.json().operationalStatus).toBe('completed');

    // the completion evidence that is the sale authority exists ...
    const events = (await adminPool.query(`SELECT event_type, new_status FROM business_operations.order_events WHERE order_id=$1 ORDER BY created_at`, [orderId])).rows;
    expect(events.some((e) => e.event_type === 'completed' && e.new_status === 'completed')).toBe(true);
    expect(Number((await adminPool.query(`SELECT count(*) n FROM business_operations.business_events WHERE business_id=$1 AND event_type='sale'`, [s.bizId])).rows[0].n)).toBe(1);
    // ... and no stock moved (nothing links the sale to inventory today)
    expect(await stockRows(s.bizId)).toEqual(before);
    expect(before).toEqual({ movements: 0, balances: 0 });
    // the catalogue line has no canonical product, so nothing can resolve it to the stock item
    const lines = (await adminPool.query(`SELECT description, product_id, quantity FROM business_operations.order_line_items WHERE order_id=$1 ORDER BY line_number`, [orderId])).rows;
    expect(lines.map((l) => l.product_id)).toEqual([null, null]);
    expect(Number(lines[0].quantity)).toBe(2.5);
    expect((await adminPool.query(`SELECT 1 FROM platform.inventory_items WHERE id=$1 AND product_id IS NULL`, [item])).rowCount).toBe(1);
  });

  it('the POS catalogue has no inventory link of any kind (the mapping POS2-04 needs does not exist yet)', async () => {
    const cols = (await adminPool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='products' ORDER BY ordinal_position`)).rows.map((r) => r.column_name as string);
    expect(cols.filter((c) => /inventory|stock|sku|warehouse|item/i.test(c))).toEqual([]);
    const tables = (await adminPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='business_operations' AND table_name ~ '(sale|pos).*(inventory|stock|effect)|(inventory|stock).*(sale|pos)'`)).rows;
    expect(tables).toEqual([]);
  });

  it('the stock ledger refuses a later change to a movement (append-only), so a correction can only be a new compensating movement', async () => {
    const s = await setup('owner');
    const item = (await adminPool.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,'Beans') RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, uc('sku')])).rows[0].id as string;
    const wh = (await adminPool.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'Main') RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, uc('wh')])).rows[0].id as string;
    const mv = (await adminPool.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id) VALUES ($1,$2,$3,$4,$5,'issue',1,'order_line',$6) RETURNING id`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, item, wh, randomUUID()])).rows[0].id as string;
    await expect(adminPool.query(`UPDATE business_operations.inventory_movements SET quantity = 2 WHERE id=$1`, [mv])).rejects.toThrow(/append-only/);
    // (DELETE and TRUNCATE refusal is covered by the existing append-only tests; a raw DELETE is not repeated here, per the repository's test-hygiene guard.)
    // the ledger has NO uniqueness on (reference_type, reference_id): the same order-line reference can be inserted twice, so at-most-once has no existing mechanism
    const ref = randomUUID();
    const ins = () => adminPool.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id) VALUES ($1,$2,$3,$4,$5,'issue',1,'order_line',$6)`, [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, item, wh, ref]);
    await ins(); await expect(ins()).resolves.toBeDefined();
  });
});

describe.skipIf(run)('POS2-04 decision gate tripwire (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
