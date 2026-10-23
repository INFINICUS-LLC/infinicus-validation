/**
 * NEW-BDT-01 - the Business Digital Twin representation of governed BI performance evidence: live PostgreSQL + the production buildApp (RLS enforced).
 * The REAL BI financial and sales services produce the evidence from orders written the way the production writers leave them; the twin only represents it.
 * Checked end to end: the twin's figures equal the BI report endpoints' figures, currency separation, the cross-report revenue check, insufficient cost
 * evidence passed through, authorization (dt:write / dt:read), validation, idempotency, tenant and business isolation, and that nothing operational is written.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';
import { Seeder, addBusiness } from '../../../packages/database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

const url = (businessId: string) => `/v1/businesses/${businessId}/twin/business-performance`;
const publish = (w: { ctx: TenantContext; token: string }, businessId: string, body: unknown = PERIOD, key = unique('key')) =>
  app.inject({ method: 'POST', url: url(businessId), headers: kit.headers(w, { 'idempotency-key': key }), payload: body as never });
const latest = (w: { ctx: TenantContext; token: string }, businessId: string, qs = '') => app.inject({ method: 'GET', url: `${url(businessId)}${qs}`, headers: kit.headers(w) });
const scopeOf = (w: World) => ({ tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId });
const dtCounts = async (businessId: string) => Object.fromEntries(await Promise.all(['digital_twin_definitions', 'digital_twin_instances', 'digital_twin_snapshots'].map(async (t) =>
  [t, Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.${t} WHERE business_id = $1`, [businessId])).rows[0].n)])));

/** A user of the same tenant with the `viewer` role: holds dt:read, not dt:write. */
async function viewerOf(w: World) {
  const email = `${unique('bdtv')}@bdt.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const token = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } })).json().rawSessionToken as string;
  const memberships = new MembershipRepository();
  const m = await memberships.create({ ...w.ctx, userId }, userId); await memberships.activate({ ...w.ctx, userId }, m.id);
  const roleId = (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = 'viewer'`)).rows[0].id;
  await memberships.assignRole({ ...w.ctx, userId }, m.id, roleId);
  return { ctx: w.ctx, token };
}

describe.runIf(run)('NEW-BDT-01: BDT representation of governed BI performance evidence', () => {
  let a: World; let b: World; let sa: Seeder; let sibling: ReturnType<typeof scopeOf>;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await kit.world(); b = await kit.world();
    sa = new Seeder(admin, scopeOf(a));
    sibling = await addBusiness(admin, scopeOf(a));
    // tenant A / business A: USD 150.00 over two orders (one line without cost), KWD 31.500, a voided order and an open order that are never revenue
    await sa.order({ date: '2026-10-05', currency: 'USD', total: '100.00', lines: [{ quantity: '2', total: '100.00' }] });
    await sa.order({ date: '2026-10-12', currency: 'USD', total: '50.00', lines: [{ quantity: '1', total: '50.00' }] });
    await sa.order({ date: '2026-10-20', currency: 'KWD', total: '31.500', lines: [{ quantity: '3', total: '31.500' }] });
    await sa.order({ date: '2026-10-21', currency: 'USD', total: '999.00', status: 'failed' });
    await sa.order({ date: '2026-10-22', currency: 'USD', total: '7.00', status: 'planned' });
    await new Seeder(admin, sibling).order({ date: '2026-10-05', currency: 'JPY', total: '3000', lines: [{ quantity: '1', total: '3000' }] });
    await new Seeder(admin, scopeOf(b)).order({ date: '2026-10-05', currency: 'EUR', total: '12.00', lines: [{ quantity: '1', total: '12.00' }] });
  }, 120_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('publishes the twin state from the REAL BI reports: per currency, cross-checked, with provenance, and 201', async () => {
    const res = await publish(a, a.businessId);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.outcome).toBe('PUBLISHED');
    const ev = body.state.evidence;
    expect(ev).toMatchObject({ contract: 'bi-performance-evidence/1', businessId: a.businessId, period: PERIOD });
    expect(ev.financial.currencies.map((c: any) => c.currency)).toEqual(['KWD', 'USD']);
    expect(ev.sales.currencies.map((c: any) => [c.currency, c.minorUnitExponent, c.completedOrders, c.netMinor, c.voidedOrders, c.openOrders])).toEqual([['KWD', 3, 1, 31500, 0, 0], ['USD', 2, 2, 15000, 1, 1]]);
    expect(ev.crossCheck).toEqual({ performed: true, revenue: [{ currency: 'KWD', state: 'AGREE' }, { currency: 'USD', state: 'AGREE' }] });
    expect(ev.financial.provenance).toMatchObject({ contract: 'bi-financial-report/1', period: PERIOD });
    expect(ev.evidenceDigest).toBe(body.evidenceDigest);
    expect(ev.financial.currencies.find((c: any) => c.currency === 'USD').grossProfit).toMatchObject({ state: 'INSUFFICIENT_COST_EVIDENCE', amount: null });   // no cost evidence: passed through, never a value
    expect(JSON.stringify(ev)).not.toMatch(/"(total|combined|netProfit)"/);
  });

  it('the twin\'s figures ARE the BI report endpoints\' figures (verbatim: no second calculation)', async () => {
    const fin = (await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/intelligence/financial-report?from=${PERIOD.from}&to=${PERIOD.to}&granularity=month&compare=none`, headers: kit.headers(a) })).json();
    const sales = (await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/bi/sales-report?from=${PERIOD.from}&to=${PERIOD.to}`, headers: kit.headers(a) })).json();
    const ev = (await publish(a, a.businessId)).json().state.evidence;
    expect(ev.financial.currencies).toEqual(fin.period.currencies);
    expect(ev.sales.currencies.map((c: any) => [c.currency, c.grossMinor, c.discountMinor, c.netMinor, c.averageOrderNetMinor, c.reconciles])).toEqual(
      sales.report.currencies.map((c: any) => [c.currency.code, c.totals.grossMinor, c.totals.discountMinor, c.totals.netMinor, c.totals.averageOrderNetMinor, c.totals.reconciles]));
  });

  it('is deterministic: publishing again from unchanged BI evidence yields the same evidence digest; the newest state is read back with integrity verified', async () => {
    const first = (await publish(a, a.businessId)).json();
    const second = (await publish(a, a.businessId)).json();
    expect(second.evidenceDigest).toBe(first.evidenceDigest);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    const got = await latest(a, a.businessId, `?from=${PERIOD.from}&to=${PERIOD.to}`);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toMatchObject({ integrity: { valid: true, reasons: [] }, state: { evidence: { evidenceDigest: first.evidenceDigest } } });
    expect((await latest(a, a.businessId, '?from=2026-09-01&to=2026-09-30')).statusCode).toBe(404);
  });

  it('an unchanged Idempotency-Key replays the stored response and creates no second snapshot', async () => {
    const w = await kit.world(); await new Seeder(admin, scopeOf(w)).order({ date: '2026-10-05', currency: 'USD', total: '10.00', lines: [{ quantity: '1', total: '10.00' }] });
    const key = unique('replay');
    const one = await publish(w, w.businessId, PERIOD, key); const two = await publish(w, w.businessId, PERIOD, key);
    expect(one.statusCode).toBe(201); expect(two.statusCode).toBe(201);
    expect(two.json().snapshotId).toBe(one.json().snapshotId);
    expect((await dtCounts(w.businessId)).digital_twin_snapshots).toBe(1);
  });

  it('insufficient evidence publishes nothing: a business with no recorded activity is NOT_PUBLISHED (200) and creates no twin rows', async () => {
    const w = await kit.world();
    const res = await publish(w, w.businessId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INSUFFICIENT' });
    expect(await dtCounts(w.businessId)).toEqual({ digital_twin_definitions: 0, digital_twin_instances: 0, digital_twin_snapshots: 0 });
    expect((await latest(w, w.businessId)).statusCode).toBe(404);
  });

  it('authorization: unauthenticated 401; a viewer (dt:read) may read but not publish (403); a missing Idempotency-Key is refused', async () => {
    expect((await app.inject({ method: 'POST', url: url(a.businessId), payload: PERIOD })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: url(a.businessId) })).statusCode).toBe(401);
    const viewer = await viewerOf(a);
    const denied = await publish(viewer, a.businessId);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('evidence');
    expect((await latest(viewer, a.businessId)).statusCode).toBe(200);
    const noKey = await app.inject({ method: 'POST', url: url(a.businessId), headers: kit.headers(a), payload: PERIOD });
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400); expect(noKey.statusCode).toBeLessThan(500);
  });

  it('validation: impossible, reversed, over-long, malformed and unknown-field requests are 400 and persist nothing', async () => {
    const w = await kit.world(); await new Seeder(admin, scopeOf(w)).order({ date: '2026-10-05', currency: 'USD', total: '10.00' });
    for (const body of [
      { from: '2026-02-30', to: '2026-03-10' }, { from: '2026-13-01', to: '2026-13-02' }, { from: '2026-11-01', to: '2026-10-01' }, { from: '2025-01-01', to: '2026-12-31' },
      { from: '10/01/2026', to: '2026-10-31' }, { from: '2026-10-01' }, { ...PERIOD, evidence: { revenue: '999999' } }, {},
    ]) expect((await publish(w, w.businessId, body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await app.inject({ method: 'POST', url: url('not-a-uuid'), headers: kit.headers(w, { 'idempotency-key': unique('k') }), payload: PERIOD as never })).statusCode).toBeLessThan(500);
    expect(await dtCounts(w.businessId)).toEqual({ digital_twin_definitions: 0, digital_twin_instances: 0, digital_twin_snapshots: 0 });
  });

  it('tenant isolation: a foreign business is the same 404 as a missing one on both routes; each tenant sees only its own currencies', async () => {
    const missing = randomUUID();
    const foreign = await publish(b, a.businessId); const none = await publish(b, missing);
    expect(foreign.statusCode).toBe(404); expect(none.statusCode).toBe(404);
    const shape = (res: { body: string }, asked: string) => JSON.parse(res.body.split(asked).join('<asked>').replace(/"correlationId":"[^"]+"/, '"correlationId":"<c>"'));
    expect(shape(foreign, a.businessId)).toEqual(shape(none, missing));
    expect((await latest(b, a.businessId)).statusCode).toBe(404);
    const own = (await publish(b, b.businessId)).json();
    expect(own.state.evidence.financial.currencies.map((c: any) => c.currency)).toEqual(['EUR']);
    expect(JSON.stringify(own)).not.toContain('KWD');
    expect(JSON.stringify((await latest(b, b.businessId)).json())).not.toContain('KWD');
  });

  it('business isolation: a sibling business in the same workspace has its own twin and its figures never enter this business\'s state', async () => {
    const mine = (await publish(a, a.businessId)).json();
    expect(mine.state.evidence.financial.currencies.map((c: any) => c.currency)).not.toContain('JPY');
    const theirs = await publish(a, sibling.businessId);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().state.evidence.financial.currencies.map((c: any) => c.currency)).toEqual(['JPY']);
    expect(theirs.json().state.evidence.businessId).toBe(sibling.businessId);
    expect(JSON.stringify((await latest(a, sibling.businessId)).json())).not.toContain('KWD');
    expect((await latest(a, a.businessId)).json().state.evidence.businessId).toBe(a.businessId);
  });

  it('writes only Digital Twin tables: orders, lines, BO and BI rows are unchanged by publishing and reading', async () => {
    const tables = ['platform.orders', 'business_operations.order_line_items', 'business_operations.expense_items', 'business_operations.inventory_movements', 'business_intelligence.insight_packages', 'business_intelligence.metric_calculated_values'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [a.ctx.tenantId])).rows[0].n)));
    const before = await snap();
    expect((await publish(a, a.businessId)).statusCode).toBe(201);
    expect((await latest(a, a.businessId)).statusCode).toBe(200);
    expect(await snap()).toEqual(before);
  });
});
