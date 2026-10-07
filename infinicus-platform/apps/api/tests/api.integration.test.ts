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

/** Full BI -> DT -> Simulation -> ADI -> ABA-intake fixture chain (same proven pattern as BUILD-20's workflow tests). */
async function createAbaIntake(ctx: TenantContext, businessId: string): Promise<string> {
  const insightRepo = new InsightPackageRepository();
  const biPubRepo = new BIPublicationPackageRepository();
  const biPkg = await insightRepo.create(ctx, businessId, uc('insight'));
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'api fixture BI' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uc('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uc('dt-intake'), idempotencyKey: uc('idem') });
  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uc('def'), 'API Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);
  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uc('inst'));
  await instRepo.transitionStatus(ctx, instance.id, 'active');
  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uc('snap'), new Date(), 'api fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);
  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uc('base'), 'api fixture objective');
  await baselineRepo.validateBaseline(ctx, baseline.id, baselineVersion.id);
  await baselineRepo.publishBaseline(ctx, baseline.id, baselineVersion.id);
  const dtPubRepo = new DTPublicationPackageRepository();
  const dtInsight = await dtPubRepo.createInsightPackage(ctx, businessId, uc('dt-insight'));
  const dtInsightVersion = await dtPubRepo.createVersion(ctx, dtInsight.id, businessId, 'DT->SIM api fixture', { snapshotVersionId: snapVersion.id, scenarioBaselineVersionId: baselineVersion.id });
  const { package: dtPub } = await dtPubRepo.createPackage(ctx, businessId, dtInsightVersion.id, 'simulation', 'SIM-01', uc('idem'));

  const simIntakeRepo = new SimulationIntakeRepository();
  await simIntakeRepo.receivePackage(ctx, { businessId, dtPublicationPackageId: dtPub.id, intakeCode: uc('sim-intake'), idempotencyKey: uc('idem') });
  const modelRepo = new SimulationModelRepository();
  const model = await modelRepo.createModel(ctx, businessId, uc('model'), 'Engine v3 Model');
  const modelVersion = await modelRepo.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});
  const scenarioRepo = new SimulationScenarioRepository();
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uc('scn'), 'API Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);
  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uc('req'), uc('idem'));
  await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uc('run'));
  const runs = await runRepo.listForBusiness(ctx, businessId);
  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, runs[0].id, uc('result'), 'api fixture result');
  await resultRepo.validateResult(ctx, result.id, resultVersion.id);
  await resultRepo.publishResult(ctx, result.id, resultVersion.id);
  const pubRepo = new SimulationPublicationRepository();
  const simInsight = await pubRepo.createInsightPackage(ctx, businessId, uc('sim-insight'));
  const simInsightVersion = await pubRepo.createVersion(ctx, simInsight.id, businessId, 'SIM->ADI api fixture', resultVersion.id);
  const { package: simPub } = await pubRepo.createPackage(ctx, businessId, simInsightVersion.id, 'ai_decision_intelligence', 'ADI-06', uc('idem'));

  const adiIntakeRepo = new ADIIntakeRepository();
  await adiIntakeRepo.receivePackage(ctx, { businessId, simulationPublicationPackageId: simPub.id, intakeCode: uc('adi-intake'), idempotencyKey: uc('idem') });
  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uc('q'), 'Should we expand?');
  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uc('case'));
  const recRepo = new DecisionRecommendationRepository();
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uc('rec'), 'api fixture recommendation');
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);
  const adiPubRepo = new ADIPublicationRepository();
  const adiInsight = await adiPubRepo.createInsightPackage(ctx, businessId, uc('adi-insight'));
  const adiInsightVersion = await adiPubRepo.createVersion(ctx, adiInsight.id, businessId, 'ADI->ABA api fixture', recVersion.id);
  const { package: adiPub } = await adiPubRepo.createPackage(ctx, businessId, adiInsightVersion.id, 'approved_business_action', 'ABA-01', uc('idem'));

  const intakeRepo = new ABAIntakeRepository();
  const { package: intakePkg } = await intakeRepo.receivePackage(ctx, { businessId, adiPublicationPackageId: adiPub.id, intakeCode: uc('aba-intake'), idempotencyKey: uc('idem') });
  return intakePkg.id;
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

    const config = loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
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

      const res = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': uc('key') },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 'Approve it', approverUserId: userId, assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('approved');
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
      const key = uc('replay-key');
      const payload = { intakePackageId, reviewCode: uc('r'), summary: 's', approverUserId: userId, assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' as const };

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
      const key = uc('conflict-key');

      const first = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key },
        payload: { intakePackageId, reviewCode: uc('r'), summary: 'first', approverUserId: userId, assignmentCode: uc('a'), decisionCode: uc('d'), outcome: 'approve' },
      });
      const second = await app!.inject({
        method: 'POST', url: `/v1/businesses/${bizId}/decisions`, headers: { ...tenantHeaders(ctx, token), 'idempotency-key': key },
        payload: { intakePackageId, reviewCode: uc('r2'), summary: 'different body', approverUserId: userId, assignmentCode: uc('a2'), decisionCode: uc('d2'), outcome: 'reject' },
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
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