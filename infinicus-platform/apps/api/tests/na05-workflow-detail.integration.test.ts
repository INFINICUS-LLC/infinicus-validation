/**
 * NA-05 - the read-only detail the web client renders: GET /v1/businesses/:id/workflow (additive fields), GET /v1/businesses/:id/history (new), and the
 * server-side default of the approver assignment code on POST .../decisions. Real PostgreSQL, production buildApp.
 *
 * Authority is unchanged: authenticated session -> active membership -> ALL layer read permissions -> business in this workspace. Nothing here widens it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;
const PASSWORD = 'Correct-Horse-9!';
let admin: Pool;
let app: FastifyInstance;

interface World { ctx: TenantContext; token: string; bizId: string }

async function registerActiveUser() {
  const email = `${uc('na05')}@na05.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: PASSWORD } });
  expect(reg.statusCode, reg.body).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}
const roleId = async (code: string) => (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [code])).rows[0].id as string;

async function newWorld(role: string | null = 'owner'): Promise<World> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'NA05 Tenant',$2,'active','test')`, [tenantId, `na05-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'NA05 WS',$3,'active')`, [workspaceId, tenantId, `na05-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  if (role) await memberships.assignRole(ctx, m.id, await roleId(role));
  const bizId = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, trading_name, business_code, legal_structure, business_model, status) VALUES ($1,$2,$3,'ZZ NA05 Biz','Trading Co',$4,'llc','b2b','active')`, [bizId, tenantId, workspaceId, uc('na05')]);
  return { ctx, token, bizId };
}
const hdr = (w: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) =>
  ({ authorization: `Bearer ${w.token}`, 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId, ...extra });
const get = (w: { ctx: TenantContext; token: string }, url: string) => app.inject({ method: 'GET', url, headers: hdr(w) });
const post = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: hdr(w, { 'idempotency-key': uc('key') }), payload: payload as never });

describe.runIf(run)('NA-05 - workflow detail and history (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('the workflow view of an empty business keeps every old count/boolean field and adds empty detail', async () => {
    const w = await newWorld();
    const res = await get(w, `/v1/businesses/${w.bizId}/workflow`);
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.business).toMatchObject({ id: w.bizId, legalName: 'ZZ NA05 Biz', tradingName: 'Trading Co', legalStructure: 'llc', businessModel: 'b2b', status: 'active' });
    expect(v).toMatchObject({ biEvidenceCount: 0, dtInstanceCount: 0, hasDtSnapshot: false, simulationRunCount: 0, hasSimulationResult: false, adiCaseCount: 0, hasAdiRecommendation: false, abaReviewCount: 0, hasAbaDecision: false, outcomeCount: 0 });
    expect(v).toMatchObject({ biEvidence: [], dtLatestSnapshot: null, simulationLatestResult: null, simulationRuns: [], adiLatestRecommendation: null, abaLatestDecision: null, outcomes: [] });
    expect(Object.keys(v).sort()).toEqual(['abaLatestDecision', 'abaReviewCount', 'adiCaseCount', 'adiLatestRecommendation', 'biEvidence', 'biEvidenceCount', 'business', 'dtInstanceCount', 'dtLatestSnapshot', 'hasAbaDecision', 'hasAdiRecommendation', 'hasDtSnapshot', 'hasSimulationResult', 'outcomeCount', 'outcomes', 'simulationLatestResult', 'simulationRunCount', 'simulationRuns']);
  });

  it('after an approval decision (assignment code omitted -> the server defaults it) the view and the history show it', async () => {
    const w = await newWorld();
    const grant = await post(w, `/v1/businesses/${w.bizId}/approver-assignments`, { approverUserId: w.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' });
    expect(grant.statusCode).toBe(201);
    const { intakePackageId } = await createAbaFixture(w.ctx, w.bizId, APPROVABLE_FACTS);
    const decisionCode = uc('dec'); const reviewCode = uc('rev');
    const d = await post(w, `/v1/businesses/${w.bizId}/decisions`, { intakePackageId, reviewCode, summary: 'approve it', decisionCode, outcome: 'approve' });   // no assignmentCode
    expect(d.statusCode, d.body).toBe(201);

    const v = (await get(w, `/v1/businesses/${w.bizId}/workflow`)).json();
    expect(v.abaReviewCount).toBe(1);
    expect(v.hasAbaDecision).toBe(true);
    expect(v.abaLatestDecision).toEqual({ decisionCode, status: d.json().status });
    const h = (await get(w, `/v1/businesses/${w.bizId}/history`)).json();
    expect(h.abaReviews).toEqual([{ id: expect.any(String), reviewCode, status: expect.any(String) }]);
    // the ABA fixture also publishes one BI evidence package, one queued simulation run and one ADI case; the history lists each, and the view agrees
    expect(h.biEvidence).toEqual([{ id: expect.any(String), packageCode: expect.stringMatching(/^insight-/), status: 'published' }]);
    expect(h.simulationRuns).toEqual([{ id: expect.any(String), runCode: expect.stringMatching(/^run-/), status: 'queued' }]);
    expect(h.adiCases).toEqual([{ id: expect.any(String), caseCode: expect.stringMatching(/^case-/), status: 'open' }]);
    expect(h.outcomes).toEqual([]);
    expect(v.biEvidence).toEqual([{ id: h.biEvidence[0].id, packageCode: h.biEvidence[0].packageCode, status: 'published', latestVersion: expect.any(Number) }]);
    expect(v.simulationRuns).toEqual([{ ...h.simulationRuns[0], sampleSize: expect.any(Number) }]);
    expect(v.outcomes).toEqual([]);
    expect(Object.keys(h).sort()).toEqual(['abaReviews', 'adiCases', 'biEvidence', 'outcomes', 'simulationRuns']);
  });

  it('an explicit assignment code is still honoured and still verified (an unknown one is refused)', async () => {
    const w = await newWorld();
    expect((await post(w, `/v1/businesses/${w.bizId}/approver-assignments`, { approverUserId: w.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' })).statusCode).toBe(201);
    const { intakePackageId } = await createAbaFixture(w.ctx, w.bizId, APPROVABLE_FACTS);
    const bad = await post(w, `/v1/businesses/${w.bizId}/decisions`, { intakePackageId, reviewCode: uc('rev'), summary: 's', assignmentCode: 'no-such-assignment', decisionCode: uc('dec'), outcome: 'approve' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(w, `/v1/businesses/${w.bizId}/workflow`)).json().hasAbaDecision).toBe(false);
  });

  it('both reads need authentication, an active membership with EVERY layer read permission, and a business in this workspace', async () => {
    const w = await newWorld(); const other = await newWorld(); const noRole = await newWorld(null);
    for (const path of ['workflow', 'history']) {
      expect((await app.inject({ method: 'GET', url: `/v1/businesses/${w.bizId}/${path}` })).statusCode, `${path} anonymous`).toBe(401);
      expect((await get(noRole, `/v1/businesses/${noRole.bizId}/${path}`)).statusCode, `${path} no role`).toBe(403);
      expect((await get(w, `/v1/businesses/${other.bizId}/${path}`)).statusCode, `${path} foreign business`).toBe(404);
      expect((await get(w, `/v1/businesses/${randomUUID()}/${path}`)).statusCode, `${path} unknown business`).toBe(404);
      expect((await get(w, `/v1/businesses/${w.bizId}/${path}`)).statusCode, `${path} owner`).toBe(200);
    }
  });

  it('the caller cannot read another tenant\'s detail by claiming that tenant\'s headers', async () => {
    const w = await newWorld(); const other = await newWorld();
    const res = await app.inject({ method: 'GET', url: `/v1/businesses/${other.bizId}/workflow`, headers: { authorization: `Bearer ${w.token}`, 'x-tenant-id': other.ctx.tenantId, 'x-workspace-id': other.ctx.workspaceId } });
    expect([403, 404]).toContain(res.statusCode);                           // not a member of that workspace: refused either way, and nothing leaks
    expect(res.body).not.toContain('ZZ NA05 Biz');
  });
});
