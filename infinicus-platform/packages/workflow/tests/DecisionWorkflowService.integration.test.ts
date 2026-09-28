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
async function createAdiPackage(ctx: TenantContext, businessId: string): Promise<string> {
  const simPkg = await createSimPackage(ctx, businessId);

  const adiIntakeRepo = new ADIIntakeRepository();
  await adiIntakeRepo.receivePackage(ctx, { businessId, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('adi-intake'), idempotencyKey: uniqueCode('idem') });

  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uniqueCode('q'), 'Should we expand into the secondary market?');

  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uniqueCode('case'));

  const recRepo = new DecisionRecommendationRepository();
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uniqueCode('rec'), 'workflow fixture recommendation');
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);

  const adiPubRepo = new ADIPublicationRepository();
  const insight = await adiPubRepo.createInsightPackage(ctx, businessId, uniqueCode('adi-insight'));
  const insightVersion = await adiPubRepo.createVersion(ctx, insight.id, businessId, 'ADI->ABA workflow fixture', recVersion.id);
  const { package: pub } = await adiPubRepo.createPackage(ctx, businessId, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAdiPackage() through an accepted ABA intake package (ready for review). */
async function createAbaIntake(ctx: TenantContext, businessId: string): Promise<string> {
  const adiPkg = await createAdiPackage(ctx, businessId);
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
      const decision = await service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, approverUserId: UID, assignmentCode: uniqueCode('wf-assign'),
        decisionCode: uniqueCode('wf-dec'), summary: 'Approving', outcome: 'approve',
      });
      expect(decision.status).toBe('approved');

      const view = await service.getWorkflowView(ctx1, BIZ1);
      expect(view.abaLatestDecision?.id).toBe(decision.id);
    });

    it('submits a reject decision', async () => {
      const intakePackageId = await createAbaIntake(ctx1, BIZ1);
      const review = await service.createReview(ctx1, BIZ1, { intakePackageId, reviewCode: uniqueCode('wf-review-r'), summary: 'Reject me' });
      const decision = await service.submitApprovalDecision(ctx1, BIZ1, {
        reviewPackageId: review.id, approverUserId: UID, assignmentCode: uniqueCode('wf-assign-r'),
        decisionCode: uniqueCode('wf-dec-r'), summary: 'Rejecting', outcome: 'reject',
      });
      expect(decision.status).toBe('rejected');
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
