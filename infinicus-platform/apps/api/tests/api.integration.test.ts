/**
 * Live PostgreSQL 16 integration tests for the BUILD-21 governed
 * application API, exercising the full route surface via Fastify's
 * app.inject() (no real network socket needed) against a real database.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import {
  createPool, closePool,
  UserRepository, EmailVerificationTokenRepository, MembershipRepository, RoleRepository,
  InsightPackageRepository, BIPublicationPackageRepository,
  DTIntakeRepository, DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository,
  DigitalTwinSnapshotRepository, ScenarioBaselineRepository, DTPublicationPackageRepository,
  SimulationIntakeRepository, SimulationModelRepository, SimulationScenarioRepository,
  SimulationRunRepository, SimulationResultRepository, SimulationPublicationRepository,
  ADIIntakeRepository, DecisionQuestionRepository, DecisionCaseRepository,
  DecisionRecommendationRepository, ADIPublicationRepository,
  ABAIntakeRepository, ActionReviewRepository, ApproverAuthorityRepository,
  ApprovalDecisionRepository, ApprovedActionRepository, ABAPublicationRepository,
  OMIntakeRepository, MonitoringPlanRepository, MonitoredActionRepository,
  type TenantContext,
} from '@infinicus/database';
import { generateSessionToken, hashToken } from '@infinicus/authentication';
import { buildApp } from '../src/app.js';
import { createAbaIntake, APPROVABLE_FACTS } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;

const T1 = '88888888-9090-0000-0000-000000000001';
const WS1 = '88888888-9090-0000-0000-000000000002';

let adminPool: Pool | null = null;
let app: FastifyInstance | null = null;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@api-test.example`;
}

function uc(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const STRONG_PASSWORD = 'Correct-Horse-9!';

/** Registers + activates a user, logs in via the real HTTP route, and returns { userId, token }. */
async function registerActiveUser(): Promise<{ userId: string; token: string; email: string }> {
  const email = uniqueEmail('api-user');
  const registerRes = await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(registerRes.statusCode).toBe(201);
  const userId = registerRes.json().id as string;

  const users = new UserRepository();
  await users.activate(userId);

  const loginRes = await app!.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(loginRes.statusCode).toBe(200);
  const token = loginRes.json().rawSessionToken as string;
  return { userId, token, email };
}

/** Creates a tenant+workspace, an active membership for userId, and assigns the 'owner' role (full permissions). */
async function createTenantWithOwner(userId: string): Promise<TenantContext> {
  const memberships = new MembershipRepository();
  const roles = new RoleRepository();
  const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId };
  const membership = await memberships.create(ctx, userId);
  await memberships.activate(ctx, membership.id);
  const ownerRole = await roles.getByCode(ctx, 'owner');
  await memberships.assignRole(ctx, membership.id, ownerRole.id);
  return ctx;
}

function tenantHeaders(ctx: TenantContext, token: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': ctx.tenantId,
    'x-workspace-id': ctx.workspaceId,
  };
}

/** Extends createAbaIntake() through a full approved ABA decision + OM monitored action. Returns monitoredActionId. */
async function createMonitoredAction(ctx: TenantContext, businessId: string): Promise<string> {
  const intakePackageId = await createAbaIntake(ctx, businessId);
  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePackageId, uc('review'));
  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, ctx.userId, uc('assign'));
  const decisionRepo = new ApprovalDecisionRepository();
  const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uc('dec'), 'api fixture decision');
  await decisionRepo.approve(ctx, decision.id, version.id);
  const actionRepo = new ApprovedActionRepository();
  const action = await actionRepo.createAction(ctx, businessId, decision.id, uc('action'));
  const abaPubRepo = new ABAPublicationRepository();
  const { package: abaPub } = await abaPubRepo.createPackage(ctx, businessId, action.id, uc('aba-pub'), 'outcome_monitoring', 'OM-01', uc('idem'));

  const omIntakeRepo = new OMIntakeRepository();
  const { package: omPkg } = await omIntakeRepo.receivePackage(ctx, { businessId, abaPublicationPackageId: abaPub.id, intakeCode: uc('om-intake'), idempotencyKey: uc('idem') });
  const planRepo = new MonitoringPlanRepository();
  const { plan } = await planRepo.createPlan(ctx, businessId, omPkg.id, uc('plan'), 'api fixture plan');

  const intakePackageId2 = await createAbaIntake(ctx, businessId);
  const review2 = await reviewRepo.createReviewPackage(ctx, businessId, intakePackageId2, uc('review2'));
  const assignment2 = await authorityRepo.createAssignment(ctx, businessId, ctx.userId, uc('assign2'));
  const { decision: decision2, version: version2 } = await decisionRepo.createDecision(ctx, businessId, review2.id, assignment2.id, uc('dec2'), 'api fixture decision 2');
  await decisionRepo.approve(ctx, decision2.id, version2.id);
  const approvedAction2 = await actionRepo.createAction(ctx, businessId, decision2.id, uc('action2'));
  const monitoredRepo = new MonitoredActionRepository();
  const { action: monitoredAction } = await monitoredRepo.createMonitoredAction(ctx, businessId, plan.id, approvedAction2.id, uc('mact'), 'api fixture monitored action');
  return monitoredAction.id;
}

/** Establishes approver authority through the admin route — a request SEPARATE from deciding (V-01). */
async function grantApprover(ctx: TenantContext, token: string, bizId: string, approverUserId: string, code: string, roleCode: string = 'business-owner') {
  return app!.inject({
    method: 'POST', url: `/v1/businesses/${bizId}/approver-assignments`,
    headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('grant-key') },
    payload: { approverUserId, assignmentCode: code, roleCode },
  });
}

describe.runIf(run)('BUILD-21 governed API — live PostgreSQL', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;
    console.log('DEBUG adminUrl=', JSON.stringify(adminUrl));
    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'API-HTTP-Test Tenant','api-http-t1','active','test') ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'API-HTTP-Test WS','api-http-ws1','active') ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );

    // One app instance serves every test in this file; the global limiter's default (100 requests per
    // minute) is a production setting, so give the suite its own budget. The 'rate limiting' test below
    // asserts only that the limiter is active (headers present), not the threshold.
    const config = loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' });
    app = await buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    if (adminPool) await adminPool.end();
    await app?.close();
    await closePool();
  });

  describe('auth', () => {
    it('registers a new user, active immediately', async () => {
      const res = await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail('reg'), password: STRONG_PASSWORD } });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('active');
    });

    it('rejects registration with a weak password', async () => {
      const res = await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: uniqueEmail('weak'), password: 'weak' } });
      expect(res.statusCode).toBe(400);
    });

    it('a newly-registered account can log in immediately, with no separate activation step', async () => {
      const email = uniqueEmail('active-now');
      await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
      const res = await app!.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
      expect(res.statusCode).toBe(200);
    });

    it('verify-email confirms a valid token without affecting account status', async () => {
      // Registration already sends a real verification email as a side
      // effect (see AuthenticationService.register()) — this route test
      // doesn't re-capture that email (apps/api wires AuthenticationService
      // with its own real defaults, unlike packages/authentication's own
      // unit-level test, which injects a capturing EmailSender for exactly
      // this purpose). Here, a token is fixtured directly via the same
      // repository the real flow uses, to test the route's own wiring.
      const email = uniqueEmail('verify-flow');
      const registerRes = await app!.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
      expect(registerRes.statusCode).toBe(201);
      expect(registerRes.json().status).toBe('active');

      const verificationTokens = new EmailVerificationTokenRepository();
      const rawToken = generateSessionToken();
      await verificationTokens.create(registerRes.json().id, hashToken(rawToken), new Date(Date.now() + 60_000));

      const verifyRes = await app!.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: rawToken } });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.json().emailVerifiedAt).not.toBeNull();
      const users = new UserRepository();
      const reloaded = await users.getById(registerRes.json().id);
      expect(reloaded.status).toBe('active');
    });

    it('rejects an unknown verify-email token', async () => {
      const res = await app!.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: 'not-a-real-token' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects login with the wrong password', async () => {
      const { email } = await registerActiveUser();
      const res = await app!.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'Totally-Wrong-9!' } });
      expect(res.statusCode).toBe(401);
    });

    it('logs in an active user and returns a bearer token', async () => {
      const { token } = await registerActiveUser();
      expect(token).toHaveLength(64);
    });

    it('GET /v1/auth/session validates a real token', async () => {
      const { token, email } = await registerActiveUser();
      const res = await app!.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe(email);
    });

    it('GET /v1/auth/session without a token is rejected', async () => {
      const res = await app!.inject({ method: 'GET', url: '/v1/auth/session' });
      expect(res.statusCode).toBe(401);
    });

    it('every response carries an X-Correlation-Id header, echoing a caller-supplied one', async () => {
      const res = await app!.inject({ method: 'GET', url: '/v1/health', headers: { 'x-correlation-id': 'my-corr-id' } });
      expect(res.headers['x-correlation-id']).toBe('my-corr-id');
    });

    it('logout revokes the session so it can no longer validate', async () => {
      const { token } = await registerActiveUser();
      const logoutRes = await app!.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` } });
      expect(logoutRes.statusCode).toBe(204);
      const sessionRes = await app!.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(sessionRes.statusCode).toBe(401);
    });
  });

  describe('onboarding', () => {
    it('begins onboarding for an authenticated user', async () => {
      const { token } = await registerActiveUser();
      const res = await app!.inject({
        method: 'POST', url: '/v1/onboarding', headers: { authorization: `Bearer ${token}` },
        payload: { tenantName: 'Acme', tenantSlug: uc('acme'), workspaceName: 'Main', workspaceSlug: uc('acme-ws') },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().progress.currentStep).toBe('workspace_created');
    });

    it('rejects onboarding without authentication', async () => {
      const res = await app!.inject({
        method: 'POST', url: '/v1/onboarding',
        payload: { tenantName: 'Acme', tenantSlug: uc('acme'), workspaceName: 'Main', workspaceSlug: uc('acme-ws') },
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET /v1/onboarding/active finds the just-started attempt', async () => {
      const { token } = await registerActiveUser();
      await app!.inject({
        method: 'POST', url: '/v1/onboarding', headers: { authorization: `Bearer ${token}` },
        payload: { tenantName: 'Acme', tenantSlug: uc('acme'), workspaceName: 'Main', workspaceSlug: uc('acme-ws') },
      });
      const res = await app!.inject({ method: 'GET', url: '/v1/onboarding/active', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('in_progress');
    });

    it('GET /v1/onboarding/active returns null for a user with no attempt', async () => {
      const { token } = await registerActiveUser();
      const res = await app!.inject({ method: 'GET', url: '/v1/onboarding/active', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });
  });

  describe('businesses — tenant context and authorization', () => {
    it('rejects a request missing X-Tenant-Id/X-Workspace-Id headers', async () => {
      const { token } = await registerActiveUser();
      const res = await app!.inject({ method: 'GET', url: '/v1/businesses', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a tenant/workspace the user has no membership in', async () => {
      const { token } = await registerActiveUser();
      const res = await app!.inject({
        method: 'GET', url: '/v1/businesses',
        headers: { authorization: `Bearer ${token}`, 'x-tenant-id': T1, 'x-workspace-id': WS1 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('lists businesses (paginated) for a user with an active membership', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);

      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'API List Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('api-list-biz')]
      );

      // T1/WS1 is a fixed fixture tenant shared by every test in this
      // file (createTenantWithOwner always returns the same ids), so it
      // accumulates businesses across every historical run — asserting
      // the new business lands on page 1 assumes an upper bound on that
      // accumulation that doesn't hold over a long-lived test tenant.
      // Walk pages (bounded by the endpoint's own max pageSize) until
      // found instead, which still exercises real pagination without
      // being fragile to how much prior fixture data exists.
      const PAGE_SIZE = 100;
      let found = false;
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const res = await app!.inject({ method: 'GET', url: `/v1/businesses?page=${page}&pageSize=${PAGE_SIZE}`, headers: tenantHeaders(ctx, token) });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        totalPages = Math.max(1, Math.ceil(body.total / PAGE_SIZE));
        if (body.items.some((b: { id: string }) => b.id === bizId)) {
          found = true;
          break;
        }
        page += 1;
      }
      expect(found).toBe(true);
    });

    it('an owner can view the workflow aggregate for a business', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'API Workflow Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('api-wf-biz')]
      );

      const res = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/workflow`, headers: tenantHeaders(ctx, token) });
      expect(res.statusCode).toBe(200);
      expect(res.json().business.id).toBe(bizId);
    });
  });

  describe('businesses — ABA decisions (permission + idempotency)', () => {
    it('rejects submitting a decision without aba:write permission', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId };
      const memberships = new MembershipRepository();
      const roles = new RoleRepository();
      const membership = await memberships.create(ctx, userId);
      await memberships.activate(ctx, membership.id);
      const viewerRole = await roles.getByCode(ctx, 'viewer');
      await memberships.assignRole(ctx, membership.id, viewerRole.id);

      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Viewer Biz',$4,'active')`,
        [bizId, T1, WS1, uc('viewer-biz')]
      );

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId: crypto.randomUUID(), reviewCode: 'r1', summary: 's', approverUserId: userId, assignmentCode: 'a1', decisionCode: 'd1', outcome: 'approve' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('submits an approve decision end-to-end with a real ABA intake package', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Decision Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('decision-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const code = uc('a');
      expect((await grantApprover(ctx, token, bizId, userId, code)).statusCode).toBe(201);

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 'Approve it', approverUserId: userId, assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('approved');
    });

    it('denies an approval by a manager-tier approver: the API accepts no risk class, so the action is unclassified (high) (P0-2)', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Policy Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('policy-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId, { isTimeSensitive: false });
      const code = uc('m');
      expect((await grantApprover(ctx, token, bizId, userId, code, 'manager')).statusCode).toBe(201);

      const approve = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 'Approve', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve', riskClass: 'low' },
      });
      expect(approve.statusCode).toBe(403);

      const reject = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId: await createAbaIntake(ctx, bizId, { isTimeSensitive: false }), reviewCode: uc('r'), summary: 'Reject', assignmentCode: code, decisionCode: uc('d'), outcome: 'reject' },
      });
      expect(reject.statusCode).toBe(201);
      expect(reject.json().status).toBe('rejected');
    });

    it('blocks approving an expired or unknown-time-sensitivity recommendation with 409, ignores forged facts in the body, and still allows rejecting (P0-3 Block 3)', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Gate Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('gate-biz')]
      );
      const code = uc('o');
      expect((await grantApprover(ctx, token, bizId, userId, code, 'business-owner')).statusCode).toBe(201);
      const decide = async (facts: Parameters<typeof createAbaIntake>[2], outcome: 'approve' | 'reject', forged: Record<string, unknown> = {}) => app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId: await createAbaIntake(ctx, bizId, facts), reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome, ...forged },
      });

      const expired = await decide({ riskClass: 'low', isTimeSensitive: true, validUntil: new Date(Date.now() - 3600 * 1000) }, 'approve');
      expect(expired.statusCode).toBe(409);
      expect(expired.json().error.message).toMatch(/EXPIRED/);

      const unknown = await decide({ riskClass: 'low' }, 'approve', { isTimeSensitive: false, riskClass: 'low', validUntil: '2999-01-01T00:00:00Z' });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error.message).toMatch(/TIME_SENSITIVITY_UNKNOWN/);

      expect((await decide({ riskClass: 'low' }, 'reject')).statusCode).toBe(201);
      expect((await decide(APPROVABLE_FACTS, 'approve')).statusCode).toBe(201);
    });

    it('rejects a decision when no approver authority was established beforehand (authority is never self-issued)', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'No Authority Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('no-auth-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: userId, assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
      const { rows } = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.approver_assignments WHERE business_id = $1`, [bizId]);
      expect(rows[0].n).toBe(0);
    });

    it('rejects a decision that names a different approver than the authenticated user, even if that user holds authority', async () => {
      const { userId, token } = await registerActiveUser();
      const other = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Impersonation Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('imp-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const code = uc('a');
      expect((await grantApprover(ctx, token, bizId, other.userId, code)).statusCode).toBe(201);
      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: other.userId, assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
    });

    it('rejects granting approver authority without aba:admin', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId };
      const memberships = new MembershipRepository();
      const roles = new RoleRepository();
      const membership = await memberships.create(ctx, userId);
      await memberships.activate(ctx, membership.id);
      const memberRole = await roles.getByCode(ctx, 'member');
      await memberships.assignRole(ctx, membership.id, memberRole.id);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Member Grant Biz',$4,'active')`,
        [bizId, T1, WS1, uc('member-grant-biz')]
      );
      const res = await grantApprover(ctx, token, bizId, userId, uc('a'));
      expect(res.statusCode).toBe(403);
    });

    it('rejects a request missing the Idempotency-Key header', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'No Idem Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('no-idem-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: tenantHeaders(ctx, token),
        payload: { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: userId, assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('replaying the same Idempotency-Key with the same body returns the original response, not a second decision', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Replay Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('replay-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const code = uc('a');
      expect((await grantApprover(ctx, token, bizId, userId, code)).statusCode).toBe(201);
      const key = uc('replay-key');
      const payload = { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: userId, assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' as const };

      const first = await app!.inject({ method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key }, payload });
      const second = await app!.inject({ method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key }, payload });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
    });

    it('the same Idempotency-Key reused with a different body is rejected as a conflict', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Conflict Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('conflict-biz')]
      );
      const intakePackageId = await createAbaIntake(ctx, bizId);
      const code = uc('a');
      expect((await grantApprover(ctx, token, bizId, userId, code)).statusCode).toBe(201);
      const key = uc('conflict-key');

      const first = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 'first', approverUserId: userId, assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' },
      });
      const second = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key },
        payload: { intakePackageId, reviewCode: uc('r2'), summary: 'different body', approverUserId: userId, assignmentCode: code, decisionCode: uc('d2'), outcome: 'reject' },
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
    });
  });

  describe('businesses — decision recommendations on an empty business (CS-01)', () => {
    it('states that there is not enough real data, and makes no positive claim, for a business with no recorded activity', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Empty Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('empty-biz')]
      );

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decision-recommendations`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('cs01-key') },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.decisions).toEqual([]);
      expect(body.evidence.overall).toBe('insufficient');
      expect(body.evidence.message).toMatch(/not enough real data/i);
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/profitable/i);
      expect(text).not.toMatch(/healthy/i);
      expect(text).not.toMatch(/\$0\)/);

      const { rows } = await adminPool!.query(
        `SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_cases WHERE business_id = $1`, [bizId]
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('businesses — approver authority revocation and provenance (owner bootstrap)', () => {
    async function ownerWorld(label: string) {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,$4,$5,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, label, uc(label.toLowerCase().replace(/\W+/g, '-'))]
      );
      return { userId, token, ctx, bizId };
    }
    const revoke = (w: Awaited<ReturnType<typeof ownerWorld>>, code: string, body: unknown, withKey = true) =>
      app!.inject({
        method: 'POST', url: `/v1/businesses/${w.bizId}/approver-assignments/${code}/revoke`,
        headers: { ...tenantHeaders(w.ctx, w.token), ...(withKey ? { 'idempotency-key': uc('rev-key') } : {}) }, payload: body as object,
      });

    it('revokes an approver, after which that approver\'s decision is refused with 403', async () => {
      const w = await ownerWorld('Revoke Biz');
      const code = uc('rv');
      expect((await grantApprover(w.ctx, w.token, w.bizId, w.userId, code)).statusCode).toBe(201);

      const res = await revoke(w, code, { reason: 'approver left the company' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'revoked', assignmentCode: code, changed: true });

      const intakePackageId = await createAbaIntake(w.ctx, w.bizId);
      const decision = await app!.inject({
        method: 'POST', url: `/v1/businesses/${w.bizId}/decisions`, headers: { ...tenantHeaders(w.ctx, w.token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(decision.statusCode).toBe(403);
      expect(decision.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
    });

    it('exposes the append-only provenance history (grant then revoke, with actor, source and reason)', async () => {
      const w = await ownerWorld('History Biz');
      const code = uc('hist');
      await grantApprover(w.ctx, w.token, w.bizId, w.userId, code);
      await revoke(w, code, { reason: 'rotation' });
      const res = await app!.inject({
        method: 'GET', url: `/v1/businesses/${w.bizId}/approver-assignments/${code}`, headers: tenantHeaders(w.ctx, w.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('revoked');
      expect(body.provenance.map((p: { action: string; source: string }) => [p.action, p.source])).toEqual([['grant', 'manual-admin'], ['revoke', 'manual-admin']]);
      expect(body.provenance[0].actor).toMatchObject({ type: 'user', id: w.userId, authority: 'aba:admin' });
      expect(body.provenance[1].reason).toBe('rotation');
    });

    it('revoking requires a reason and an Idempotency-Key, and an unknown assignment is 404', async () => {
      const w = await ownerWorld('Validate Biz');
      const code = uc('val');
      await grantApprover(w.ctx, w.token, w.bizId, w.userId, code);
      expect((await revoke(w, code, {})).statusCode).toBe(400);
      expect((await revoke(w, code, { reason: '   ' })).statusCode).toBe(400);
      expect((await revoke(w, code, { reason: 'x' }, false)).statusCode).toBe(400);
      expect((await revoke(w, uc('unknown'), { reason: 'x' })).statusCode).toBe(404);
    });

    it('a member without aba:admin can neither revoke nor read the history', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId };
      const membership = await new MembershipRepository().create(ctx, userId);
      await new MembershipRepository().activate(ctx, membership.id);
      await new MembershipRepository().assignRole(ctx, membership.id, (await new RoleRepository().getByCode(ctx, 'member')).id);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Member Revoke Biz',$4,'active')`,
        [bizId, T1, WS1, uc('member-revoke')]
      );
      const rev = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/approver-assignments/x/revoke`,
        headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('k') }, payload: { reason: 'try' },
      });
      expect(rev.statusCode).toBe(403);
      const read = await app!.inject({ method: 'GET', url: `/v1/businesses/${bizId}/approver-assignments/x`, headers: tenantHeaders(ctx, token) });
      expect(read.statusCode).toBe(403);
    });
  });

  describe('businesses — OM outcomes (permission + idempotency)', () => {
    it('records an outcome end-to-end with a real monitored action', async () => {
      const { userId, token } = await registerActiveUser();
      const ctx = await createTenantWithOwner(userId);
      const bizId = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Outcome Biz',$4,'active')`,
        [bizId, ctx.tenantId, ctx.workspaceId, uc('outcome-biz')]
      );
      const monitoredActionId = await createMonitoredAction(ctx, bizId);

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/outcomes`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('okey') },
        payload: {
          monitoredActionId, observationCode: uc('obs'), summary: 'Outcome via API', effectiveAt: new Date().toISOString(),
          measurements: [{ metricCode: 'revenue_delta', measuredValue: { amount: 1000 }, unit: 'usd' }],
          evidence: [{ evidenceType: 'manual_entry', evidenceReference: { source: 'api-test' } }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('recorded');
    });
  });

  describe('OpenAPI documentation', () => {
    it('serves the Swagger UI at /documentation', async () => {
      const res = await app!.inject({ method: 'GET', url: '/documentation' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('serves the generated OpenAPI JSON', async () => {
      const res = await app!.inject({ method: 'GET', url: '/documentation/json' });
      expect(res.statusCode).toBe(200);
      const spec = res.json();
      expect(spec.paths['/v1/auth/login']).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('adds rate-limit headers to responses', async () => {
      const res = await app!.inject({ method: 'GET', url: '/v1/health' });
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
    });
  });
});

describe.skipIf(run)('BUILD-21 governed API — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});