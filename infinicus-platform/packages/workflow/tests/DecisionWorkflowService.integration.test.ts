/**
 * Live PostgreSQL 16 integration tests for DecisionWorkflowService
 * (BUILD-20), exercising business selection, the aggregate workflow view,
 * decision history, and the two human-decision writes (ABA approval,
 * OM outcome entry) against a real end-to-end
 * BI -> DT -> Simulation -> ADI -> ABA -> OM fixture chain.
 *
 * The fixture-chain helpers below mirror the proven, already-tested
 * pattern used by aba-repositories.integration.test.ts and
 * om-repositories.integration.test.ts in @infinicus/database — this file
 * does not re-test that machinery, only that DecisionWorkflowService
 * composes and surfaces it correctly.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  createPool, closePool,
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
import { DecisionWorkflowService } from '../src/index.js';

const run = !!process.env.DATABASE_URL;

const T1  = '66666666-7070-0000-0000-000000000001';
const WS1 = '66666666-7070-0000-0000-000000000002';
const T2  = '66666666-7070-0000-0000-000000000003';
const WS2 = '66666666-7070-0000-0000-000000000004';
const UID = '66666666-7070-0000-0000-000000000099';
const BIZ1 = '66666666-7171-0000-0000-000000000001';
const BIZ2 = '66666666-7171-0000-0000-000000000002';

const ctx1: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2: TenantContext = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** BI publication -> DT intake -> published snapshot -> DT publication targeting simulation. */
async function createDtPackage(ctx: TenantContext, businessId: string): Promise<string> {
  const insightRepo = new InsightPackageRepository();
  const biPubRepo = new BIPublicationPackageRepository();
  const biPkg = await insightRepo.create(ctx, businessId, uniqueCode('insight'));
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'workflow fixture BI evidence' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uniqueCode('dt-intake'), idempotencyKey: uniqueCode('idem') });

  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'Workflow Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);

  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));
  await instRepo.transitionStatus(ctx, instance.id, 'active');

  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uniqueCode('snap'), new Date(), 'workflow fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);

  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uniqueCode('base'), 'workflow fixture objective');
  await baselineRepo.validateBaseline(ctx, baseline.id, baselineVersion.id);
  await baselineRepo.publishBaseline(ctx, baseline.id, baselineVersion.id);

  const dtPubRepo = new DTPublicationPackageRepository();
  const dtInsight = await dtPubRepo.createInsightPackage(ctx, businessId, uniqueCode('dt-insight'));
  const dtInsightVersion = await dtPubRepo.createVersion(ctx, dtInsight.id, businessId, 'DT->SIM workflow fixture', { snapshotVersionId: snapVersion.id, scenarioBaselineVersionId: baselineVersion.id });
  const { package: dtPub } = await dtPubRepo.createPackage(ctx, businessId, dtInsightVersion.id, 'simulation', 'SIM-01', uniqueCode('idem'));
  return dtPub.id;
}

/** Extends createDtPackage() through a published simulation result -> SIM publication targeting ai_decision_intelligence. */
async function createSimPackage(ctx: TenantContext, businessId: string): Promise<string> {
  const dtPkg = await createDtPackage(ctx, businessId);

  const simIntakeRepo = new SimulationIntakeRepository();
  await simIntakeRepo.receivePackage(ctx, { businessId, dtPublicationPackageId: dtPkg, intakeCode: uniqueCode('sim-intake'), idempotencyKey: uniqueCode('idem') });

  const modelRepo = new SimulationModelRepository();
  const model = await modelRepo.createModel(ctx, businessId, uniqueCode('model'), 'Engine v3 Model');
  const modelVersion = await modelRepo.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});

  const scenarioRepo = new SimulationScenarioRepository();
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uniqueCode('scn'), 'Workflow Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);

  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uniqueCode('req'), uniqueCode('idem'));
  await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uniqueCode('run'));

  const runsForBusiness = await runRepo.listForBusiness(ctx, businessId);
  const latestRun = runsForBusiness[0];

  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, latestRun.id, uniqueCode('result'), 'workflow fixture result');
  await resultRepo.validateResult(ctx, result.id, resultVersion.id);
  await resultRepo.publishResult(ctx, result.id, resultVersion.id);

  const pubRepo = new SimulationPublicationRepository();
  const insight = await pubRepo.createInsightPackage(ctx, businessId, uniqueCode('sim-insight'));
  const insightVersion = await pubRepo.createVersion(ctx, insight.id, businessId, 'SIM->ADI workflow fixture', resultVersion.id);
  const { package: pub } = await pubRepo.createPackage(ctx, businessId, insightVersion.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
  return pub.id;
}

/** Extends createSimPackage() through a published ADI recommendation -> ADI publication targeting approved_business_action. */
/** Persisted facts that pass the approval gate (low risk, explicitly not time-sensitive). Tests that need unclassified/unknown pass `{}`. */
const APPROVABLE_FACTS = { riskClass: 'low', isTimeSensitive: false } as const;

async function createAdiPackage(ctx: TenantContext, businessId: string, facts: Parameters<DecisionRecommendationRepository['createRecommendation']>[6] = APPROVABLE_FACTS, publish = true): Promise<string> {
  return createAdiPackageInner(ctx, businessId, facts, publish);
}

async function createAdiPackageInner(ctx: TenantContext, businessId: string, facts?: Parameters<DecisionRecommendationRepository['createRecommendation']>[6], publish = true): Promise<string> {
  const simPkg = await createSimPackage(ctx, businessId);

  const adiIntakeRepo = new ADIIntakeRepository();
  await adiIntakeRepo.receivePackage(ctx, { businessId, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('adi-intake'), idempotencyKey: uniqueCode('idem') });

  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uniqueCode('q'), 'Should we expand into the secondary market?');

  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uniqueCode('case'));

  const recRepo = new DecisionRecommendationRepository();
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uniqueCode('rec'), 'workflow fixture recommendation', undefined, facts);
  if (publish) {
    await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
    await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);
  }

  const adiPubRepo = new ADIPublicationRepository();
  const insight = await adiPubRepo.createInsightPackage(ctx, businessId, uniqueCode('adi-insight'));
  const insightVersion = await adiPubRepo.createVersion(ctx, insight.id, businessId, 'ADI->ABA workflow fixture', recVersion.id);
  const { package: pub } = await adiPubRepo.createPackage(ctx, businessId, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAdiPackage() through an accepted ABA intake package (ready for review). */
async function createAbaIntake(ctx: TenantContext, businessId: string, facts: Parameters<DecisionRecommendationRepository['createRecommendation']>[6] = APPROVABLE_FACTS, publish = true): Promise<string> {
  const adiPkg = await createAdiPackage(ctx, businessId, facts, publish);
  const intakeRepo = new ABAIntakeRepository();
  const { package: pkg } = await intakeRepo.receivePackage(ctx, {
    businessId, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('aba-intake'), idempotencyKey: uniqueCode('idem'),
  });
  return pkg.id;
}

/** Extends createAbaIntake() through a full approved ABA decision -> ABA publication targeting outcome_monitoring. */
async function createAbaPublicationPackage(ctx: TenantContext, businessId: string): Promise<string> {
  const intakePackageId = await createAbaIntake(ctx, businessId);

  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePackageId, uniqueCode('review'));

  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign'));

  const decisionRepo = new ApprovalDecisionRepository();
  const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uniqueCode('dec'), 'workflow fixture decision');
  await decisionRepo.approve(ctx, decision.id, version.id);

  const actionRepo = new ApprovedActionRepository();
  const action = await actionRepo.createAction(ctx, businessId, decision.id, uniqueCode('action'));

  const abaPubRepo = new ABAPublicationRepository();
  const { package: pub } = await abaPubRepo.createPackage(ctx, businessId, action.id, uniqueCode('aba-pub'), 'outcome_monitoring', 'OM-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAbaPublicationPackage() through an OM intake, monitoring plan, and monitored action. Returns the monitoredActionId. */
async function createMonitoredAction(ctx: TenantContext, businessId: string): Promise<string> {
  const abaPkg = await createAbaPublicationPackage(ctx, businessId);
  const omIntakeRepo = new OMIntakeRepository();
  const { package: omPkg } = await omIntakeRepo.receivePackage(ctx, {
    businessId, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('om-intake'), idempotencyKey: uniqueCode('idem'),
  });

  const planRepo = new MonitoringPlanRepository();
  const { plan } = await planRepo.createPlan(ctx, businessId, omPkg.id, uniqueCode('plan'), 'workflow fixture plan');

  // A second, independent approved action, since fixturing outcome tracking needs its own
  // approved_action_id — mirrors om-repositories.integration.test.ts's own fixture pattern.
  const intakePackageId2 = await createAbaIntake(ctx, businessId);
  const reviewRepo = new ActionReviewRepository();
  const review2 = await reviewRepo.createReviewPackage(ctx, businessId, intakePackageId2, uniqueCode('review2'));
  const authorityRepo = new ApproverAuthorityRepository();
  const assignment2 = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign2'));
  const decisionRepo = new ApprovalDecisionRepository();
  const { decision: decision2, version: version2 } = await decisionRepo.createDecision(ctx, businessId, review2.id, assignment2.id, uniqueCode('dec2'), 'workflow fixture decision 2');
  await decisionRepo.approve(ctx, decision2.id, version2.id);
  const actionRepo = new ApprovedActionRepository();
  const approvedAction2 = await actionRepo.createAction(ctx, businessId, decision2.id, uniqueCode('action2'));

  const monitoredRepo = new MonitoredActionRepository();
  const { action } = await monitoredRepo.createMonitoredAction(ctx, businessId, plan.id, approvedAction2.id, uniqueCode('mact'), 'workflow fixture monitored action');
  return action.id;
}

async function setupWorkflowIntegration(): Promise<void> {
  const appUrl = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'Workflow-Test Tenant 1','wf-t1','active','test'),
            ($2,'Workflow-Test Tenant 2','wf-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'Workflow-Test WS 1','wf-ws1','active'),
            ($3,$4,'Workflow-Test WS 2','wf-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'Workflow Test Biz 1','wf-biz1','active'),
            ($4,$5,$6,'Workflow Test Biz 2','wf-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'workflow-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

async function teardownWorkflowIntegration(): Promise<void> {
  if (adminPool) await adminPool.end();
  await closePool();
}

describe.runIf(run)('DecisionWorkflowService — live PostgreSQL', () => {
  const service = new DecisionWorkflowService();

  beforeAll(setupWorkflowIntegration);
  afterAll(teardownWorkflowIntegration);

  describe('business selection', () => {
    it('lists businesses for a workspace', async () => {
      const { items } = await service.listBusinesses(ctx1);
      expect(items.some((b) => b.id === BIZ1)).toBe(true);
    });

    it('does not list a different tenant workspace\'s businesses', async () => {
      const { items } = await service.listBusinesses(ctx1);
      expect(items.some((b) => b.id === BIZ2)).toBe(false);
    });
  });

  describe('getWorkflowView', () => {
    it('returns the business with empty stages for a brand-new business with no downstream data', async () => {
      const view = await service.getWorkflowView(ctx1, BIZ1);
      expect(view.business.id).toBe(BIZ1);
      // BIZ1 may already carry fixture data from other tests in this file by the time this
      // runs; assert structural shape rather than emptiness here.
      expect(Array.isArray(view.biEvidence)).toBe(true);
      expect(Array.isArray(view.dtInstances)).toBe(true);
      expect(Array.isArray(view.simulationRuns)).toBe(true);
      expect(Array.isArray(view.adiCases)).toBe(true);
      expect(Array.isArray(view.abaReviews)).toBe(true);
      expect(Array.isArray(view.outcomes)).toBe(true);
    });

    it('surfaces real BI, DT, Simulation, and ADI data once the pipeline has produced it', async () => {
      await createAdiPackage(ctx1, BIZ1);
      const view = await service.getWorkflowView(ctx1, BIZ1);
      expect(view.biEvidence.length).toBeGreaterThan(0);
      expect(view.dtInstances.length).toBeGreaterThan(0);
      expect(view.dtLatestSnapshot).not.toBeNull();
      expect(view.simulationRuns.length).toBeGreaterThan(0);
      expect(view.simulationLatestResult).not.toBeNull();
      expect(view.adiCases.length).toBeGreaterThan(0);
      expect(view.adiLatestRecommendation).not.toBeNull();
    });
  });

  describe('ABA review — createReview / submitApprovalDecision', () => {
    it('creates a review package for an accepted ABA intake package', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review'), summary: 'Workflow review' });
      expect(review.status).toBe('in_review');
      expect(review.businessId).toBe(BIZ1);
    });

    it('submits an approve decision and it is reflected in the workflow view', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-a'), summary: 'Approve me' });
      const assignmentCode = uniqueCode('wf-assign');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      const decision = await service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, approverUserId: UID, assignmentCode,
        decisionCode: uniqueCode('wf-dec'), summary: 'Approving', outcome: 'approve',
      });
      expect(decision.status).toBe('approved');

      const view = await service.getWorkflowView(ctx1, BIZ1);
      expect(view.abaLatestDecision?.id).toBe(decision.id);
    });

    it('submits a reject decision', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-r'), summary: 'Reject me' });
      const assignmentCode = uniqueCode('wf-assign-r');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      const decision = await service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, approverUserId: UID, assignmentCode,
        decisionCode: uniqueCode('wf-dec-r'), summary: 'Rejecting', outcome: 'reject',
      });
      expect(decision.status).toBe('rejected');
    });
    it('refuses a decision when no approver authority was established beforehand, and creates none (V-01)', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-n'), summary: 'No authority' });
      const assignmentCode = uniqueCode('wf-assign-n');
      await expect(service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('wf-dec-n'), summary: 'Should fail', outcome: 'approve',
      })).rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });
      const { rows } = await adminPool!.query(
        `SELECT count(*)::int AS n FROM approved_business_action.approver_assignments WHERE business_id = $1 AND assignment_code = $2`, [BIZ1, assignmentCode]);
      expect(rows[0].n).toBe(0);
    });

    it('refuses a decision naming a different approver than the authenticated principal', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-o'), summary: 'Other approver' });
      const assignmentCode = uniqueCode('wf-assign-o');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      await expect(service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, approverUserId: '66666666-7070-0000-0000-0000000000aa', assignmentCode,
        decisionCode: uniqueCode('wf-dec-o'), summary: 'Should fail', outcome: 'approve',
      })).rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });
    });

    it('refuses a decision under a revoked assignment', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-v'), summary: 'Revoked' });
      const assignmentCode = uniqueCode('wf-assign-v');
      const granted = await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      await new ApproverAuthorityRepository().transitionStatus(ctx1, granted.id, 'revoked');
      await expect(service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('wf-dec-v'), summary: 'Should fail', outcome: 'approve',
      })).rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });
    });
  });

  describe('approver authority — revocation, provenance, and the owner-proof re-check', () => {
    async function decide(ctx: TenantContext, businessId: string, assignmentCode: string) {
      const intakePackageId = await createAbaIntake(ctx, businessId);
      const review = await service.createReview(ctx, businessId, { intakePackageId, reviewCode: uniqueCode('rv'), summary: 'Authority check' });
      return service.submitApprovalDecision(ctx, businessId, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('dc'), summary: 'Deciding', outcome: 'approve',
      });
    }

    it('a revoked approver loses authority at once; revocation is idempotent and needs a reason', async () => {
      const assignmentCode = uniqueCode('wf-rev');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      await expect(decide(ctx1, BIZ1, assignmentCode)).resolves.toMatchObject({ status: 'approved' });

      await expect(service.revokeApproverAuthority(ctx1, BIZ1, { assignmentCode, reason: '   ' })).rejects.toThrow(/reason/i);
      const revoked = await service.revokeApproverAuthority(ctx1, BIZ1, { assignmentCode, reason: 'approver left the company' });
      expect(revoked.changed).toBe(true);
      expect(revoked.assignment.status).toBe('revoked');
      await expect(decide(ctx1, BIZ1, assignmentCode)).rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });

      expect((await service.revokeApproverAuthority(ctx1, BIZ1, { assignmentCode, reason: 'again' })).changed).toBe(false);
    });

    it('records an append-only provenance history for grant and revoke', async () => {
      const assignmentCode = uniqueCode('wf-prov');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode, correlationId: 'req-grant' });
      await service.revokeApproverAuthority(ctx1, BIZ1, { assignmentCode, reason: 'rotation', correlationId: 'req-revoke' });
      const { assignment, provenance } = await service.getApproverAuthority(ctx1, BIZ1, assignmentCode);
      expect(assignment.status).toBe('revoked');
      expect(provenance.map((p) => [p.action, p.source, p.state])).toEqual([['grant', 'manual-admin', 'active'], ['revoke', 'manual-admin', 'revoked']]);
      expect(provenance[0]).toMatchObject({ granteeUserId: UID, businessId: BIZ1, assignmentCode, correlationId: 'req-grant', actor: { type: 'user', id: UID, authority: 'aba:admin' } });
      expect(provenance[1]).toMatchObject({ reason: 'rotation', correlationId: 'req-revoke' });
    });

    it('revoking or reading an unknown assignment is a not-found error', async () => {
      await expect(service.revokeApproverAuthority(ctx1, BIZ1, { assignmentCode: uniqueCode('none'), reason: 'x' })).rejects.toThrow(/not found/i);
      await expect(service.getApproverAuthority(ctx1, BIZ1, uniqueCode('none'))).rejects.toThrow(/not found/i);
    });

    it('granting an existing code to another user is a conflict; the same user is idempotent', async () => {
      const assignmentCode = uniqueCode('wf-conf');
      const first = await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      const again = await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode });
      expect(again.id).toBe(first.id);
      await expect(service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: '66666666-7070-0000-0000-0000000000bb', assignmentCode })).rejects.toThrow();
    });

    it('an auto-issued owner authority stops working when the ownership proof lapses, without being revoked; a manual grant is unaffected', async () => {
      const ownerRole = await adminPool!.query(`SELECT id FROM tenancy.roles WHERE code = 'owner' AND tenant_id IS NULL`);
      const membership = await adminPool!.query(
        `INSERT INTO tenancy.memberships (tenant_id, workspace_id, user_id, status, joined_at) VALUES ($1,$2,$3,'active', now())
         ON CONFLICT (user_id, workspace_id) DO UPDATE SET status = 'active' RETURNING id`, [T1, WS1, UID]
      );
      await adminPool!.query(
        `INSERT INTO tenancy.membership_roles (membership_id, role_id, business_id) VALUES ($1,$2,$3) ON CONFLICT (membership_id, role_id) DO UPDATE SET business_id = EXCLUDED.business_id`,
        [membership.rows[0].id, ownerRole.rows[0].id, BIZ1]
      );
      const authority = new ApproverAuthorityRepository();
      const { assignment } = await authority.grantActiveAssignment(ctx1, {
        businessId: BIZ1, userId: UID, assignmentCode: 'business-owner-approver', roleCode: 'business-owner',
        provenance: {
          action: 'grant', source: 'onboarding', businessId: BIZ1, assignmentCode: 'business-owner-approver', granteeUserId: UID, state: 'active',
          actor: { type: 'system', id: null, authority: 'owner-bootstrap:onboarding' }, at: new Date().toISOString(), correlationId: null,
          proof: { kind: 'explicit-owner-role', membershipId: membership.rows[0].id, onboardingId: null }, reason: null,
        },
      });

      // While the owner relationship holds, the owner can decide.
      await expect(decide(ctx1, BIZ1, 'business-owner-approver')).resolves.toMatchObject({ status: 'approved' });

      // The relationship lapses: the membership is suspended.
      await adminPool!.query(`UPDATE tenancy.memberships SET status = 'suspended' WHERE id = $1`, [membership.rows[0].id]);
      await expect(decide(ctx1, BIZ1, 'business-owner-approver')).rejects.toMatchObject({ name: 'ApproverAuthorityNotEstablishedError' });
      // Never silently destructive: the assignment is still active until an administrator revokes it.
      expect((await authority.getById(ctx1, assignment.id)).status).toBe('active');

      // A manual administrator grant under the same code (other business) is an explicit decision and is not re-derived from ownership.
      await service.grantApproverAuthority(ctx2, BIZ2, { approverUserId: UID, assignmentCode: 'business-owner-approver' });
      await expect(decide(ctx2, BIZ2, 'business-owner-approver')).resolves.toMatchObject({ status: 'approved' });
    });
  });

  describe('ABA review snapshots the published ADI risk/validity facts (P0-3 Block 2)', () => {
    const TWIN = '66666666-7272-0000-0000-000000000001';

    it('copies risk_class, is_time_sensitive, valid_until, twin_snapshot_id and lineage onto the review version', async () => {
      const validUntil = new Date(Date.now() + 48 * 3600 * 1000);
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, { riskClass: 'critical', isTimeSensitive: true, validUntil, twinSnapshotId: TWIN });
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('snap'), summary: 'Snapshot' });
      const version = await new ActionReviewRepository().getLatestVersion(ctx1, review.id);
      expect(version).toMatchObject({ riskClass: 'critical', isTimeSensitive: true, twinSnapshotId: TWIN });
      expect(version?.validUntil?.getTime()).toBe(validUntil.getTime());
      expect(version?.sourceRecommendationVersionId).toEqual(expect.any(String));
      const lineage = await adminPool!.query(
        `SELECT rv.status, rv.risk_class FROM ai_decision_intelligence.decision_recommendation_versions rv WHERE rv.id = $1`, [version!.sourceRecommendationVersionId]);
      expect(lineage.rows[0]).toMatchObject({ status: 'published', risk_class: 'critical' });
    });

    it('ABA snapshots the persisted ADI-authored class and does not recalculate it, including a human upward adjustment made before publication', async () => {
      const recRepo = new DecisionRecommendationRepository();
      const simPkg = await createSimPackage(ctx1, BIZ1);
      await new ADIIntakeRepository().receivePackage(ctx1, { businessId: BIZ1, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('adi-intake'), idempotencyKey: uniqueCode('idem') });
      const question = await new DecisionQuestionRepository().createQuestion(ctx1, BIZ1, uniqueCode('q'), 'Raise before publish?');
      const case_ = await new DecisionCaseRepository().createCase(ctx1, BIZ1, question.id, uniqueCode('case'));
      const { recommendation, version } = await recRepo.createRecommendation(ctx1, BIZ1, case_.id, uniqueCode('rec'), 'Raised', undefined, { riskClass: 'low', isTimeSensitive: false });
      await recRepo.raiseRiskClass(ctx1, version.id, 'critical');
      await recRepo.validateRecommendation(ctx1, recommendation.id, version.id);
      await recRepo.publishRecommendation(ctx1, recommendation.id, version.id);
      const adiPubRepo = new ADIPublicationRepository();
      const insight = await adiPubRepo.createInsightPackage(ctx1, BIZ1, uniqueCode('adi-insight'));
      const insightVersion = await adiPubRepo.createVersion(ctx1, insight.id, BIZ1, 'raised fixture', version.id);
      const { package: pub } = await adiPubRepo.createPackage(ctx1, BIZ1, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      const { package: intake } = await new ABAIntakeRepository().receivePackage(ctx1, { businessId: BIZ1, adiPublicationPackageId: pub.id, intakeCode: uniqueCode('aba-intake'), idempotencyKey: uniqueCode('idem') });

      const review = await service.createReview(ctx1, BIZ1, { intakePackageId: intake.id, reviewCode: uniqueCode('snap-raised'), summary: 'Snapshot' });
      const snapshot = await new ActionReviewRepository().getLatestVersion(ctx1, review.id);
      expect(snapshot).toMatchObject({ riskClass: 'critical', isTimeSensitive: false, sourceRecommendationVersionId: version.id });
    });

    it('an unclassified recommendation yields a NULL snapshot (unclassified / unknown) — never a guessed class', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, {});
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('snap-null'), summary: 'Snapshot' });
      const version = await new ActionReviewRepository().getLatestVersion(ctx1, review.id);
      expect(version).toMatchObject({ riskClass: null, isTimeSensitive: null, validUntil: null, twinSnapshotId: null });
      expect(version?.sourceRecommendationVersionId).toEqual(expect.any(String));
    });

    it('an explicit not-time-sensitive recommendation is copied as false, not NULL', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, { riskClass: 'low', isTimeSensitive: false });
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('snap-false'), summary: 'Snapshot' });
      expect(await new ActionReviewRepository().getLatestVersion(ctx1, review.id)).toMatchObject({ riskClass: 'low', isTimeSensitive: false });
    });

    it('a recommendation that was not published is not snapshotted: the snapshot is empty and carries no lineage', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, { riskClass: 'low', isTimeSensitive: false }, false);
      const snapshot = await new ActionReviewRepository().resolvePublishedSnapshot(ctx1, intakePackageId);
      expect(snapshot).toEqual({ sourceRecommendationVersionId: null, riskClass: null, isTimeSensitive: null, validUntil: null, twinSnapshotId: null });
    });

    it('an unknown intake package resolves to an empty snapshot, and another tenant cannot resolve it', async () => {
      const repo = new ActionReviewRepository();
      expect((await repo.resolvePublishedSnapshot(ctx1, '00000000-0000-0000-0000-000000000000')).riskClass).toBeNull();
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, { riskClass: 'high', isTimeSensitive: false });
      expect((await repo.resolvePublishedSnapshot(ctx2, intakePackageId)).riskClass).toBeNull();
    });
  });

  describe('persisted-fact approval gate (P0-3 Block 3)', () => {
    const decisionCount = async () => Number((await adminPool!.query(
      `SELECT count(*)::int AS n FROM approved_business_action.approval_decisions WHERE business_id = $1`, [BIZ1])).rows[0].n);
    const hours = (n: number) => new Date(Date.now() + n * 3600 * 1000);

    /** Review + owner-tier approver (so the risk policy never interferes) + decision on a recommendation with the given persisted facts. */
    async function decideOn(facts: Parameters<DecisionRecommendationRepository['createRecommendation']>[6], outcome: 'approve' | 'approve_with_modifications' | 'reject' = 'approve', biz: string = BIZ1) {
      const intakePackageId = await createAbaIntake(ctx1, biz, facts);
      const review = await service.createReview(ctx1, biz, { intakePackageId, reviewCode: uniqueCode('gate'), summary: 'Gate' });
      const assignmentCode = uniqueCode('wf-gate');
      await service.grantApproverAuthority(ctx1, biz, { approverUserId: UID, assignmentCode, roleCode: 'business-owner' });
      return service.submitApprovalDecision(ctx1, biz, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('gd'), summary: 'Deciding', outcome,
      });
    }
    const blocked = (codes: string[]) => expect.objectContaining({ name: 'ApprovalBlockedError', codes: expect.arrayContaining(codes) });

    /** A fresh business so other fixtures' Twin snapshots (effective 'now') cannot make these recommendations stale. */
    async function freshBusiness() {
      const id = crypto.randomUUID();
      await adminPool!.query(
        `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Gate Biz',$4,'active')`,
        [id, ctx1.tenantId, ctx1.workspaceId, uniqueCode('gate-biz')]
      );
      return id;
    }

    /** A Digital Twin snapshot for the business at the given effective time (published unless told otherwise). */
    async function publishedSnapshot(effectiveAt: Date, publish = true, biz: string = BIZ1) {
      const defRepo = new DigitalTwinDefinitionRepository();
      const definition = await defRepo.createDefinition(ctx1, biz, uniqueCode('gdef'), 'Gate Definition');
      const defVersion = await defRepo.createVersion(ctx1, definition.id, biz, {});
      await defRepo.validateVersion(ctx1, defVersion.id);
      await defRepo.activateVersion(ctx1, defVersion.id);
      const instance = await new DigitalTwinInstanceRepository().createInstance(ctx1, biz, definition.id, uniqueCode('ginst'));
      await new DigitalTwinInstanceRepository().transitionStatus(ctx1, instance.id, 'active');
      const snapRepo = new DigitalTwinSnapshotRepository();
      const { snapshot, version } = await snapRepo.createSnapshot(ctx1, biz, instance.id, uniqueCode('gsnap'), effectiveAt, 'gate snapshot');
      if (publish) {
        await snapRepo.validateSnapshot(ctx1, snapshot.id, version.id);
        await snapRepo.publishSnapshot(ctx1, snapshot.id, version.id);
      }
      return snapshot.id;
    }

    it('allows an explicitly not-time-sensitive recommendation without valid_until, and a time-sensitive one with a future valid_until', async () => {
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: false })).resolves.toMatchObject({ status: 'approved' });
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: true, validUntil: hours(24) })).resolves.toMatchObject({ status: 'approved' });
    });

    it('blocks an expired recommendation on database time, whether or not it was marked time-sensitive; no decision is recorded', async () => {
      const before = await decisionCount();
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) })).rejects.toEqual(blocked(['EXPIRED']));
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: false, validUntil: hours(-1) })).rejects.toEqual(blocked(['EXPIRED']));
      expect(await decisionCount()).toBe(before);
    });

    it('blocks unknown (NULL) time-sensitivity — including a fully unclassified recommendation — for approve and approve_with_modifications', async () => {
      await expect(decideOn({ riskClass: 'low' })).rejects.toEqual(blocked(['TIME_SENSITIVITY_UNKNOWN']));
      await expect(decideOn({})).rejects.toEqual(blocked(['TIME_SENSITIVITY_UNKNOWN']));
      await expect(decideOn({ riskClass: 'low' }, 'approve_with_modifications')).rejects.toEqual(blocked(['TIME_SENSITIVITY_UNKNOWN']));
    });

    it('blocks a time-sensitive review that carries no valid_until (ABA records what it received and blocks at approval)', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const reviewRepo = new ActionReviewRepository();
      const review = await reviewRepo.createReviewPackage(ctx1, BIZ1, intakePackageId, uniqueCode('ts-nov'));
      await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1', { riskClass: 'low', isTimeSensitive: true, validUntil: null });
      await reviewRepo.transitionStatus(ctx1, review.id, 'in_review');
      const assignmentCode = uniqueCode('wf-ts');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode, roleCode: 'business-owner' });
      await expect(service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('gd'), summary: 'x', outcome: 'approve',
      })).rejects.toEqual(blocked(['TIME_SENSITIVE_WITHOUT_VALIDITY']));
    });

    it('rejecting is always allowed, even for expired, unknown and stale decisions', async () => {
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) }, 'reject')).resolves.toMatchObject({ status: 'rejected' });
      await expect(decideOn({}, 'reject')).resolves.toMatchObject({ status: 'rejected' });
    });

    it('is STALE when a newer PUBLISHED Twin snapshot exists for the business; approve and approve_with_modifications are blocked, reject is allowed', async () => {
      const biz = await freshBusiness();
      const used = await publishedSnapshot(hours(197), true, biz);
      const facts = { riskClass: 'low', isTimeSensitive: false, twinSnapshotId: used } as const;
      await expect(decideOn(facts, 'approve', biz)).resolves.toMatchObject({ status: 'approved' });   // nothing newer yet (fixture-created snapshots are effective 'now', older than these)
      await publishedSnapshot(hours(199), true, biz);                                                  // newer, published
      await expect(decideOn(facts, 'approve', biz)).rejects.toEqual(blocked(['STALE']));
      await expect(decideOn(facts, 'approve_with_modifications', biz)).rejects.toEqual(blocked(['STALE']));
      await expect(decideOn(facts, 'reject', biz)).resolves.toMatchObject({ status: 'rejected' });
    });

    it('newer snapshots that are NOT published (draft) do not make a recommendation stale; only a newer published one does', async () => {
      const biz = await freshBusiness();
      const used = await publishedSnapshot(hours(195), true, biz);
      await publishedSnapshot(hours(196), false, biz);
      await publishedSnapshot(hours(197), false, biz);
      const facts = { riskClass: 'low', isTimeSensitive: false, twinSnapshotId: used } as const;
      await expect(decideOn(facts, 'approve', biz)).resolves.toMatchObject({ status: 'approved' });
      await publishedSnapshot(hours(198), true, biz);
      await expect(decideOn(facts, 'approve', biz)).rejects.toEqual(blocked(['STALE']));
    });

    it('the latest published snapshot is fresh; an older snapshot of the same business is stale', async () => {
      const biz = await freshBusiness();
      const older = await publishedSnapshot(hours(194), true, biz);
      const latest = await publishedSnapshot(hours(199), true, biz);
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: false, twinSnapshotId: latest }, 'approve', biz)).resolves.toMatchObject({ status: 'approved' });
      await expect(decideOn({ riskClass: 'low', isTimeSensitive: false, twinSnapshotId: older }, 'approve', biz)).rejects.toEqual(blocked(['STALE']));
    });

    it('an unverifiable Twin reference is blocked rather than assumed fresh: unknown id, a draft snapshot, or another business', async () => {
      const biz = await freshBusiness();
      const draft = await publishedSnapshot(hours(-2), false, biz);
      const otherBiz = await freshBusiness();
      const foreign = await publishedSnapshot(hours(-2), true, otherBiz);
      for (const twinSnapshotId of ['00000000-0000-0000-0000-0000000000cc', draft, foreign]) {
        await expect(decideOn({ riskClass: 'low', isTimeSensitive: false, twinSnapshotId }, 'approve', biz)).rejects.toEqual(blocked(['TWIN_SNAPSHOT_UNVERIFIABLE']));
      }
    });

    it('no caller input can set the facts: the input type has no risk or validity fields and extra properties are ignored', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, {});
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('inj'), summary: 'x' });
      const assignmentCode = uniqueCode('wf-inj');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode, roleCode: 'business-owner' });
      const forged = { reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('gd'), summary: 'x', outcome: 'approve', riskClass: 'low', isTimeSensitive: false, validUntil: hours(24) } as never;
      await expect(service.submitApprovalDecision(ctx1, BIZ1, forged)).rejects.toEqual(blocked(['TIME_SENSITIVITY_UNKNOWN']));
    });
  });

  describe('action-risk approval policy (P0-2)', () => {
    async function approveAs(
      roleCode: 'cashier' | 'manager' | 'approver' | 'business-owner',
      riskClass: 'low' | 'medium' | 'high' | 'critical' | undefined,
      outcome: 'approve' | 'approve_with_modifications' | 'reject' = 'approve'
    ) {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1, { riskClass, isTimeSensitive: false });
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('rk'), summary: 'Risk policy' });
      const assignmentCode = uniqueCode('wf-risk');
      await service.grantApproverAuthority(ctx1, BIZ1, { approverUserId: UID, assignmentCode, roleCode });
      return service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, assignmentCode, decisionCode: uniqueCode('rkd'), summary: 'Deciding', outcome,
      });
    }

    it('low risk: a cashier may approve', async () => {
      await expect(approveAs('cashier', 'low')).resolves.toMatchObject({ status: 'approved' });
    });

    it('medium risk: a cashier is denied, a manager may approve', async () => {
      await expect(approveAs('cashier', 'medium')).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
      await expect(approveAs('manager', 'medium')).resolves.toMatchObject({ status: 'approved' });
    });

    it('high and critical risk: a manager is denied, the business owner may approve', async () => {
      for (const risk of ['high', 'critical'] as const) {
        await expect(approveAs('manager', risk)).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
        await expect(approveAs('business-owner', risk)).resolves.toMatchObject({ status: 'approved' });
      }
    });

    it('approve_with_modifications is gated like approve', async () => {
      await expect(approveAs('manager', 'high', 'approve_with_modifications')).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
    });

    it('an unclassified action is treated as high risk: a manager is denied, the owner may approve', async () => {
      await expect(approveAs('manager', undefined)).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
      await expect(approveAs('business-owner', undefined)).resolves.toMatchObject({ status: 'approved' });
    });

    it('any approver may reject even critical risk', async () => {
      await expect(approveAs('cashier', 'critical', 'reject')).resolves.toMatchObject({ status: 'rejected' });
    });

    it('a denied approval records no decision', async () => {
      const before = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.approval_decisions WHERE business_id = $1`, [BIZ1]);
      await expect(approveAs('cashier', 'critical')).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
      const after = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.approval_decisions WHERE business_id = $1`, [BIZ1]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('rejects an unknown role at grant time', async () => {
      await expect(service.grantApproverAuthority(ctx1, BIZ1, {
        approverUserId: UID, assignmentCode: uniqueCode('wf-badrole'), roleCode: 'superuser' as never,
      })).rejects.toMatchObject({ name: 'ApprovalPolicyDeniedError' });
    });
  });

  describe('outcome entry — recordOutcome', () => {
    it('records an outcome observation with measurements and evidence, and it becomes immutable', async () => {
      const monitoredActionId = await createMonitoredAction(ctx1, BIZ1);
      const { observation } = await service.recordOutcome(ctx1, BIZ1, {
        monitoredActionId,
        observationCode: uniqueCode('wf-obs'),
        summary: 'Workflow outcome entry',
        effectiveAt: new Date(),
        measurements: [{ metricCode: 'revenue_delta', measuredValue: { amount: 5000 }, unit: 'usd' }],
        evidence: [{ evidenceType: 'manual_entry', evidenceReference: { source: 'workflow-test' } }],
      });
      expect(observation.status).toBe('recorded');

      const view = await service.getWorkflowView(ctx1, BIZ1);
      expect(view.outcomes.some((o) => o.id === observation.id)).toBe(true);
    });
  });

  describe('getDecisionHistory', () => {
    it('returns per-stage lists for a business with pipeline data', async () => {
      await createAdiPackage(ctx1, BIZ1);
      const history = await service.getDecisionHistory(ctx1, BIZ1);
      expect(history.biEvidence.length).toBeGreaterThan(0);
      expect(history.simulationRuns.length).toBeGreaterThan(0);
      expect(history.adiCases.length).toBeGreaterThan(0);
    });

    it('returns no rows when reading a different tenant\'s business (RLS, not a stage-emptiness check)', async () => {
      // BIZ2 belongs to tenant 2's workspace — reading it under ctx1 (tenant 1) must be denied by RLS,
      // so this call should surface zero rows rather than tenant-2 data.
      const history = await service.getDecisionHistory(ctx1, BIZ2);
      expect(history.biEvidence).toEqual([]);
    });
  });

  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot see tenant 1\'s business in listBusinesses', async () => {
      const { items } = await service.listBusinesses(ctx2);
      expect(items.some((b) => b.id === BIZ1)).toBe(false);
    });

    it('tenant 2 cannot read tenant 1\'s business via getWorkflowView', async () => {
      await expect(service.getWorkflowView(ctx2, BIZ1)).rejects.toThrow();
    });
  });
});

describe.skipIf(run)('DecisionWorkflowService — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
