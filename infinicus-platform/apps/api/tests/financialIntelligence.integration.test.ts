/**
 * NEW-BI-01 - GET /v1/businesses/:businessId/intelligence/financial-report: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 * Figures are checked end to end from rows written the way the production writers leave them: currency separation, evidence-gated gross profit, comparison
 * with the preceding period, trend, date boundaries, authorization, validation, tenant and business isolation, and read-only behaviour.
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
  const email = `${uc('fin')}@fin-api.example`;
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
  const w = await createWorld(admin, 'FinApi');
  const ctx: TenantContext = { tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() };
  const viewer = await actor(); const noBi = await actor();
  await enroll(ctx, viewer, 'viewer');                              // viewer holds bi:read
  await enroll(ctx, noBi, { permissions: ['bo:read'] });            // a role without bi:read
  return { ...w, ctx, viewer, noBi };
}
const hdr = (s: Scope, a: Actor) => ({ authorization: `Bearer ${a.token}`, 'x-tenant-id': s.tenantId, 'x-workspace-id': s.workspaceId });
const report = (s: Scope, q: Record<string, string>, o: { actor?: Actor; businessId?: string; scope?: Scope } = {}) => {
  const qs = new URLSearchParams(q).toString();
  return app.inject({ method: 'GET', url: `/v1/businesses/${o.businessId ?? s.businessId}/intelligence/financial-report?${qs}`, headers: hdr(o.scope ?? s, o.actor ?? s.viewer) });
};
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };
const cur = (r: any, c: string) => r.period.currencies.find((x: any) => x.currency === c);

describe.runIf(run)('financial report API - live PostgreSQL + Fastify (NEW-BI-01)', () => {
  let a: Scope; let b: Scope; let sa: Seeder;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    a = await scope(); b = await scope(); sa = new Seeder(admin, a);
  });
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('a business with no data returns an empty, valid report (not an error, not invented zeros per currency)', async () => {
    const r = await report(a, PERIOD);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ contract: 'bi-financial-report/1', basedOn: 'bo-financial-facts/1', businessId: a.businessId, period: { range: PERIOD, currencies: [] }, ordersByStatus: [], indicators: [] });
    expect(body.comparison).toMatchObject({ range: { from: '2026-08-31', to: '2026-09-30' }, currencies: [], deltas: [] });
    expect(body.trend.granularity).toBe('day');
    expect(body.coverage).toContain('NO_CURRENCY_CONVERSION');
  });

  it('end to end: per-currency revenue, expenses, goods received, evidence-gated gross profit, comparison, trend', async () => {
    // current period
    const usd = await sa.order({ date: '2026-10-05', currency: 'USD', total: '120.00', lines: [{ quantity: '2' }, { quantity: '1' }] });
    await sa.movement({ type: 'issue', quantity: '2', unitCost: '20.0000', currency: 'USD', orderLineId: usd.lineIds[0] });
    await sa.movement({ type: 'issue', quantity: '1', unitCost: '10.0000', currency: 'USD', orderLineId: usd.lineIds[1] });
    await sa.order({ date: '2026-10-20', currency: 'KWD', total: '31.500', lines: [{ quantity: '3' }] });                    // no cost evidence
    await sa.order({ date: '2026-10-21', currency: 'USD', total: '999.00', status: 'failed' });                               // voided: never revenue
    await sa.expenseClaim({ status: 'approved', currency: 'USD', items: [{ date: '2026-10-07', amount: '15.00' }] });
    await sa.expenseClaim({ status: 'draft', currency: 'USD', items: [{ date: '2026-10-07', amount: '500.00' }] });          // not approved: never an expense
    await sa.receipt({ receivedAt: '2026-10-08T10:00:00Z', currency: 'USD', lines: [{ quantity: '4', unitCost: '5.0000' }] });
    // preceding period (2026-08-31 .. 2026-09-30)
    const prev = await sa.order({ date: '2026-09-10', currency: 'USD', total: '100.00', lines: [{ quantity: '1' }] });
    await sa.movement({ type: 'issue', quantity: '1', unitCost: '60.0000', currency: 'USD', orderLineId: prev.lineIds[0] });
    await sa.expenseClaim({ status: 'paid', currency: 'USD', items: [{ date: '2026-09-12', amount: '30.00' }] });

    const r = await report(a, { ...PERIOD, granularity: 'week' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.period.currencies.map((c: any) => c.currency)).toEqual(['KWD', 'USD']);
    expect(cur(body, 'USD')).toMatchObject({
      revenue: { amount: '120.00', count: 1 }, averageOrderValue: { amount: '120.00', state: 'OK' }, expenses: { amount: '15.00', count: 1 }, goodsReceived: { amount: '20.00', count: 1 },
      grossProfit: { state: 'COMPUTED', amount: '70.00', marginPercent: '58.33', evidence: { saleLines: 2, saleLinesWithCostEvidence: 2 } },
    });
    expect(cur(body, 'KWD')).toMatchObject({
      revenue: { amount: '31.500', count: 1 }, expenses: { amount: '0.000', count: 0 },
      grossProfit: { state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null, evidence: { saleLines: 1, saleLinesWithCostEvidence: 0 } },
    });
    expect(body.ordersByStatus).toEqual(expect.arrayContaining([{ status: 'completed', count: 2 }, { status: 'failed', count: 1 }]));
    expect(body.coverage).toContain('GROSS_PROFIT_COST_EVIDENCE_INCOMPLETE:KWD');

    const usdDelta = body.comparison.deltas.find((d: any) => d.currency === 'USD');
    expect(usdDelta.revenue).toEqual({ current: '120.00', previous: '100.00', change: '20.00', changePercent: '20.00', state: 'OK' });
    expect(usdDelta.expenses).toMatchObject({ current: '15.00', previous: '30.00', change: '-15.00', changePercent: '-50.00' });
    expect(usdDelta.grossProfit).toMatchObject({ current: '70.00', previous: '40.00', change: '30.00', changePercent: '75.00' });
    const kwdDelta = body.comparison.deltas.find((d: any) => d.currency === 'KWD');
    expect(kwdDelta.revenue).toMatchObject({ previous: '0.000', state: 'NO_BASELINE', changePercent: null });
    expect(kwdDelta.grossProfit).toBeNull();

    // the trend adds up to the period, per currency
    const sum = (c: string) => body.trend.buckets.reduce((n: number, bk: any) => n + Number(bk.currencies.find((x: any) => x.currency === c).revenue), 0);
    expect(sum('USD')).toBeCloseTo(120, 6); expect(sum('KWD')).toBeCloseTo(31.5, 6);
    expect(body.trend.buckets[0].start).toBe(PERIOD.from); expect(body.trend.buckets.at(-1).end).toBe(PERIOD.to);
  });

  it('date boundaries: the first and last day are in, the days either side are out, in the period and in the trend', async () => {
    const t = await scope(); const st = new Seeder(admin, t);
    for (const [date, total] of [['2026-09-30', '1000.00'], ['2026-10-01', '1.00'], ['2026-10-31', '2.00'], ['2026-11-01', '1000.00']]) await st.order({ date, currency: 'EUR', total });
    const body = (await report(t, { ...PERIOD, compare: 'none', granularity: 'month' })).json();
    expect(cur(body, 'EUR').revenue).toEqual({ amount: '3.00', count: 2 });
    expect(body.trend.buckets).toHaveLength(1);
    expect(body.trend.buckets[0].currencies[0].revenue).toBe('3.00');
    expect(body.comparison).toBeNull();
  });

  it('authorization: unauthenticated is 401; a role without bi:read is 403 and learns nothing; a viewer (bi:read) reads', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/intelligence/financial-report?from=2026-10-01&to=2026-10-31` })).statusCode).toBe(401);
    const denied = await report(a, PERIOD, { actor: a.noBi });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('revenue');
    expect((await report(a, PERIOD)).statusCode).toBe(200);
  });

  it('validation: impossible, reversed, malformed, over-long and unknown-option requests are 400 and read nothing', async () => {
    for (const q of [
      { from: '2026-02-30', to: '2026-03-10' }, { from: '2026-13-01', to: '2026-13-02' }, { from: '2026-11-01', to: '2026-10-01' }, { from: '10/01/2026', to: '2026-10-31' },
      { from: '2025-01-01', to: '2026-12-31' }, { from: '2026-10-01' }, { ...PERIOD, granularity: 'year' }, { ...PERIOD, compare: 'yoy' },
    ]) {
      const r = await report(a, q as Record<string, string>);
      expect(r.statusCode, JSON.stringify(q)).toBe(400);
    }
  });

  it('a malformed business id is a 4xx validation error, never a database error', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/businesses/not-a-uuid/intelligence/financial-report?from=2026-10-01&to=2026-10-31`, headers: hdr(a, a.viewer) });
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
    expect(foreign.body).not.toContain('120.00');
    const own = (await report(b, { ...PERIOD, compare: 'none' }, { actor: b.viewer })).json();
    expect(own.period.currencies).toHaveLength(1);
    expect(cur(own, 'USD').revenue).toEqual({ amount: '7.00', count: 1 });
    // a token of tenant A with tenant B's scope headers reads nothing of B
    const crossed = await report(a, PERIOD, { actor: a.viewer, businessId: b.businessId, scope: b });
    expect([401, 403, 404]).toContain(crossed.statusCode);
  });

  it('business isolation: a sibling business in the same workspace has its own figures', async () => {
    const sib = await addBusiness(admin, a);
    await new Seeder(admin, sib).order({ date: '2026-10-05', currency: 'JPY', total: '3000.00' });
    const mine = (await report(a, { ...PERIOD, compare: 'none' })).json();
    expect(mine.period.currencies.map((c: any) => c.currency)).not.toContain('JPY');
    const theirs = await app.inject({ method: 'GET', url: `/v1/businesses/${sib.businessId}/intelligence/financial-report?from=2026-10-01&to=2026-10-31&compare=none`, headers: hdr(a, a.viewer) });
    expect(theirs.statusCode).toBe(200);
    expect(cur(theirs.json(), 'JPY').revenue).toEqual({ amount: '3000', count: 1 });
  });

  it('reading writes nothing: no operational, BI or audit row changes, and no events are emitted', async () => {
    const tables = ['platform.orders', 'business_operations.inventory_movements', 'business_operations.expense_items', 'business_intelligence.metric_calculated_values', 'business_intelligence.insight_packages', 'audit.audit_events', 'events.outbox_events'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [a.tenantId])).rows[0].n)));
    const before = await snap();
    for (let i = 0; i < 3; i += 1) expect((await report(a, PERIOD)).statusCode).toBe(200);
    expect((await report(a, PERIOD, { actor: a.noBi })).statusCode).toBe(403);
    expect(await snap()).toEqual(before);
  });
});
