/**
 * BI-SALES-1 - the Business Intelligence sales report (real PostgreSQL, production buildApp).
 * GET /v1/businesses/:businessId/bi/sales-report?from=&to= : read-only, computed on read from authoritative Business Operations orders, integer minor
 * units per currency, explicit inclusive period, tenant / workspace / business isolation, bi:read AND bo:read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, OrderRepository, RegisterSessionRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const D1 = '2026-04-10';
const D2 = '2026-04-11';

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;
const orders = new OrderRepository();
const registers = new RegisterSessionRepository();

const report = (w: { ctx: TenantContext; token: string }, businessId: string, query: string) =>
  app.inject({ method: 'GET', url: `/v1/businesses/${businessId}/bi/sales-report${query}`, headers: kit.headers(w) });

async function seller(): Promise<World> {
  const w = await kit.world();
  const declared = await app.inject({ method: 'PUT', url: `/v1/businesses/${w.businessId}/declared-currency`, headers: kit.headers(w, { 'idempotency-key': unique('key') }),
    payload: { currency: 'KWD', expectedVersion: null, reason: 'initial declaration' } });
  expect(declared.statusCode, declared.body).toBe(201);
  await registers.open(w.ctx, { businessId: w.businessId, openingCash: 0 });
  return w;
}
async function sale(w: World, lines: Array<[string, number, number]>, date: string, outcome: 'completed' | 'voided' | 'open', discount = 0) {
  let order = await orders.create(w.ctx, { businessId: w.businessId });
  for (const [description, quantity, unitPrice] of lines) order = await orders.addLineItem(w.ctx, order.id, w.businessId, { description, quantity, unitPrice });
  if (discount > 0) order = await orders.addDiscount(w.ctx, order.id, w.businessId, { amount: discount, reason: 'test' });
  if (outcome === 'completed') order = await orders.complete(w.ctx, order.id, w.businessId, [{ method: 'cash', amountTendered: order.totalAmount + 1 }]);
  if (outcome === 'voided') order = await orders.void(w.ctx, order.id, w.businessId, 'test');
  await admin.query('UPDATE platform.orders SET order_date = $2 WHERE id = $1', [order.id, date]);
}
const rowCounts = async (businessId: string) => JSON.stringify((await admin.query(
  `SELECT (SELECT count(*) FROM platform.orders WHERE business_id = $1)::int AS orders,
          (SELECT count(*) FROM business_operations.order_line_items WHERE business_id = $1)::int AS lines,
          (SELECT count(*) FROM business_operations.order_payments WHERE business_id = $1)::int AS payments,
          (SELECT count(*) FROM business_intelligence.metric_calculated_values WHERE business_id = $1)::int AS bi_values,
          (SELECT count(*) FROM business_intelligence.insight_package_versions WHERE business_id = $1)::int AS bi_versions,
          (SELECT COALESCE(sum(version),0) FROM platform.orders WHERE business_id = $1)::int AS order_versions`, [businessId])).rows[0]);

describe.runIf(run)('BI-SALES-1: sales report', () => {
  let a: World; let b: World;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await seller();
    b = await seller();
    await sale(a, [['Coffee', 2, 1.5]], D1, 'completed');                                      // 3.000
    await sale(a, [['Tea', 1, 2], ['Cake', 1, 1.25]], D1, 'completed', 0.5);                  // gross 3.250, discount 0.500, net 2.750
    await sale(a, [['Void me', 1, 9]], D1, 'voided');
    await sale(a, [['Open', 1, 4]], D2, 'open');
    await sale(b, [['Other tenant', 1, 100]], D1, 'completed');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    }
    await admin?.end(); await closePool();
  });

  it('reports the period in integer minor units of the declared currency, reconciled, with a continuous daily series', async () => {
    const res = await report(a, a.businessId, `?from=${D1}&to=${D2}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('REPORT');
    expect(body.report.businessId).toBe(a.businessId);
    expect(body.report.period).toEqual({ from: D1, to: D2, days: 2, basis: 'order_date', inclusive: true });
    expect(body.report.currencies).toHaveLength(1);
    const kwd = body.report.currencies[0];
    expect(kwd.currency).toEqual({ code: 'KWD', minorUnitExponent: 3 });
    expect(kwd.totals).toEqual({ completedOrders: 2, voidedOrders: 1, openOrders: 1, otherStatusOrders: 0, grossMinor: 6250, discountMinor: 500, netMinor: 5750, averageOrderNetMinor: 2875, reconciles: true });
    expect(kwd.daily).toEqual([
      { date: D1, completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossMinor: 6250, discountMinor: 500, netMinor: 5750 },
      { date: D2, completedOrders: 0, voidedOrders: 0, openOrders: 1, otherStatusOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 },
    ]);
  });

  it('a period with no orders reports no currency section (no invented figures); a single-day period works', async () => {
    const empty = await report(a, a.businessId, '?from=2026-01-01&to=2026-01-31');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ outcome: 'REPORT', report: { currencies: [], period: { days: 31 } } });
    const one = await report(a, a.businessId, `?from=${D2}&to=${D2}`);
    expect(one.json().report.currencies[0].totals).toMatchObject({ openOrders: 1, completedOrders: 0, netMinor: 0, averageOrderNetMinor: null });
  });

  it('isolates tenants and businesses: another tenant sees only its own sales, and cannot read this business', async () => {
    const own = await report(b, b.businessId, `?from=${D1}&to=${D1}`);
    expect(own.json().report.currencies[0].totals).toMatchObject({ completedOrders: 1, netMinor: 100000 });
    const cross = await report(b, a.businessId, `?from=${D1}&to=${D1}`);
    expect(cross.statusCode).toBe(404);
    expect(cross.body).not.toContain('"currencies"');
  });

  /** A user who is an active member of tenant A's workspace and holds exactly the given permissions through a tenant-owned role (none = no role at all). */
  async function memberWith(permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = reg.json().id as string;
    await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId, userId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(ctx, userId);
    await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI test role','workspace') RETURNING id`, [a.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }

  it('isolates businesses: a second business in the same workspace never appears in this business report, and has its own', async () => {
    const other = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling Biz',$3,'active') RETURNING id`,
      [a.ctx.tenantId, a.ctx.workspaceId, unique('sib')])).rows[0].id as string;
    const declared = await app.inject({ method: 'PUT', url: `/v1/businesses/${other}/declared-currency`, headers: kit.headers(a, { 'idempotency-key': unique('key') }),
      payload: { currency: 'KWD', expectedVersion: null, reason: 'initial declaration' } });
    expect(declared.statusCode, declared.body).toBe(201);
    await registers.open(a.ctx, { businessId: other, openingCash: 0 });
    await sale({ ...a, businessId: other }, [['Sibling item', 1, 777]], D1, 'completed');
    const mine = await report(a, a.businessId, `?from=${D1}&to=${D1}`);
    expect(mine.json().report.currencies[0].totals.netMinor).toBe(5750);          // unchanged: the 777 KWD sale is not here
    const theirs = await report(a, other, `?from=${D1}&to=${D1}`);
    expect(theirs.json().report.currencies[0].totals).toMatchObject({ completedOrders: 1, netMinor: 777000 });
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/bi/sales-report?from=${D1}&to=${D2}` })).statusCode).toBe(401);
  });

  it.each([[[]], [['bi:read']], [['bo:read']], [['bi:write', 'bo:write']]])('requires BOTH bi:read and bo:read: a member holding only %j is refused with 403 and sees no figures', async (permissions) => {
    const res = await report(await memberWith(permissions), a.businessId, `?from=${D1}&to=${D2}`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain('"currencies"');
  });

  it('a member holding exactly bi:read and bo:read is served', async () => {
    const res = await report(await memberWith(['bi:read', 'bo:read']), a.businessId, `?from=${D1}&to=${D2}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().report.currencies[0].totals.netMinor).toBe(5750);
  });

  it.each([
    ['', 'missing period'], [`?from=${D1}`, 'missing to'], [`?to=${D1}`, 'missing from'],
    ['?from=2026-02-30&to=2026-03-01', 'not a real date'], ['?from=2026-4-1&to=2026-04-02', 'not YYYY-MM-DD'], [`?from=${D2}&to=${D1}`, 'reversed'],
    ['?from=2024-01-01&to=2025-01-01', 'over 366 days'], [`?from=${D1}&to=${D2}&extra=1`, 'unknown parameter'], ['?from=2026-04-10T00:00:00Z&to=2026-04-11', 'a timestamp'],
  ])('refuses %s (%s) with 400 and reads nothing', async (query) => {
    const res = await report(a, a.businessId, query);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toMatch(/validation|ValidationError/i);
  });

  it('refuses a malformed or unknown business id', async () => {
    expect((await report(a, 'not-a-uuid', `?from=${D1}&to=${D2}`)).statusCode).toBe(400);
    expect((await report(a, '11111111-1111-4111-8111-111111111111', `?from=${D1}&to=${D2}`)).statusCode).toBe(404);
  });

  it('is read-only and idempotent: repeated calls return the same report and change no order, line, payment or BI row', async () => {
    const before = await rowCounts(a.businessId);
    const first = await report(a, a.businessId, `?from=${D1}&to=${D2}`);
    const second = await report(a, a.businessId, `?from=${D1}&to=${D2}`);
    expect(second.json()).toEqual(first.json());
    expect(await rowCounts(a.businessId)).toBe(before);
  });

  it('does not exist as a write: POST, PUT, PATCH and DELETE on the path are not routed', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: `/v1/businesses/${a.businessId}/bi/sales-report?from=${D1}&to=${D2}`, headers: kit.headers(a, { 'idempotency-key': unique('key') }), payload: {} as never });
      expect(res.statusCode, method).toBe(404);
    }
  });
});
