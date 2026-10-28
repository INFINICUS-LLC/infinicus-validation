/**
 * AC-3 Block 2 - Criterion J, gaps J-1 (business scope) and J-6 (approver grantee membership). Real PostgreSQL, production buildApp.
 *
 * Authority chain under test:  authenticated session principal -> authoritative membership -> authoritative permission -> authoritative business scope.
 * Browser/path/body identifiers identify TARGETS only; they never create authority.
 *
 *   1 forged approverUserId cannot grant authority                 9  correct principal + membership + permission succeeds
 *   2 forged businessId cannot cross tenant / workspace scope       10 grantee without ACTIVE workspace membership cannot receive authority
 *   3 extra body identity fields cannot choose the actor            11 inactive / revoked membership cannot receive or exercise authority
 *   4 unauthenticated -> 401                                        12 permission / role revocation takes effect on the next request
 *   5 authenticated, no permission -> 403                           13 audit actor equals the authenticated principal
 *   6 authenticated, wrong business -> 404                          14 no HTTP route can inject an already-approved action into BO
 *   7 unknown business -> the same 404 as a foreign business        15 AC-2 governed evidence/execution semantics: unchanged (see the report; the AC-2 suites run untouched)
 *   8 a wrong-business attempt creates no authoritative row in either tenant
 *   +  the previously probe-indeterminate business-scoped routes are pinned with VALID bodies, so validation cannot hide a missing scope guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE, DecisionWorkflowService } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';
import { chainKit } from './helpers/authorizedPackageChain.js';
import { changedTenantRows, isTestFixtureTable } from './helpers/tenantRowCountDiff.js';

const run = !!process.env.DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const ABA = 'approved_business_action';

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];

interface World { ctx: TenantContext; token: string; bizId: string; membershipId: string }
type MemberStatus = 'invited' | 'active' | 'suspended' | 'removed';

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('ac3')}@ac3.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(login.statusCode).toBe(200);
  return { userId, token: login.json().rawSessionToken as string };
}

const roleId = async (code: string) => (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [code])).rows[0].id as string;

/** Gives `userId` a membership in the world's workspace at the requested status, optionally holding a system role. */
async function addMembership(w: Pick<World, 'ctx'>, userId: string, status: MemberStatus, role: string | null): Promise<string> {
  const ctx: TenantContext = { ...w.ctx, userId };
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  if (status !== 'invited') await memberships.activate(ctx, m.id);
  if (status === 'suspended') await memberships.suspend(ctx, m.id);
  if (status === 'removed') await memberships.remove(ctx, m.id);
  if (role) await memberships.assignRole(ctx, m.id, await roleId(role));
  return m.id;
}

/** A fresh tenant + workspace + business and one principal with an ACTIVE membership holding the given system role (or none). */
async function newWorld(role: string | null = 'owner'): Promise<World> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  tenantIds.push(tenantId);
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'AC3 Tenant',$2,'active','test')`, [tenantId, `ac3-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'AC3 WS',$3,'active')`, [workspaceId, tenantId, `ac3-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const membershipId = await addMembership({ ctx }, userId, 'active', role);
  const bizId = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ AC3 Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('ac3-biz')]);
  const w = { ctx, token, bizId, membershipId };
  // The first mutating request of a tenant lazily provisions its billing subscription (+ outbox event). Do that once here, with one
  // legitimate request on the tenant's own business, so the row-count proofs below measure only what a REFUSED request would add.
  if (role === 'owner') expect((await call(w, 'POST', `/v1/businesses/${bizId}/products`, { name: 'Warm-up', price: 1 })).statusCode).toBe(201);
  return w;
}

/** Another registered user acting inside `w`'s workspace with the given membership status / role. */
async function member(w: World, status: MemberStatus, role: string | null) {
  const u = await registerActiveUser();
  const membershipId = await addMembership(w, u.userId, status, role);
  return { ...u, membershipId, ctx: { ...w.ctx, userId: u.userId } as TenantContext };
}

const hdr = (p: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${p.token}`, 'x-tenant-id': p.ctx.tenantId, 'x-workspace-id': p.ctx.workspaceId, ...extra,
});
const call = (p: { ctx: TenantContext; token: string }, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: method === 'GET' ? hdr(p, extra) : hdr(p, { 'idempotency-key': uc('key'), ...extra }), ...(payload === undefined ? {} : { payload: payload as never }) });
const grant = (p: World, bizId: string, approverUserId: string, assignmentCode: string, roleCode: string = 'business-owner', extra: Record<string, unknown> = {}) =>
  call(p, 'POST', `/v1/businesses/${bizId}/approver-assignments`, { approverUserId, assignmentCode, roleCode, ...extra });

const one = async (sql: string, args: unknown[]) => Number((await admin.query(sql, args)).rows[0].n);
const assignments = (bizId: string) => one(`SELECT count(*)::int n FROM ${ABA}.approver_assignments WHERE business_id=$1`, [bizId]);
const decided = (bizId: string) => one(`SELECT count(*)::int n FROM ${ABA}.approval_decisions WHERE business_id=$1`, [bizId]);
const outcomesFor = (bizId: string) => one(`SELECT count(*)::int n FROM outcome_monitoring.outcome_observations WHERE business_id=$1`, [bizId]);
const auditRows = async (bizId: string) => (await admin.query(`SELECT event_type, detail FROM ${ABA}.approval_audit_events WHERE business_id=$1 ORDER BY created_at`, [bizId])).rows;

/**
 * Row counts of EVERY tenant-scoped table (all schemas except the API idempotency store and observability) for the given tenants. Test fixture tables
 * that other suites create and drop in the shared database (`*_fixture`) are not product schema and are skipped, otherwise a concurrent drop makes the snapshot flaky.
 */
async function authoritativeRows(tenants: string[], ignore: string[] = []): Promise<Record<string, number>> {
  const tables = (await admin.query(
    `SELECT table_schema s, table_name t FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema NOT IN ('api','observability','information_schema','pg_catalog')
     GROUP BY 1,2 ORDER BY 1,2`)).rows as { s: string; t: string }[];
  const out: Record<string, number> = {};
  for (const { s, t } of tables.filter(({ s, t }) => !ignore.includes(`${s}.${t}`) && !isTestFixtureTable(`${s}.${t}`))) out[`${s}.${t}`] = Number((await admin.query(`SELECT count(*)::int n FROM "${s}"."${t}" WHERE tenant_id = ANY($1)`, [tenants])).rows[0].n);
  return out;
}

/** The caller-visible shape of an error, with the caller-supplied id masked and the per-request correlation id dropped. */
const shape = (res: { statusCode: number; json(): { error?: { code?: string; message?: string } } }, ...ids: string[]) => {
  const e = res.json().error ?? {};
  let message = e.message ?? '';
  for (const id of ids) message = message.split(id).join('<ID>');
  return { status: res.statusCode, code: e.code, message, keys: Object.keys(e).sort() };
};

interface Req { name: string; method: 'GET' | 'POST' | 'PUT'; url: (bizId: string) => string; body?: () => unknown }

/** Every J-1 entry point (service-level guard), with VALID bodies so only the scope guard can stop them. */
function j1Routes(ids: { intake: string; recommendation: string }): Req[] {
  const base = (b: string) => `/v1/businesses/${b}`;
  return [
    { name: 'approver-assignment create', method: 'POST', url: (b) => `${base(b)}/approver-assignments`, body: () => ({ approverUserId: randomUUID(), assignmentCode: uc('x'), roleCode: 'business-owner' }) },
    { name: 'approver-assignment read', method: 'GET', url: (b) => `${base(b)}/approver-assignments/some-code` },
    { name: 'approver-assignment revoke', method: 'POST', url: (b) => `${base(b)}/approver-assignments/some-code/revoke`, body: () => ({ reason: 'ac3 j-1 probe' }) },
    { name: 'create review + submit decision', method: 'POST', url: (b) => `${base(b)}/decisions`, body: () => ({ intakePackageId: ids.intake, reviewCode: uc('r'), summary: 's', assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' }) },
    { name: 'record outcome', method: 'POST', url: (b) => `${base(b)}/outcomes`, body: () => ({ monitoredActionId: randomUUID(), observationCode: uc('o'), summary: 's', effectiveAt: new Date().toISOString() }) },
    { name: 'recommendation choice', method: 'POST', url: (b) => `${base(b)}/decision-recommendations/${ids.recommendation}/choice`, body: () => ({ chosen: true }) },
    { name: 'recommendation outcome', method: 'POST', url: (b) => `${base(b)}/decision-recommendations/outcome`, body: () => ({ approvedActionId: randomUUID(), outcomeNotes: 'ac3 j-1 probe' }) },
    { name: 'workflow view (privileged read)', method: 'GET', url: (b) => `${base(b)}/workflow` },
    { name: 'decision history read', method: 'GET', url: (b) => `${base(b)}/decision-recommendations/history` },
  ];
}
const send = (p: { ctx: TenantContext; token: string }, r: Req, bizId: string) => call(p, r.method, r.url(bizId), r.body?.());

/** Business-scoped routes the Block 1 probe could not decide (a 400 from body validation came first). Each carries a VALID request. */
function probeIndeterminate(): Req[] {
  const base = (b: string) => `/v1/businesses/${b}`;
  const now = Date.now();
  const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
  return [
    { name: 'POST events', method: 'POST', url: (b) => `${base(b)}/events`, body: () => ({ eventType: 'sale', amount: 10 }) },
    { name: 'GET events/summary', method: 'GET', url: (b) => `${base(b)}/events/summary?from=${new Date(now - 864e5).toISOString()}&to=${new Date(now).toISOString()}` },
    { name: 'POST products', method: 'POST', url: (b) => `${base(b)}/products`, body: () => ({ name: 'Widget', price: 1 }) },
    { name: 'POST register-sessions', method: 'POST', url: (b) => `${base(b)}/register-sessions`, body: () => ({ openingCash: 0 }) },
    { name: 'GET operations/summary', method: 'GET', url: (b) => `${base(b)}/operations/summary?from=${new Date(now - 864e5).toISOString()}&to=${new Date(now).toISOString()}` },
    { name: 'PUT execution-activations', method: 'PUT', url: (b) => `${base(b)}/execution-activations`, body: () => ({ actionType: ACTION, state: 'ENABLED', reason: 'ac3 probe' }) },
    { name: 'POST execution-recoveries', method: 'POST', url: (b) => `${base(b)}/execution-recoveries`, body: () => ({ actionType: ACTION, reason: 'ac3 probe' }) },
    { name: 'POST inventory-policy-evaluations', method: 'POST', url: (b) => `${base(b)}/inventory-policy-evaluations`, body: () => ({ actionType: ACTION, target: { kind: 'inventory_item', id: randomUUID() }, finalParameters: { reorderPoint: 1, reorderQuantity: 2 }, ruleSetVersion: 'inventory-reorder-policy/v1.1.0' }) },
    { name: 'POST bi-evidence', method: 'POST', url: (b) => `${base(b)}/inventory-items/${randomUUID()}/bi-evidence`, body: () => ({ ruleSetVersion: 'inventory-reorder-policy/v1.1.0' }) },
  ];
}

describe.runIf(run)('AC-3 Block 2 - J-1 business scope + J-6 approver grantee membership (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  // ---------------------------------------------------------------------------------------------------------------
  describe('1-2. browser/path/body identifiers identify targets only', () => {
    it('1. a forged approverUserId cannot grant authority: a user from another tenant, an unknown user and a non-member are all refused, nothing is created', async () => {
      const a = await newWorld(); const b = await newWorld();
      const stranger = await registerActiveUser();   // exists, but has no membership anywhere
      const before = await assignments(a.bizId);
      const outcomes = [];
      for (const forged of [b.ctx.userId, randomUUID(), stranger.userId]) {
        const res = await grant(a, a.bizId, forged, uc('forged'));
        outcomes.push(shape(res, forged));
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('ApproverGranteeNotEligibleError');
      }
      // one status, one code, one message for every reason: nothing to probe which user exists elsewhere
      expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
      expect(await assignments(a.bizId)).toBe(before);
      expect(await assignments(b.bizId)).toBe(0);
    });

    it('1b. a forged approverUserId on a decision never decides for another user: the approver is always the authenticated principal', async () => {
      const a = await newWorld();
      const other = await member(a, 'active', 'owner');
      expect((await grant(a, a.bizId, other.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE)).statusCode).toBe(201);   // the OTHER user holds authority
      const { intakePackageId } = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const res = await call(a, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: other.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve' });
      expect(res.statusCode).toBe(403);
      expect(await decided(a.bizId)).toBe(0);
    });

    it('2. a forged businessId cannot cross tenant scope: every business-scoped J-1 route answers 404 for another tenant\'s business', async () => {
      const a = await newWorld(); const b = await newWorld();
      const fixture = await createAbaFixture(b.ctx, b.bizId, APPROVABLE_FACTS);
      for (const r of j1Routes({ intake: fixture.intakePackageId, recommendation: fixture.recommendationId })) {
        const res = await send(a, r, b.bizId);
        expect(res.statusCode, `${r.name}: ${res.body}`).toBe(404);
      }
    });

    it('2b. a forged businessId cannot cross WORKSPACE scope inside one tenant: a business of another workspace is 404 to a member of this one', async () => {
      const a = await newWorld();
      const ws2 = randomUUID(); const biz2 = randomUUID();
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'AC3 WS2',$3,'active')`, [ws2, a.ctx.tenantId, `ac3-ws2-${uc('s')}`]);
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ AC3 Other WS Biz',$4,'active')`, [biz2, a.ctx.tenantId, ws2, uc('ac3-biz2')]);
      const fixture = await createAbaFixture({ ...a.ctx, workspaceId: ws2 }, biz2, APPROVABLE_FACTS);
      const before = await authoritativeRows([a.ctx.tenantId]);
      for (const r of j1Routes({ intake: fixture.intakePackageId, recommendation: fixture.recommendationId })) {
        const res = await send(a, r, biz2);
        expect(res.statusCode, `${r.name}: ${res.body}`).toBe(404);
      }
      expect(changedTenantRows(before, await authoritativeRows([a.ctx.tenantId]))).toEqual({});
    });

    it('3. extra identity fields in a request body cannot choose the actor: the decision, its audit and the grant provenance all name the authenticated principal', async () => {
      const a = await newWorld(); const decoy = await member(a, 'active', 'owner');
      const forge = { userId: decoy.userId, actorUserId: decoy.userId, createdBy: decoy.userId, assignedByUserId: decoy.userId, tenantId: randomUUID(), workspaceId: randomUUID(), permissionUsed: 'platform:admin' };
      const g = await grant(a, a.bizId, a.ctx.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE, 'business-owner', forge);
      expect(g.statusCode).toBe(201);
      const rec = await call(a, 'GET', `/v1/businesses/${a.bizId}/approver-assignments/${DEFAULT_APPROVER_ASSIGNMENT_CODE}`);
      expect(rec.statusCode).toBe(200);
      expect(rec.json().provenance[0].actor.id).toBe(a.ctx.userId);
      expect(JSON.stringify(rec.json().provenance)).not.toContain(decoy.userId);

      const { intakePackageId } = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const d = await call(a, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve', ...forge });
      expect(d.statusCode).toBe(201);
      const audit = await auditRows(a.bizId);
      expect(audit.map((r) => r.event_type)).toEqual(['approval.approved']);
      expect(audit[0].detail.approver.userId).toBe(a.ctx.userId);
      expect(audit[0].detail.permissionUsed).toBe('aba:write');   // set by the route, never by the body
      expect(JSON.stringify(audit[0].detail)).not.toContain(decoy.userId);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('4-8. authentication, permission and scope are evaluated in that order, server-side', () => {
    it('4. unauthenticated requests are 401 on every J-1 route (no token, malformed header, invalid token)', async () => {
      const a = await newWorld();
      const fx = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      for (const r of j1Routes({ intake: fx.intakePackageId, recommendation: fx.recommendationId })) {
        for (const authorization of [undefined, 'Basic abc', 'Bearer not-a-real-session-token']) {
          const res = await app.inject({
            method: r.method, url: r.url(a.bizId),
            headers: { 'x-tenant-id': a.ctx.tenantId, 'x-workspace-id': a.ctx.workspaceId, 'idempotency-key': uc('k'), ...(authorization ? { authorization } : {}) },
            ...(r.body ? { payload: r.body() as never } : {}),
          });
          expect(res.statusCode, `${r.name} / ${authorization}`).toBe(401);
        }
      }
    });

    it('5. an authenticated active member WITHOUT the required permission is 403 on every J-1 route, and nothing is written', async () => {
      const a = await newWorld(); const p = await member(a, 'active', null);   // active member, no role => no permission
      const fx = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      // A permission denial is itself recorded by the authorization layer in audit.access_events (a security log in the caller's own tenant,
      // not business state); every other table must be untouched.
      const SECURITY_LOG = ['audit.access_events'];
      const before = await authoritativeRows([a.ctx.tenantId], SECURITY_LOG);
      for (const r of j1Routes({ intake: fx.intakePackageId, recommendation: fx.recommendationId })) {
        const res = await send({ ctx: p.ctx, token: p.token }, r, a.bizId);
        expect(res.statusCode, `${r.name}: ${res.body}`).toBe(403);
      }
      expect(changedTenantRows(before, await authoritativeRows([a.ctx.tenantId], SECURITY_LOG))).toEqual({});
    });

    it('6+7. a wrong-business principal and an unknown business get the IDENTICAL 404 (status, code, message shape): no existence oracle, no foreign-key 500', async () => {
      const a = await newWorld(); const b = await newWorld();
      const fx = await createAbaFixture(b.ctx, b.bizId, APPROVABLE_FACTS);
      const unknownBiz = randomUUID();
      for (const r of j1Routes({ intake: fx.intakePackageId, recommendation: fx.recommendationId })) {
        const foreign = await send(a, r, b.bizId);
        const unknown = await send(a, r, unknownBiz);
        expect(foreign.statusCode, `${r.name} foreign`).toBe(404);
        expect(unknown.statusCode, `${r.name} unknown`).toBe(404);
        expect(shape(foreign, b.bizId), r.name).toEqual(shape(unknown, unknownBiz));
      }
    });

    it('8. wrong-business attempts create NO authoritative row in either tenant (every tenant-scoped table, before == after) and no 5xx', async () => {
      const a = await newWorld(); const b = await newWorld();
      const fx = await createAbaFixture(b.ctx, b.bizId, APPROVABLE_FACTS);
      // B has real authority and real pending work: the strongest case for a leak
      expect((await grant(b, b.bizId, b.ctx.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE)).statusCode).toBe(201);
      const both = [a.ctx.tenantId, b.ctx.tenantId];
      const before = await authoritativeRows(both);
      const idemCount = (t: string) => one(`SELECT count(*)::int n FROM api.idempotency_keys WHERE tenant_id=$1`, [t]);
      const idemBefore = await idemCount(a.ctx.tenantId);
      const idemBeforeB = await idemCount(b.ctx.tenantId);
      for (const target of [b.bizId, randomUUID()]) {
        for (const r of j1Routes({ intake: fx.intakePackageId, recommendation: fx.recommendationId })) {
          const res = await send(a, r, target);
          expect(res.statusCode, r.name).toBe(404);
        }
      }
      expect(changedTenantRows(before, await authoritativeRows(both))).toEqual({});
      expect(await decided(b.bizId)).toBe(0);
      expect(await outcomesFor(b.bizId)).toBe(0);
      // The only trace is API replay bookkeeping in the CALLER's own tenant: the route template (never the foreign id) and the answer.
      const idem = (await admin.query(`SELECT route FROM api.idempotency_keys WHERE tenant_id=$1`, [a.ctx.tenantId])).rows.map((r) => r.route as string);
      expect(idem.length).toBeGreaterThan(idemBefore);
      expect(idem.some((route) => route.includes(b.bizId))).toBe(false);
      expect(await idemCount(b.ctx.tenantId)).toBe(idemBeforeB);   // nothing at all reached the target tenant
    });

    it('8b. the previously probe-indeterminate routes answer 404 for a foreign business with a VALID request (validation cannot hide a missing guard), identical to an unknown business', async () => {
      const a = await newWorld(); const b = await newWorld();
      const unknownBiz = randomUUID();
      const before = await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]);
      for (const r of probeIndeterminate()) {
        const foreign = await send(a, r, b.bizId);
        const unknown = await send(a, r, unknownBiz);
        expect(foreign.statusCode, `${r.name} foreign: ${foreign.body}`).toBe(404);
        expect(unknown.statusCode, `${r.name} unknown: ${unknown.body}`).toBe(404);
        expect(shape(foreign, b.bizId), r.name).toEqual(shape(unknown, unknownBiz));
      }
      expect(changedTenantRows(before, await authoritativeRows([a.ctx.tenantId, b.ctx.tenantId]))).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('9. the legitimate path is untouched', () => {
    it('9. correct principal + active membership + permission + own business: grant, read, decide (plain and through a recommendation choice), revoke all succeed', async () => {
      const a = await newWorld();
      const code = uc('ok');
      expect((await grant(a, a.bizId, a.ctx.userId, code)).statusCode).toBe(201);
      expect((await call(a, 'GET', `/v1/businesses/${a.bizId}/approver-assignments/${code}`)).statusCode).toBe(200);
      const { intakePackageId } = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const d = await call(a, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' });
      expect(d.statusCode, d.body).toBe(201);
      expect(d.json().status).toBe('approved');

      expect((await grant(a, a.bizId, a.ctx.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE)).statusCode).toBe(201);
      const { recommendationId } = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const choice = await call(a, 'POST', `/v1/businesses/${a.bizId}/decision-recommendations/${recommendationId}/choice`, { chosen: true });
      expect(choice.statusCode, choice.body).toBe(201);
      expect(choice.json().approved).toBe(true);

      const rv = await call(a, 'POST', `/v1/businesses/${a.bizId}/approver-assignments/${code}/revoke`, { reason: 'ac3 legit path' });
      expect(rv.statusCode).toBe(200);
      expect(rv.json().status).toBe('revoked');
      expect((await call(a, 'GET', `/v1/businesses/${a.bizId}/workflow`)).statusCode).toBe(200);
      expect((await call(a, 'GET', `/v1/businesses/${a.bizId}/decision-recommendations/history`)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('10-11. J-6: approver authority needs an ACTIVE membership at grant time and at exercise time', () => {
    it('10. a grantee without an ACTIVE membership in the workspace cannot receive an approver assignment (invited / suspended / removed / none / other tenant / unknown)', async () => {
      const a = await newWorld(); const b = await newWorld();
      const grantees = [
        ['invited', (await member(a, 'invited', 'owner')).userId],
        ['suspended', (await member(a, 'suspended', 'owner')).userId],
        ['removed', (await member(a, 'removed', 'owner')).userId],
        ['no membership', (await registerActiveUser()).userId],
        ['member of another tenant', b.ctx.userId],
        ['unknown user', randomUUID()],
      ] as const;
      const seen = new Set<string>();
      for (const [why, userId] of grantees) {
        const code = uc('j6');
        const res = await grant(a, a.bizId, userId, code);
        expect(res.statusCode, `${why}: ${res.body}`).toBe(400);
        expect(res.json().error.code, why).toBe('ApproverGranteeNotEligibleError');
        seen.add(JSON.stringify(shape(res, userId)));
      }
      expect(seen.size).toBe(1);                          // identical for every reason
      expect(await assignments(a.bizId)).toBe(0);         // nothing was created
      const ok = await member(a, 'active', 'member');     // and an ACTIVE member is accepted
      expect((await grant(a, a.bizId, ok.userId, uc('j6-ok'))).statusCode).toBe(201);
      expect(await assignments(a.bizId)).toBe(1);
    });

    it('11. an inactive membership cannot EXERCISE authority granted earlier: suspended => 403 over HTTP and refused by the service itself', async () => {
      const a = await newWorld();
      const m = await member(a, 'active', 'owner');
      const code = uc('j6-x');
      expect((await grant(a, a.bizId, m.userId, code)).statusCode).toBe(201);
      const first = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const okRes = await call({ ctx: m.ctx, token: m.token }, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId: first.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' });
      expect(okRes.statusCode, okRes.body).toBe(201);   // while active, the grantee can decide
      expect(await decided(a.bizId)).toBe(1);

      await new MembershipRepository().suspend(m.ctx, m.membershipId);
      const second = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const body = { intakePackageId: second.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' };
      expect((await call({ ctx: m.ctx, token: m.token }, 'POST', `/v1/businesses/${a.bizId}/decisions`, body)).statusCode).toBe(403);
      expect(await decided(a.bizId)).toBe(1);
      // Defence in depth: even when called past the HTTP membership check, the service will not exercise authority for a non-member.
      const svc = new DecisionWorkflowService();
      const review = await svc.createReview(m.ctx, a.bizId, { intakePackageId: second.intakePackageId, reviewCode: uc('rv'), summary: 'direct' });
      await expect(svc.submitApprovalDecision(m.ctx, a.bizId, { reviewPackageId: review.id, assignmentCode: code, decisionCode: uc('d'), summary: 'direct', outcome: 'approve' }))
        .rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });
      expect(await decided(a.bizId)).toBe(1);
    });

    it('11b. a removed membership and a revoked assignment each end authority on the next request', async () => {
      const a = await newWorld();
      const m = await member(a, 'active', 'owner');
      const code = uc('j6-r');
      expect((await grant(a, a.bizId, m.userId, code)).statusCode).toBe(201);
      expect((await call(a, 'POST', `/v1/businesses/${a.bizId}/approver-assignments/${code}/revoke`, { reason: 'ac3 revoke' })).statusCode).toBe(200);
      const fx = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const res = await call({ ctx: m.ctx, token: m.token }, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId: fx.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
      expect(await decided(a.bizId)).toBe(0);
      await new MembershipRepository().remove(m.ctx, m.membershipId);
      expect((await call({ ctx: m.ctx, token: m.token }, 'GET', `/v1/businesses/${a.bizId}/workflow`)).statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('12-13. permissions are read per request; the audit actor is the session principal', () => {
    it('12. revoking a role takes effect on the very next request (grant, decide and outcome routes), nothing is cached', async () => {
      const a = await newWorld(); const m = await member(a, 'active', 'owner');
      expect((await grant({ ...a, ctx: m.ctx, token: m.token }, a.bizId, m.userId, uc('p1'))).statusCode).toBe(201);   // allowed: owner role
      await new MembershipRepository().revokeRole(m.ctx, m.membershipId, await roleId('owner'));
      const before = await assignments(a.bizId);
      expect((await grant({ ...a, ctx: m.ctx, token: m.token }, a.bizId, m.userId, uc('p2'))).statusCode).toBe(403);   // same token, next request
      const fx = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      expect((await call({ ctx: m.ctx, token: m.token }, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId: fx.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' })).statusCode).toBe(403);
      expect((await call({ ctx: m.ctx, token: m.token }, 'POST', `/v1/businesses/${a.bizId}/outcomes`, { monitoredActionId: randomUUID(), observationCode: uc('o'), summary: 's', effectiveAt: new Date().toISOString() })).statusCode).toBe(403);
      expect(await assignments(a.bizId)).toBe(before);
    });

    it('13. the audit actor of every approval and refusal equals the authenticated session principal', async () => {
      const a = await newWorld(); const other = await member(a, 'active', 'owner');
      expect((await grant(a, a.bizId, a.ctx.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE)).statusCode).toBe(201);
      const f1 = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      expect((await call(a, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId: f1.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve' })).statusCode).toBe(201);
      // a refusal by a principal who holds no authority is attributed to THAT principal, not to anyone named in the body
      const f2 = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const refused = await call({ ctx: other.ctx, token: other.token }, 'POST', `/v1/businesses/${a.bizId}/decisions`, { intakePackageId: f2.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve', approverUserId: a.ctx.userId });
      expect(refused.statusCode).toBe(403);
      const rows = await auditRows(a.bizId);
      expect(rows.map((r) => r.event_type)).toEqual(['approval.approved', 'approval.denied']);
      expect(rows[0].detail.approver.userId).toBe(a.ctx.userId);
      expect(rows[1].detail.approver.userId).toBe(other.userId);
      const prov = (await call(a, 'GET', `/v1/businesses/${a.bizId}/approver-assignments/${DEFAULT_APPROVER_ASSIGNMENT_CODE}`)).json().provenance;
      expect(prov.every((p: { actor: { id: string } }) => p.actor.id === a.ctx.userId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('14. no HTTP route injects an already-approved action into Business Operations', () => {
    // The mutating routes that can influence BO policy, execution or approval state are exactly these, and all are governed
    // (permissioned and, for execution, reached only through ABA issuance + the event worker). A new one must be added HERE on purpose.
    const GOVERNED = [
      '/:businessId/approver-assignments (POST)',
      '/:businessId/authorized-actions/:actionId/boundaries (POST)',
      '/:businessId/authorized-actions/:actionId/capture (POST)',
      '/:businessId/authorized-actions/:actionId/owner (POST)',
      '/:businessId/authorized-actions/:actionId/package (POST)',
      '/:businessId/decision-recommendations (POST)',
      '/:businessId/decisions (POST)',
      '/:businessId/execution-activations (PUT, GET, HEAD)',
      '/:businessId/execution-recoveries (POST)',
      '/:businessId/inventory-items/:itemId/reorder-policy-recommendation (POST)',   // ADI producer: authors a recommendation, writes nothing to BO
      '/:businessId/inventory-items/:itemId/warehouses/:warehouseId/initial-reorder-policy (PUT)',
      '/:businessId/inventory-policy-evaluations (POST)',
      '/:businessId/operations/intake/:publicationPackageId (POST)',
    ];
    it('the mutating routes touching approval / authorization / execution / reorder policy are exactly the governed set', () => {
      const labels = app.printRoutes({ commonPrefix: false }).split('\n')
        .map((l) => /──\s+(\/\S+ \([A-Z, ]+\))\s*$/.exec(l)?.[1]).filter((x): x is string => !!x)
        .filter((l) => /\((?:[A-Z, ]*)(POST|PUT|PATCH|DELETE)/.test(l))
        .filter((l) => /approv|authorized-action|decision|execut|reorder|policy|operations\/intake/.test(l));
      // Fastify prints its routes as a tree. Once a route exists at exactly /:businessId (GET /v1/businesses/:businessId), that segment becomes a shared parent
      // node and the labels of its children no longer repeat it. The SET of governed routes is what this test pins, so both sides drop the leading business
      // segment before they are compared; every other part of the label and the HTTP methods still have to match exactly.
      const withoutBusinessSegment = (l: string): string => l.replace(/^\/:businessId(?=\/)/, '');
      expect(labels.map(withoutBusinessSegment).sort()).toEqual(GOVERNED.map(withoutBusinessSegment).sort());
    });

    it('there is no route that accepts an approved action, an approval claim or an execution command for BO; guessed paths are 404', async () => {
      const a = await newWorld();
      const tries: [string, string][] = [
        ['POST', `/v1/businesses/${a.bizId}/approved-actions`],
        ['POST', `/v1/businesses/${a.bizId}/operations/approved-actions`],
        ['POST', `/v1/businesses/${a.bizId}/operations/execute`],
        ['PUT', `/v1/businesses/${a.bizId}/inventory-items/${randomUUID()}/reorder-policy`],
        ['POST', `/v1/businesses/${a.bizId}/authorized-actions/${randomUUID()}/execute`],
        ['POST', `/v1/businesses/${a.bizId}/authorized-actions/${randomUUID()}/approve`],
      ];
      for (const [method, url] of tries) {
        const res = await app.inject({ method: method as 'POST' | 'PUT', url, headers: hdr(a, { 'idempotency-key': uc('k') }), payload: { approved: true, approvedActionId: randomUUID(), reorderPoint: 1, reorderQuantity: 1 } });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    });

    it('the one BO policy writer rejects approval claims in its body and cannot overwrite an existing policy', async () => {
      const ck = chainKit({ app, admin, tenantIds });
      const s = await ck.setup();
      const { itemId, warehouseId, balanceId } = await ck.seedBo(s);
      const url = `/v1/businesses/${s.bizId}/inventory-items/${itemId}/warehouses/${warehouseId}/initial-reorder-policy`;
      const policy = async () => (await admin.query(`SELECT reorder_point, reorder_quantity FROM business_operations.inventory_balances WHERE id=$1`, [balanceId])).rows[0];
      const seeded = await policy();
      const claim = await ck.put(s, url, { reorderPoint: 5, reorderQuantity: 6, approved: true, approvedActionId: randomUUID(), authorizedActionId: randomUUID() });
      expect(claim.statusCode).toBe(400);
      expect(await policy()).toEqual(seeded);                      // an approval claim changed nothing
      const first = await ck.put(s, url, { reorderPoint: 170, reorderQuantity: 190 });   // the one sanctioned first statement (bo:admin, audited)
      expect(first.statusCode, first.body).toBe(200);
      const configured = await policy();
      const overwrite = await ck.put(s, url, { reorderPoint: 5, reorderQuantity: 6 });
      expect(overwrite.statusCode).toBe(409);                      // refused once configured: no HTTP route replaces a policy
      expect(await policy()).toEqual(configured);
    });
  });
});
