/**
 * NEW-BI-02 - GET /v1/businesses/:businessId/intelligence/sales-report: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Figures are checked end to end from rows written the way the production writers leave them: currency separation, customers (new versus returning), item mix,
 * product ranking, fulfilment, order completion, comparison with the preceding period, trend, date boundaries, authorization, validation, tenant and business
 * isolation, and read-only behaviour.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { addBusiness, createWorld, Seeder, type World } from '../../../packages/database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let admin: Pool;
let app: FastifyInstance;

interface Actor { token: string; userId: string }
interface Scope extends World { ctx: TenantContext; viewer: Actor; noBi: Actor }

async function actor(): Promise<Actor> {
  const email = `${uc('sal')}@sales-api.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}
async function enroll(ctx: TenantContext, a: Actor, role: string | { permissions: string[] }): Promise<void> {
  const memberships = new MembershipRepository();
  const m = await memberships.create({ ...ctx, userId: a.userId }, a.userId); await memberships.activate({ ...ctx, userId: a.userId }, m.id);
  let roleId: string;
  if (typeof role === 'string') roleId = (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  else {
    roleId = randomUUID();
    await admin.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','fin test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole({ ...ctx, userId: a.userId }, m.id, roleId);
}
async function scope(): Promise<Scope> {
  const w = await createWorld(admin, 'SalesApi');
  const ctx: TenantContext = { tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() };
  const viewer = await actor(); const noBi = await actor();
  await enroll(ctx, viewer, 'viewer');                              // viewer holds bi:read
  await enroll(ctx, noBi, { permissions: ['bo:read'] });            // a role without bi:read
  return { ...w, ctx, viewer, noBi };
}
const hdr = (s: Scope, a: Actor) => ({ authorization: `Bearer ${a.token}`, 'x-tenant-id': s.tenantId, 'x-workspace-id': s.workspaceId });
const report = (s: Scope, q: Record<string, string>, o: { actor?: Actor; businessId?: string; scope?: Scope } = {}) => {
  const qs = new URLSearchParams(q).toString();
  return app.inject({ method: 'GET', url: `/v1/businesses/${o.businessId ?? s.businessId}/intelligence/sales-report?${qs}`, headers: hdr(o.scope ?? s, o.actor ?? s.viewer) });
};
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };
const cur = (r: any, c: string) => r.period.currencies.find((x: any) => x.currency === c);

describe.runIf(run)('sales report API - live PostgreSQL + Fastify (NEW-BI-02)', () => {
  let a: Scope; let b: Scope; let sa: Seeder;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    a = await scope(); b = await scope(); sa = new Seeder(admin, a);
  });
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('a business with no data returns an empty, valid report with the standing coverage codes', async () => {
    const r = await report(a, PERIOD);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ contract: 'bi-sales-report/1', basedOn: 'bo-sales-facts/1', businessId: a.businessId, period: { range: PERIOD, currencies: [] } });
    expect(body.operations).toMatchObject({ completed: 0, completionRate: { percent: null, state: 'NO_DATA' } });
    expect(body.comparison).toMatchObject({ range: { from: '2026-08-31', to: '2026-09-30' }, currencies: [], deltas: [] });
    expect(body.coverage).toContain('NO_CURRENCY_CONVERSION');
  });

  it('end to end: per-currency orders, customers, mix, products, fulfilment, completion, comparison and trend', async () => {
    const [ana, ben] = [await sa.customer('Ana'), await sa.customer('Ben')];
    const [tea, cake] = [await sa.product('Tea'), await sa.product('Cake')];
    await sa.order({ date: '2026-08-15', currency: 'USD', total: '10.00', customerId: ana });                              // makes Ana a returning customer
    await sa.order({ date: '2026-10-05', currency: 'USD', total: '90.00', customerId: ana, lines: [
      { quantity: '4', total: '60.00', productId: tea, fulfilled: '4' }, { quantity: '2', total: '30.00', productId: cake, fulfilled: '1' },
    ] });
    await sa.order({ date: '2026-10-12', currency: 'USD', total: '30.00', customerId: ben, lines: [{ quantity: '2', type: 'service', total: '25.00' }, { quantity: '1', type: 'fee', total: '5.00' }] });
    await sa.order({ date: '2026-10-20', currency: 'KWD', total: '31.500', lines: [{ quantity: '3', total: '31.500', productId: tea, fulfilled: '3' }] });
    await sa.order({ date: '2026-10-21', currency: 'USD', total: '999.00', status: 'failed', lines: [{ quantity: '9', total: '999.00', productId: tea }] });
    await sa.order({ date: '2026-10-22', currency: 'USD', total: '1.00', status: 'planned' });
    await sa.order({ date: '2026-09-10', currency: 'USD', total: '60.00', lines: [{ quantity: '3', total: '60.00', productId: tea, fulfilled: '3' }] });   // preceding period
    const r = await report(a, { ...PERIOD, granularity: 'week' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.period.currencies.map((c: any) => c.currency)).toEqual(['KWD', 'USD']);
    expect(cur(body, 'USD')).toMatchObject({
      orders: { count: 2, revenue: '120.00' }, averageOrderValue: { amount: '60.00', state: 'OK' }, unitsSold: '8', unitsPerOrder: { value: '4', state: 'OK' },
      customers: { identifiedOrders: 2, anonymousOrders: 0, distinct: 2, returning: 1, newCustomers: 1, returningShare: { percent: '50.00', state: 'OK' } },
      fulfilment: { orderedQuantity: '6', fulfilledQuantity: '5', rate: { percent: '83.33', state: 'OK' } },
      ordersWithoutLines: 0,
    });
    expect(cur(body, 'USD').topProducts.map((p: any) => [p.name, p.lineTotal, p.share.percent])).toEqual([['Tea', '60.00', '66.67'], ['Cake', '30.00', '33.33']]);
    expect(cur(body, 'USD').itemMix.map((m: any) => m.itemType)).toEqual(['fee', 'product', 'service']);
    expect(cur(body, 'KWD')).toMatchObject({ orders: { count: 1, revenue: '31.500' }, customers: { identifiedOrders: 0, anonymousOrders: 1, distinct: 0, returningShare: { state: 'NO_DATA' } } });
    expect(cur(body, 'KWD').topProducts).toHaveLength(1);
    expect(body.operations).toMatchObject({ completed: 3, failed: 1, inFlight: 1, completionRate: { percent: '75.00', state: 'OK' } });

    const usd = body.comparison.deltas.find((d: any) => d.currency === 'USD');
    expect(usd.orders).toEqual({ current: '2', previous: '1', change: '1', changePercent: '100.00', state: 'OK' });
    expect(usd.revenue).toEqual({ current: '120.00', previous: '60.00', change: '60.00', changePercent: '100.00', state: 'OK' });
    expect(usd.unitsSold).toMatchObject({ current: '8', previous: '3', change: '5' });
    expect(body.comparison.deltas.find((d: any) => d.currency === 'KWD').revenue).toMatchObject({ state: 'NO_BASELINE', changePercent: null });

    const orders = (c: string) => body.trend.buckets.reduce((n: number, bk: any) => n + bk.currencies.find((x: any) => x.currency === c).orders, 0);
    expect(orders('USD')).toBe(2); expect(orders('KWD')).toBe(1);
    expect(body.trend.buckets[0].start).toBe(PERIOD.from); expect(body.trend.buckets.at(-1).end).toBe(PERIOD.to);
  });

  it('topProducts limits the ranking per currency; compare=none omits the comparison', async () => {
    const body = (await report(a, { ...PERIOD, topProducts: '1', compare: 'none' })).json();
    expect(cur(body, 'USD').topProducts.map((p: any) => p.name)).toEqual(['Tea']);
    expect(body.comparison).toBeNull();
  });

  it('date boundaries: the first and last day are in, the days either side are out', async () => {
    const t = await scope(); const st = new Seeder(admin, t);
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']) await st.order({ date, currency: 'EUR', total: '1.00', lines: [{ quantity: '1', total: '1.00' }] });
    const body = (await report(t, { ...PERIOD, compare: 'none', granularity: 'month' })).json();
    expect(cur(body, 'EUR').orders).toEqual({ count: 2, revenue: '2.00' });
    expect(body.trend.buckets).toHaveLength(1);
    expect(body.trend.buckets[0].currencies[0]).toMatchObject({ orders: 2, revenue: '2.00', unitsSold: '2' });
  });

  it('authorization: unauthenticated is 401; a role without bi:read is 403 and learns nothing; a viewer (bi:read) reads', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/intelligence/sales-report?from=2026-10-01&to=2026-10-31` })).statusCode).toBe(401);
    const denied = await report(a, PERIOD, { actor: a.noBi });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('revenue');
    expect((await report(a, PERIOD)).statusCode).toBe(200);
  });

  it('validation: impossible, reversed, malformed, over-long and out-of-range requests are 400 and read nothing', async () => {
    for (const q of [
      { from: '2026-02-30', to: '2026-03-10' }, { from: '2026-13-01', to: '2026-13-02' }, { from: '2026-11-01', to: '2026-10-01' }, { from: '10/01/2026', to: '2026-10-31' },
      { from: '2025-01-01', to: '2026-12-31' }, { from: '2026-10-01' }, { ...PERIOD, granularity: 'year' }, { ...PERIOD, compare: 'yoy' },
      { ...PERIOD, topProducts: '0' }, { ...PERIOD, topProducts: '51' }, { ...PERIOD, topProducts: 'many' },
    ]) {
      const r = await report(a, q as Record<string, string>);
      expect(r.statusCode, JSON.stringify(q)).toBe(400);
    }
  });

  it('a malformed business id is a 4xx validation error, never a database error', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/businesses/not-a-uuid/intelligence/sales-report?from=2026-10-01&to=2026-10-31', headers: hdr(a, a.viewer) });
    expect(r.statusCode).toBeGreaterThanOrEqual(400); expect(r.statusCode).toBeLessThan(500);
  });

  it('tenant isolation: a foreign business gets the same 404 as one that does not exist; each tenant sees only its own figures', async () => {
    await new Seeder(admin, b).order({ date: '2026-10-05', currency: 'USD', total: '7.00' });
    const missingId = randomUUID();
    const foreign = await report(b, PERIOD, { actor: b.viewer, businessId: a.businessId, scope: b });
    const missing = await report(b, PERIOD, { actor: b.viewer, businessId: missingId, scope: b });
    expect(foreign.statusCode).toBe(404); expect(missing.statusCode).toBe(404);
    const shape = (res: { body: string }, asked: string) => JSON.parse(res.body.split(asked).join('<asked>').replace(/"correlationId":"[^"]+"/, '"correlationId":"<c>"'));
    expect(shape(foreign, a.businessId)).toEqual(shape(missing, missingId));
    expect(foreign.body).not.toContain('Tea');
    const own = (await report(b, { ...PERIOD, compare: 'none' }, { actor: b.viewer })).json();
    expect(own.period.currencies).toHaveLength(1);
    expect(cur(own, 'USD').orders).toEqual({ count: 1, revenue: '7.00' });
    expect(cur(own, 'USD').topProducts).toEqual([]);
    const crossed = await report(a, PERIOD, { actor: a.viewer, businessId: b.businessId, scope: b });
    expect([401, 403, 404]).toContain(crossed.statusCode);
  });

  it('business isolation: a sibling business in the same workspace has its own figures', async () => {
    const sib = await addBusiness(admin, a);
    await new Seeder(admin, sib).order({ date: '2026-10-05', currency: 'JPY', total: '3000.00' });
    const mine = (await report(a, { ...PERIOD, compare: 'none' })).json();
    expect(mine.period.currencies.map((c: any) => c.currency)).not.toContain('JPY');
    const theirs = await app.inject({ method: 'GET', url: `/v1/businesses/${sib.businessId}/intelligence/sales-report?from=2026-10-01&to=2026-10-31&compare=none`, headers: hdr(a, a.viewer) });
    expect(theirs.statusCode).toBe(200);
    expect(cur(theirs.json(), 'JPY').orders).toEqual({ count: 1, revenue: '3000' });
  });

  it('reading writes nothing: no operational, BI or audit row changes', async () => {
    const tables = ['platform.orders', 'business_operations.order_line_items', 'platform.customers', 'platform.products', 'business_intelligence.metric_calculated_values', 'business_intelligence.insight_packages'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [a.tenantId])).rows[0].n)));
    const before = await snap();
    for (let i = 0; i < 3; i += 1) expect((await report(a, PERIOD)).statusCode).toBe(200);
    expect((await report(a, PERIOD, { actor: a.noBi })).statusCode).toBe(403);
    expect(await snap()).toEqual(before);
  });
});
