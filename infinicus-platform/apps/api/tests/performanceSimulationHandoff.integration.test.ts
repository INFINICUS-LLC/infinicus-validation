/**
 * NEW-BDT-SIM-01 + SEC-01 - the Digital Twin -> Simulation hand-off of the published business performance state: live PostgreSQL + the production buildApp (RLS enforced).
 * The success paths inject a TEST-ONLY Twin Confidence policy (no methodology is ratified); a second app built with the DEFAULT composition proves the endpoint is closed.
 * The REAL BI services produce the evidence, the real twin publishes it, and the hand-off is cut from the published state. Checked end to end: the hand-off satisfies
 * the frozen DT -> SIM contract, its variables equal the BI figures, replay, refusal without a state, authorization, validation, tenant and business isolation, and
 * that Simulation, operational and BI tables are never written. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { validateDTToSIMHandoff } from '@infinicus/handoff-contracts';
import { buildApp } from '../src/app.js';
import { buildPerformanceSimulationHandoffService } from '../src/performanceSimulationHandoffComposition.js';
import { testConfidencePolicy } from '../../../packages/workflow/tests/helpers/performanceFixtures.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';
import { Seeder, addBusiness } from '../../../packages/database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

let app: FastifyInstance;
let closedApp: FastifyInstance;        // built with the DEFAULT composition: no ratified Twin Confidence methodology
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

type Who = { ctx: TenantContext; token: string };
const twinUrl = (id: string) => `/v1/businesses/${id}/twin/business-performance`;
const handoffUrl = (id: string) => `${twinUrl(id)}/simulation-handoff`;
const post = (w: Who, url: string, body: unknown = PERIOD, key = unique('key')) => app.inject({ method: 'POST', url, headers: kit.headers(w, { 'idempotency-key': key }), payload: body as never });
const scopeOf = (w: World) => ({ tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId });
const dtRows = async (businessId: string) => Object.fromEntries(await Promise.all(['scenario_baselines', 'dt_publication_packages', 'dt_insight_packages'].map(async (t) =>
  [t, Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.${t} WHERE business_id = $1`, [businessId])).rows[0].n)])));

async function viewerOf(w: World): Promise<Who> {
  const email = `${unique('simv')}@bdt.example`;
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

describe.runIf(run)('NEW-BDT-SIM-01: DT -> Simulation hand-off of the business performance state', () => {
  let a: World; let b: World; let sibling: ReturnType<typeof scopeOf>;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' });
    app = await buildApp(config, { performanceSimulationHandoff: { service: buildPerformanceSimulationHandoffService({ confidence: testConfidencePolicy() }) } });
    closedApp = await buildApp(config);
    await app.ready(); await closedApp.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await kit.world(); b = await kit.world();
    sibling = await addBusiness(admin, scopeOf(a));
    const sa = new Seeder(admin, scopeOf(a));
    await sa.order({ date: '2026-10-05', currency: 'USD', total: '100.00', lines: [{ quantity: '2', total: '100.00' }] });
    await sa.order({ date: '2026-10-12', currency: 'USD', total: '50.00', lines: [{ quantity: '1', total: '50.00' }] });
    await sa.order({ date: '2026-10-20', currency: 'KWD', total: '31.500', lines: [{ quantity: '3', total: '31.500' }] });
    await sa.order({ date: '2026-10-21', currency: 'USD', total: '999.00', status: 'failed' });
    await new Seeder(admin, sibling).order({ date: '2026-10-05', currency: 'JPY', total: '3000', lines: [{ quantity: '1', total: '3000' }] });
    await new Seeder(admin, scopeOf(b)).order({ date: '2026-10-05', currency: 'EUR', total: '12.00', lines: [{ quantity: '1', total: '12.00' }] });
    expect((await post(a, twinUrl(a.businessId))).statusCode).toBe(201);       // the twin state the hand-off is cut from
  }, 120_000);
  afterAll(async () => { await app?.close(); await closedApp?.close(); await admin?.end(); await closePool(); });

  it('hands off the published state: 201, the frozen DT -> SIM contract satisfied, variables equal the BI report figures, a dispatched simulation package', async () => {
    const res = await post(a, handoffUrl(a.businessId));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
    expect(body.handoff.payload.quality.confidence).toBe(0.8125);                 // the gated score, never the old constant 1
    expect(body.handoff.payload.quality.confidence).not.toBe(1);
    // D2: the database, not the response, is the source of truth - the stored envelope equals what was returned, and the score row holds the basis
    const stored = (await admin.query('SELECT envelope, envelope_digest, confidence_score_id FROM business_digital_twin.dt_handoff_envelopes WHERE dt_publication_package_id = $1', [body.publicationPackageId])).rows[0];
    expect(stored.envelope).toEqual(body.handoff); expect(stored.envelope_digest).toBe(body.envelopeDigest); expect(stored.confidence_score_id).toBe(body.confidenceScoreId);
    const score = (await admin.query('SELECT confidence, basis FROM business_digital_twin.twin_confidence_scores WHERE id = $1', [body.confidenceScoreId])).rows[0];
    expect(Number(score.confidence)).toBe(0.8125); expect(JSON.parse(score.basis).factors).toHaveLength(7);
    expect(validateDTToSIMHandoff(body.handoff)).toEqual({ valid: true, reasons: [] });
    const vars = Object.fromEntries(body.handoff.payload.variables.map((v: any) => [v.variableCode, v]));
    const fin = (await app.inject({ method: 'GET', url: `/v1/businesses/${a.businessId}/intelligence/financial-report?from=${PERIOD.from}&to=${PERIOD.to}&granularity=month&compare=none`, headers: kit.headers(a) })).json();
    for (const c of fin.period.currencies) {
      expect(vars[`financial.${c.currency}.revenue`]).toEqual({ variableCode: `financial.${c.currency}.revenue`, value: c.revenue.amount, unit: c.currency });
      expect(vars[`financial.${c.currency}.grossProfit.state`].value).toBe(c.grossProfit.state);
    }
    expect(vars['sales.USD.netMinor'].value).toBe('15000'); expect(vars['sales.KWD.netMinor'].unit).toBe('KWD minor units (10^-3)');
    expect(body.handoff.payload.variables.some((v: any) => /JPY|EUR/.test(v.variableCode))).toBe(false);
    const pkg = (await admin.query('SELECT publication_status, target_layer FROM business_digital_twin.dt_publication_packages WHERE id = $1', [body.publicationPackageId])).rows[0];
    expect(pkg).toEqual({ publication_status: 'dispatched', target_layer: 'simulation' });
  });

  it('an unchanged request replays the existing hand-off (200) and creates nothing; the same Idempotency-Key replays the stored response', async () => {
    const before = await dtRows(a.businessId);
    const again = await post(a, handoffUrl(a.businessId));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: 'HANDED_OFF', replay: true, publicationStatus: 'dispatched', envelopeDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await dtRows(a.businessId)).toEqual(before);
    const key = unique('replay');
    const one = await post(a, handoffUrl(a.businessId), PERIOD, key); const two = await post(a, handoffUrl(a.businessId), PERIOD, key);
    expect(two.statusCode).toBe(one.statusCode); expect(two.json()).toEqual(one.json());
  });

  it('D1 default deny: the endpoint built with the DEFAULT composition refuses every request (CONFIDENCE_UNAVAILABLE) and persists nothing', async () => {
    const w = await kit.world(); await new Seeder(admin, scopeOf(w)).order({ date: '2026-10-05', currency: 'USD', total: '10.00', lines: [{ quantity: '1', total: '10.00' }] });
    const t = await closedApp.inject({ method: 'POST', url: twinUrl(w.businessId), headers: kit.headers(w, { 'idempotency-key': unique('k') }), payload: PERIOD });
    expect(t.statusCode).toBe(201);                                              // the twin state itself is unaffected
    const res = await closedApp.inject({ method: 'POST', url: handoffUrl(w.businessId), headers: kit.headers(w, { 'idempotency-key': unique('k') }), payload: PERIOD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'CONFIDENCE_UNAVAILABLE' });
    expect(await dtRows(w.businessId)).toEqual({ scenario_baselines: 0, dt_publication_packages: 0, dt_insight_packages: 0 });
    expect(Number((await admin.query('SELECT count(*) n FROM business_digital_twin.dt_handoff_envelopes WHERE business_id = $1', [w.businessId])).rows[0].n)).toBe(0);
  });

  it('D3: when the BI evidence changes after the twin state was published, the hand-off (and a replay) is refused until a new twin state is published', async () => {
    const w = await kit.world(); const s = new Seeder(admin, scopeOf(w));
    await s.order({ date: '2026-10-05', currency: 'USD', total: '10.00', lines: [{ quantity: '1', total: '10.00' }] });
    expect((await post(w, twinUrl(w.businessId))).statusCode).toBe(201);
    const first = await post(w, handoffUrl(w.businessId));
    expect(first.statusCode).toBe(201);
    await s.order({ date: '2026-10-09', currency: 'USD', total: '5.00', lines: [{ quantity: '1', total: '5.00' }] });          // a late order inside the period
    const stale = await post(w, handoffUrl(w.businessId));
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'SOURCE_SUPERSEDED' });                                 // replay is gated too
    expect(await dtRows(w.businessId)).toEqual({ scenario_baselines: 1, dt_publication_packages: 1, dt_insight_packages: 1 });   // the first hand-off's evidence is untouched
    expect((await post(w, twinUrl(w.businessId))).statusCode).toBe(201);                                                          // a new twin state from the new BI evidence
    const fresh = await post(w, handoffUrl(w.businessId));
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().publicationPackageId).not.toBe(first.json().publicationPackageId);
    const net = fresh.json().handoff.payload.variables.find((v: any) => v.variableCode === 'sales.USD.netMinor');
    expect(net.value).toBe('1500');
  });

  it('without a published twin state nothing is handed off: 200 NOT_HANDED_OFF TWIN_STATE_MISSING and no rows', async () => {
    const w = await kit.world();
    const res = await post(w, handoffUrl(w.businessId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'TWIN_STATE_MISSING' });
    expect(await dtRows(w.businessId)).toEqual({ scenario_baselines: 0, dt_publication_packages: 0, dt_insight_packages: 0 });
    const other = await post(a, handoffUrl(a.businessId), { from: '2026-09-01', to: '2026-09-30' });     // a period never published
    expect(other.json()).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'TWIN_STATE_MISSING' });
  });

  it('authorization: unauthenticated 401; a viewer (no dt:write) 403; a missing Idempotency-Key is refused', async () => {
    expect((await app.inject({ method: 'POST', url: handoffUrl(a.businessId), payload: PERIOD })).statusCode).toBe(401);
    const denied = await post(await viewerOf(a), handoffUrl(a.businessId));
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('variables');
    const noKey = await app.inject({ method: 'POST', url: handoffUrl(a.businessId), headers: kit.headers(a), payload: PERIOD });
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400); expect(noKey.statusCode).toBeLessThan(500);
  });

  it('validation: impossible, reversed, over-long, malformed and unknown-field requests are 400', async () => {
    for (const body of [
      { from: '2026-02-30', to: '2026-03-10' }, { from: '2026-11-01', to: '2026-10-01' }, { from: '2025-01-01', to: '2026-12-31' }, { from: '10/01/2026', to: '2026-10-31' },
      { from: '2026-10-01' }, { ...PERIOD, variables: [{ variableCode: 'x', value: '9' }] }, {},
    ]) expect((await post(a, handoffUrl(a.businessId), body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await app.inject({ method: 'POST', url: handoffUrl('not-a-uuid'), headers: kit.headers(a, { 'idempotency-key': unique('k') }), payload: PERIOD as never })).statusCode).toBeLessThan(500);
  });

  it('tenant isolation: a foreign business is the same 404 as a missing one; another tenant never receives this business\'s hand-off', async () => {
    const missing = randomUUID();
    const foreign = await post(b, handoffUrl(a.businessId)); const none = await post(b, handoffUrl(missing));
    expect(foreign.statusCode).toBe(404); expect(none.statusCode).toBe(404);
    const shape = (res: { body: string }, asked: string) => JSON.parse(res.body.split(asked).join('<asked>').replace(/"correlationId":"[^"]+"/, '"correlationId":"<c>"'));
    expect(shape(foreign, a.businessId)).toEqual(shape(none, missing));
    expect((await post(b, twinUrl(b.businessId))).statusCode).toBe(201);
    const own = (await post(b, handoffUrl(b.businessId))).json();
    expect(own.handoff.payload.businessId).toBe(b.businessId);
    expect(JSON.stringify(own)).not.toMatch(/KWD|JPY/);
  });

  it('business isolation: a sibling business in the same workspace has no state to hand off until its own is published, and never inherits this one\'s', async () => {
    expect((await post(a, handoffUrl(sibling.businessId))).json()).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'TWIN_STATE_MISSING' });
    expect((await post(a, twinUrl(sibling.businessId))).statusCode).toBe(201);
    const own = (await post(a, handoffUrl(sibling.businessId))).json();
    expect(own.handoff.payload.businessId).toBe(sibling.businessId);
    expect(own.handoff.payload.variables.map((v: any) => v.variableCode).filter((c: string) => /^(financial|sales)\./.test(c)).every((c: string) => c.includes('.JPY.'))).toBe(true);
    expect(own.publicationPackageId).not.toBe((await post(a, handoffUrl(a.businessId))).json().publicationPackageId);
  });

  it('writes only Digital Twin tables: Simulation intake, orders, BO and BI rows are unchanged', async () => {
    const tables = ['simulation.simulation_intake_packages', 'platform.orders', 'business_operations.order_line_items', 'business_intelligence.insight_packages', 'business_intelligence.metric_calculated_values'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [a.ctx.tenantId])).rows[0].n)));
    const before = await snap();
    await post(a, handoffUrl(a.businessId));
    expect(await snap()).toEqual(before);
    expect(before[0]).toBe(0);
  });
});
