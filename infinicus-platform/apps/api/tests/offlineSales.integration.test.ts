/**
 * OFF-1 step 4: POST /v1/businesses/:businessId/offline-sales - live PostgreSQL + the real Fastify application (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection), migrated through 0210.
 * Two applications are built: one with the DEFAULT configuration (offline selling closed) and one with the owner inputs set.
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
const HOUR = 3_600_000;

let adminPool: Pool;
let closedApp: FastifyInstance;
let openApp: FastifyInstance;

interface Session { ctx: TenantContext; token: string; bizId: string; sessionId: string }

async function registerActiveUser(app: FastifyInstance): Promise<{ userId: string; token: string }> {
  const email = `${uc('os')}@os-api.example`;
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
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','os test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole(ctx, m.id, roleId);
}

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});

/** A tenant, a workspace, a business with a declared KWD currency and an open register that was opened hours ago. */
async function setup(app: FastifyInstance, role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser(app);
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'OS API Tenant',$2,'active','test')`, [tenantId, `osa-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'OS API WS',$3,'active')`, [workspaceId, tenantId, `osa-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ OS Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('osa-biz')]);
  const s = { ctx, token, bizId, sessionId: '' };
  if (typeof role === 'string') {
    expect((await app.inject({ method: 'PUT', url: `/v1/businesses/${bizId}/declared-currency`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { currency: 'KWD', expectedVersion: null } })).statusCode).toBe(201);
    const open = await app.inject({ method: 'POST', url: `/v1/businesses/${bizId}/register-sessions`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { openingCash: 0 } });
    expect(open.statusCode).toBe(201);
    s.sessionId = open.json().id;
    await adminPool.query('UPDATE business_operations.register_sessions SET opened_at = $2 WHERE id = $1', [s.sessionId, new Date(Date.now() - 3 * HOUR)]);
  }
  return s;
}

async function product(s: Session, price: number, changedAt = new Date(Date.now() - 2 * HOUR)): Promise<string> {
  const id = randomUUID();
  await adminPool.query(`INSERT INTO business_operations.products (id, tenant_id, workspace_id, business_id, name, price) VALUES ($1,$2,$3,$4,'Item',$5)`, [id, s.ctx.tenantId, s.ctx.workspaceId, s.bizId, price]);
  const c = await adminPool.connect();
  try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('UPDATE business_operations.products SET updated_at = $2 WHERE id = $1', [id, changedAt]); await c.query('COMMIT'); } finally { c.release(); }
  return id;
}

const body = (s: Session, lines: Array<[string, number, number]>, over: Record<string, unknown> = {}, cash?: number) => {
  const total = lines.reduce((sum, [, q, u]) => sum + q * u, 0);
  return {
    clientSaleId: randomUUID(), deviceId: 'tablet-1', registerSessionId: s.sessionId || randomUUID(),
    deviceCreatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), catalogueSnapshotAt: new Date(Date.now() - HOUR).toISOString(), currencyCode: 'KWD',
    lines: lines.map(([productId, quantity, unitPriceShownMinor]) => ({ productId, quantity, unitPriceShownMinor })), provisionalTotalMinor: total,
    tenders: [{ method: 'cash', amountTenderedMinor: cash ?? total }], ...over,
  };
};
const post = (app: FastifyInstance, s: Session, payload: any, key: string | null = payload.clientSaleId, bizId = s.bizId) =>
  app.inject({ method: 'POST', url: `/v1/businesses/${bizId}/offline-sales`, headers: hdr(s, key === null ? {} : { 'idempotency-key': key }), payload });
const count = async (sql: string, p: unknown[]) => Number((await adminPool.query(sql, p)).rows[0].n);
const orderCount = (bizId: string) => count('SELECT count(*) n FROM platform.orders WHERE business_id = $1', [bizId]);
const saleCount = (bizId: string) => count('SELECT count(*) n FROM business_operations.offline_sales WHERE business_id = $1', [bizId]);

describe.runIf(run)('OFF-1 POST /v1/businesses/:businessId/offline-sales - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    const base = { DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' };
    closedApp = await buildApp(loadConfig(base));
    openApp = await buildApp(loadConfig({ ...base, OFFLINE_SALES_FUTURE_TOLERANCE_SECONDS: '300', OFFLINE_SALES_DRIFT_LIMITS: '{"KWD":500}' }));
    await closedApp.ready(); await openApp.ready();
  });
  afterAll(async () => { await closedApp?.close(); await openApp?.close(); await adminPool?.end(); await closePool(); });

  describe('closed by default (no owner configuration)', () => {
    it('answers 503 to an authorised caller, stores nothing, and the closed answer is never cached as an idempotent response', async () => {
      const s = await setup(closedApp);
      const p = await product(s, 1.5);
      const payload = body(s, [[p, 1, 1500]]);
      const r = await post(closedApp, s, payload);
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('OfflineSalesDisabledError');
      expect(await orderCount(s.bizId)).toBe(0); expect(await saleCount(s.bizId)).toBe(0);
      expect(await count("SELECT count(*) n FROM api.idempotency_keys WHERE tenant_id = $1 AND route LIKE '%/offline-sales'", [s.ctx.tenantId])).toBe(0);
    });
    it('a caller without bo:write still gets 403, not 503 (a closed surface reveals nothing to the unauthorised)', async () => {
      const s = await setup(closedApp, { permissions: ['bo:read'] });
      expect((await post(closedApp, s, body(s, [[randomUUID(), 1, 100]]))).statusCode).toBe(403);
    });
    it('no token is 401', async () => {
      const s = await setup(closedApp);
      const r = await closedApp.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/offline-sales`, payload: body(s, [[randomUUID(), 1, 100]]) });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('enabled', () => {
    it('accepts an exact cash sale: 201, the order is completed on the server, and the response is the server\'s answer', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1.5); const b = await product(s, 0.25);
      const payload = body(s, [[a, 2, 1500], [b, 3, 250]], {}, 5000);
      const r = await post(openApp, s, payload);
      expect(r.statusCode).toBe(201);
      const j = r.json();
      expect(j).toMatchObject({ clientSaleId: payload.clientSaleId, outcome: 'accepted', replayed: false, currencyCode: 'KWD', deviceTotalMinor: 3750, serverTotalMinor: 3750, differenceMinor: 0, reviewReason: null });
      expect(j.orderNumber).toMatch(/^ORD-/);
      expect(Object.keys(j).sort()).toEqual(['clientSaleId', 'currencyCode', 'deviceTotalMinor', 'differenceMinor', 'offlineSaleId', 'orderId', 'orderNumber', 'outcome', 'replayed', 'reviewReason', 'serverTotalMinor']);
      const o = (await adminPool.query('SELECT operational_status, total_amount, client_sale_id FROM platform.orders WHERE id = $1', [j.orderId])).rows[0];
      expect(o).toMatchObject({ operational_status: 'completed', client_sale_id: payload.clientSaleId });
      expect(Number(o.total_amount)).toBe(3.75);
      // the order is readable through the ordinary order route as well
      const read = await openApp.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/orders/${j.orderId}`, headers: hdr(s) });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ operationalStatus: 'completed', totalAmount: 3.75, currencyCode: 'KWD' });
    });

    it('sending the same sale again returns the same answer and creates nothing (idempotent)', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1);
      const payload = body(s, [[a, 1, 1000]]);
      const first = await post(openApp, s, payload);
      const again = await post(openApp, s, payload);
      expect(first.statusCode).toBe(201);
      expect(again.json().offlineSaleId).toBe(first.json().offlineSaleId);
      expect(again.json().orderId).toBe(first.json().orderId);
      expect(await orderCount(s.bizId)).toBe(1); expect(await saleCount(s.bizId)).toBe(1);
    });

    it('the same Idempotency-Key with a different body is refused (409) and changes nothing', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1);
      const payload = body(s, [[a, 1, 1000]]);
      expect((await post(openApp, s, payload)).statusCode).toBe(201);
      const changed = { ...payload, tenders: [{ method: 'cash', amountTenderedMinor: 2000 }] };
      expect((await post(openApp, s, changed)).statusCode).toBe(409);
      expect(await orderCount(s.bizId)).toBe(1);
    });

    it('honours the shown price within the owner-set limit (accepted_with_difference) and keeps the rest for review', async () => {
      const s = await setup(openApp);
      const changed = await product(s, 1.55, new Date(Date.now() - 30 * 60_000));   // changed after the device's snapshot
      const unchanged = await product(s, 1.55);                                       // not changed since
      const drift = await post(openApp, s, body(s, [[changed, 2, 1500]], {}, 3000));
      expect(drift.statusCode).toBe(201);
      expect(drift.json()).toMatchObject({ outcome: 'accepted_with_difference', deviceTotalMinor: 3000, serverTotalMinor: 3100, differenceMinor: 100 });
      const before = await orderCount(s.bizId);
      const refused = await post(openApp, s, body(s, [[unchanged, 2, 1500]], {}, 3000));
      expect(refused.statusCode).toBe(201);
      expect(refused.json()).toMatchObject({ outcome: 'needs_review', reviewReason: 'price_drift_not_allowed', orderId: null, orderNumber: null });
      expect(await orderCount(s.bizId)).toBe(before);
    });

    it('keeps an underpaid sale and a sale into a closed register for review: 201, no order', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1);
      const under = await post(openApp, s, body(s, [[a, 3, 1000]], {}, 2999));
      expect(under.json()).toMatchObject({ outcome: 'needs_review', reviewReason: 'underpaid', orderId: null });
      const close = await openApp.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/register-sessions/${s.sessionId}/close`, headers: hdr(s, { 'idempotency-key': uc('key') }), payload: { closingCash: 0 } });
      expect(close.statusCode).toBe(200);
      const closed = await post(openApp, s, body(s, [[a, 1, 1000]]));
      expect(closed.statusCode).toBe(201);
      expect(closed.json()).toMatchObject({ outcome: 'needs_review', reviewReason: 'session_closed', orderId: null });
      expect(await orderCount(s.bizId)).toBe(0); expect(await saleCount(s.bizId)).toBe(2);
    });
  });

  describe('request validation (400, nothing stored)', () => {
    it('rejects every malformed or untrustworthy request', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1);
      const good = () => body(s, [[a, 1, 1000]]);
      const cases: Array<[string, any]> = [
        ['an unknown key (no smuggled authority)', { ...good(), tenantId: s.ctx.tenantId }],
        ['a server-owned total', { ...good(), serverTotalMinor: 1 }],
        ['an unknown key inside a line', { ...good(), lines: [{ productId: a, quantity: 1, unitPriceShownMinor: 1000, discount: 5 }] }],
        ['a decimal amount', { ...good(), provisionalTotalMinor: 10.5, lines: [{ productId: a, quantity: 1, unitPriceShownMinor: 10.5 }] }],
        ['a non-cash tender', { ...good(), tenders: [{ method: 'card', amountTenderedMinor: 1000 }] }],
        ['a card-like reference', { ...good(), tenders: [{ method: 'cash', amountTenderedMinor: 1000, reference: '4111 1111 1111 1111' }] }],
        ['no lines', { ...good(), lines: [], provisionalTotalMinor: 0 }],
        ['a fractional quantity', { ...good(), lines: [{ productId: a, quantity: 1.5, unitPriceShownMinor: 1000 }] }],
        ['a lower-case currency', { ...good(), currencyCode: 'kwd' }],
        ['a malformed date', { ...good(), deviceCreatedAt: 'yesterday' }],
        ['a total that is not the sum of the lines', { ...good(), provisionalTotalMinor: 999 }],
        ['a sale older than 24 hours', { ...good(), deviceCreatedAt: new Date(Date.now() - 25 * HOUR).toISOString(), catalogueSnapshotAt: new Date(Date.now() - 26 * HOUR).toISOString() }],
        ['a device clock far in the future', { ...good(), deviceCreatedAt: new Date(Date.now() + HOUR).toISOString() }],
        ['a snapshot newer than the sale', { ...good(), catalogueSnapshotAt: new Date(Date.now() - 60_000).toISOString() }],
        ['a bad device id', { ...good(), deviceId: 'has space' }],
      ];
      for (const [name, payload] of cases) {
        const r = await post(openApp, s, payload, payload.clientSaleId);
        expect(r.statusCode, name).toBe(400);
        expect(r.json().error?.correlationId, name).toBeTruthy();
      }
      expect(await saleCount(s.bizId)).toBe(0); expect(await orderCount(s.bizId)).toBe(0);
    });

    it('requires an Idempotency-Key equal to clientSaleId', async () => {
      const s = await setup(openApp);
      const a = await product(s, 1);
      const payload = body(s, [[a, 1, 1000]]);
      expect((await post(openApp, s, payload, null)).statusCode).toBe(400);
      const mismatch = await post(openApp, s, payload, randomUUID());
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().error.message).toMatch(/Idempotency-Key header must equal clientSaleId/);
      expect((await post(openApp, s, payload, payload.clientSaleId.toUpperCase())).statusCode).toBe(201);   // case-insensitive
      expect(await saleCount(s.bizId)).toBe(1);
    });
  });

  describe('authorisation and isolation', () => {
    it('a caller with only bo:read is refused (403)', async () => {
      const s = await setup(openApp, { permissions: ['bo:read'] });
      expect((await post(openApp, s, body(s, [[randomUUID(), 1, 100]]))).statusCode).toBe(403);
    });
    it('another tenant cannot reach this business (404) and creates nothing', async () => {
      const a = await setup(openApp); const b = await setup(openApp);
      const p = await product(a, 1);
      const r = await post(openApp, b, body(a, [[p, 1, 1000]]), undefined, a.bizId);
      expect([403, 404]).toContain(r.statusCode);
      expect(await saleCount(a.bizId)).toBe(0); expect(await orderCount(a.bizId)).toBe(0);
    });
    it('the same clientSaleId used by two tenants is two independent sales', async () => {
      const a = await setup(openApp); const b = await setup(openApp);
      const pa = await product(a, 1); const pb = await product(b, 1);
      const id = randomUUID();
      const ra = await post(openApp, a, body(a, [[pa, 1, 1000]], { clientSaleId: id }));
      const rb = await post(openApp, b, body(b, [[pb, 1, 1000]], { clientSaleId: id }));
      expect(ra.statusCode).toBe(201); expect(rb.statusCode).toBe(201);
      expect(ra.json().orderId).not.toBe(rb.json().orderId);
    });
  });
});
