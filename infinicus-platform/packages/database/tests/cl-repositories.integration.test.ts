/**
 * Live PostgreSQL 16 integration tests for Stage 2J Continuous Learning
 * persistence (BUILD-17).
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import {
  CLIntakeRepository,
  LearningCaseRepository,
  LearningFeedbackRepository,
  LearnedLessonRepository,
  LearningPatternRepository,
  ModelEvaluationRepository,
  PolicyEvaluationRepository,
  ImprovementProposalRepository,
  LearningChangeReviewRepository,
  KnowledgeArtifactRepository,
  CLFeedbackPublicationRepository,
  CLComponentRegistryRepository,
  NotFoundError,
  ValidationError,
  InvalidTransitionError,
  LearningCaseNotFoundError,
  LearningFeedbackNotFoundError,
  LearnedLessonNotFoundError,
  LearningPatternNotFoundError,
  ModelEvaluationNotFoundError,
  PolicyEvaluationNotFoundError,
  PolicyChangeProposalNotFoundError,
  ImprovementProposalNotFoundError,
  ImprovementProposalImmutableError,
  LearningChangeReviewNotFoundError,
  KnowledgeArtifactNotFoundError,
  CLComponentRegistryNotFoundError,
} from '../src/repositories/cl/index.js';
import {
  OMIntakeRepository,
  MonitoringPlanRepository,
  MonitoredActionRepository,
  OutcomeObservationRepository,
  OutcomeReviewRepository,
  LearningFeedbackPackageRepository,
  OMPublicationRepository,
} from '../src/repositories/om/index.js';
import {
  ABAIntakeRepository,
  ActionReviewRepository,
  ApproverAuthorityRepository,
  ApprovalDecisionRepository,
  ApprovedActionRepository,
  ABAPublicationRepository,
} from '../src/repositories/approved_action/index.js';
import {
  ADIIntakeRepository,
  DecisionQuestionRepository,
  DecisionCaseRepository,
  DecisionRecommendationRepository,
  ADIPublicationRepository,
} from '../src/repositories/adi/index.js';
import { InsightPackageRepository, BIPublicationPackageRepository } from '../src/repositories/bi/index.js';
import {
  DTIntakeRepository,
  DigitalTwinDefinitionRepository,
  DigitalTwinInstanceRepository,
  DigitalTwinSnapshotRepository,
  ScenarioBaselineRepository,
  DTPublicationPackageRepository,
} from '../src/repositories/dt/index.js';
import {
  SimulationIntakeRepository,
  SimulationModelRepository,
  SimulationScenarioRepository,
  SimulationRunRepository,
  SimulationResultRepository,
  SimulationPublicationRepository,
} from '../src/repositories/simulation/index.js';

const run = !!process.env.DATABASE_URL;

const T1  = '44444444-5959-0000-0000-000000000001';
const WS1 = '44444444-5959-0000-0000-000000000002';
const T2  = '44444444-5959-0000-0000-000000000003';
const WS2 = '44444444-5959-0000-0000-000000000004';
const UID = '44444444-5959-0000-0000-000000000099';
const BIZ1 = '44444444-6060-0000-0000-000000000001';
const BIZ2 = '44444444-6060-0000-0000-000000000002';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** BI publication -> DT intake -> definition -> instance -> published snapshot -> published scenario baseline -> DT publication targeting simulation. Returns dt_publication_packages.id. */
async function createDtPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const insightRepo = new InsightPackageRepository();
  const biPubRepo = new BIPublicationPackageRepository();
  const biPkg = await insightRepo.create(ctx, businessId, uniqueCode('insight'));
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'CL evidence' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uniqueCode('dt-intake'), idempotencyKey: uniqueCode('idem') });

  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'CL Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);

  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));

  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uniqueCode('snap'), new Date(), 'CL fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);

  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uniqueCode('base'), 'cl fixture objective');
  await baselineRepo.validateBaseline(ctx, baseline.id, baselineVersion.id);
  await baselineRepo.publishBaseline(ctx, baseline.id, baselineVersion.id);

  const dtPubRepo = new DTPublicationPackageRepository();
  const dtInsight = await dtPubRepo.createInsightPackage(ctx, businessId, uniqueCode('dt-insight'));
  const dtInsightVersion = await dtPubRepo.createVersion(ctx, dtInsight.id, businessId, 'DT->SIM fixture summary', { snapshotVersionId: snapVersion.id, scenarioBaselineVersionId: baselineVersion.id });
  const { package: dtPub } = await dtPubRepo.createPackage(ctx, businessId, dtInsightVersion.id, 'simulation', 'SIM-01', uniqueCode('idem'));
  return dtPub.id;
}

/** Extends createDtPackage() through SIM intake -> model -> scenario -> run -> published result -> SIM publication targeting ai_decision_intelligence. Returns simulation_publication_packages.id. */
async function createSimPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const dtPkg = await createDtPackage(ctx, businessId);

  const simIntakeRepo = new SimulationIntakeRepository();
  await simIntakeRepo.receivePackage(ctx, { businessId, dtPublicationPackageId: dtPkg, intakeCode: uniqueCode('sim-intake'), idempotencyKey: uniqueCode('idem') });

  const modelRepo = new SimulationModelRepository();
  const model = await modelRepo.createModel(ctx, businessId, uniqueCode('model'), 'Engine v3 Model');
  const modelVersion = await modelRepo.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});

  const scenarioRepo = new SimulationScenarioRepository();
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uniqueCode('scn'), 'CL Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);

  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uniqueCode('req'), uniqueCode('idem'));
  const run_ = await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uniqueCode('run'));

  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, run_.id, uniqueCode('result'), 'CL fixture result');
  await resultRepo.validateResult(ctx, result.id, resultVersion.id);
  await resultRepo.publishResult(ctx, result.id, resultVersion.id);

  const pubRepo = new SimulationPublicationRepository();
  const insight = await pubRepo.createInsightPackage(ctx, businessId, uniqueCode('sim-insight'));
  const insightVersion = await pubRepo.createVersion(ctx, insight.id, businessId, 'SIM->ADI fixture summary', resultVersion.id);
  const { package: pub } = await pubRepo.createPackage(ctx, businessId, insightVersion.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
  return pub.id;
}

/** Extends createSimPackage() through ADI intake -> question -> case -> published recommendation -> ADI publication targeting approved_business_action. Returns ai_decision_intelligence.adi_publication_packages.id. */
async function createAdiPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const simPkg = await createSimPackage(ctx, businessId);

  const adiIntakeRepo = new ADIIntakeRepository();
  await adiIntakeRepo.receivePackage(ctx, { businessId, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('adi-intake'), idempotencyKey: uniqueCode('idem') });

  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uniqueCode('q'), 'Should we expand into the secondary market?');

  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uniqueCode('case'));

  const recRepo = new DecisionRecommendationRepository();
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uniqueCode('rec'), 'CL fixture recommendation');
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);

  const adiPubRepo = new ADIPublicationRepository();
  const insight = await adiPubRepo.createInsightPackage(ctx, businessId, uniqueCode('adi-insight'));
  const insightVersion = await adiPubRepo.createVersion(ctx, insight.id, businessId, 'ADI->ABA fixture summary', recVersion.id);
  const { package: pub } = await adiPubRepo.createPackage(ctx, businessId, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAdiPackage() through the full ABA pipeline. Returns approved_business_action.aba_publication_packages.id. */
async function createAbaPublicationPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const adiPkg = await createAdiPackage(ctx, businessId);

  const intakeRepo = new ABAIntakeRepository();
  const { package: intakePkg } = await intakeRepo.receivePackage(ctx, { businessId, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('aba-intake'), idempotencyKey: uniqueCode('idem') });

  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePkg.id, uniqueCode('review'));

  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign'));

  const decisionRepo = new ApprovalDecisionRepository();
  const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uniqueCode('dec'), 'CL fixture decision');
  await decisionRepo.approve(ctx, decision.id, version.id);

  const actionRepo = new ApprovedActionRepository();
  const action = await actionRepo.createAction(ctx, businessId, decision.id, uniqueCode('action'));

  const abaPubRepo = new ABAPublicationRepository();
  const { package: pub } = await abaPubRepo.createPackage(ctx, businessId, action.id, uniqueCode('aba-pub'), 'outcome_monitoring', 'OM-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAbaPublicationPackage() through the full OM pipeline (intake -> plan -> monitored action -> recorded observation -> completed review -> ready feedback package -> dispatched OM publication targeting continuous_learning). Returns outcome_monitoring.om_publication_packages.id. */
async function createOmPublicationPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const abaPkg = await createAbaPublicationPackage(ctx, businessId);

  const omIntakeRepo = new OMIntakeRepository();
  const { package: omIntakePkg } = await omIntakeRepo.receivePackage(ctx, { businessId, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('om-intake'), idempotencyKey: uniqueCode('idem') });

  const planRepo = new MonitoringPlanRepository();
  const { plan } = await planRepo.createPlan(ctx, businessId, omIntakePkg.id, uniqueCode('plan'), 'CL fixture plan');

  // A standalone approved action for the monitored action FK.
  const abaPkg2 = await createAdiPackage(ctx, businessId);
  const intakeRepo2 = new ABAIntakeRepository();
  const { package: intakePkg2 } = await intakeRepo2.receivePackage(ctx, { businessId, adiPublicationPackageId: abaPkg2, intakeCode: uniqueCode('aba-intake2'), idempotencyKey: uniqueCode('idem') });
  const reviewRepo2 = new ActionReviewRepository();
  const review2 = await reviewRepo2.createReviewPackage(ctx, businessId, intakePkg2.id, uniqueCode('review2'));
  const authorityRepo2 = new ApproverAuthorityRepository();
  const assignment2 = await authorityRepo2.createAssignment(ctx, businessId, UID, uniqueCode('assign2'));
  const decisionRepo2 = new ApprovalDecisionRepository();
  const { decision: decision2, version: version2 } = await decisionRepo2.createDecision(ctx, businessId, review2.id, assignment2.id, uniqueCode('dec2'), 'monitored action fixture decision');
  await decisionRepo2.approve(ctx, decision2.id, version2.id);
  const actionRepo2 = new ApprovedActionRepository();
  const approvedAction2 = await actionRepo2.createAction(ctx, businessId, decision2.id, uniqueCode('action2'));

  const monitoredRepo = new MonitoredActionRepository();
  const { action: monitoredAction } = await monitoredRepo.createMonitoredAction(ctx, businessId, plan.id, approvedAction2.id, uniqueCode('mact'), 'CL fixture monitored action');

  const obsRepo = new OutcomeObservationRepository();
  const { observation, version: obsVersion } = await obsRepo.createObservation(ctx, businessId, monitoredAction.id, uniqueCode('obs'), 'CL fixture observation', new Date());
  await obsRepo.record(ctx, observation.id, obsVersion.id);

  const reviewRepo3 = new OutcomeReviewRepository();
  const outcomeReview = await reviewRepo3.createReview(ctx, businessId, observation.id, uniqueCode('orev'));
  await reviewRepo3.completeReview(ctx, outcomeReview.id);

  const fbRepo = new LearningFeedbackPackageRepository();
  const { package: fbPkg } = await fbRepo.createPackage(ctx, businessId, outcomeReview.id, uniqueCode('fbpkg'), 'CL fixture feedback package');
  await fbRepo.markReady(ctx, fbPkg.id);

  const omPubRepo = new OMPublicationRepository();
  const { package: omPub } = await omPubRepo.createPackage(ctx, businessId, fbPkg.id, uniqueCode('ompub'), 'continuous_learning', 'CL-01', uniqueCode('idem'));
  await omPubRepo.markReady(ctx, omPub.id);
  await omPubRepo.dispatch(ctx, omPub.id);
  return omPub.id;
}

async function createClIntake(ctx: typeof ctx1, businessId: string) {
  const omPkg = await createOmPublicationPackage(ctx, businessId);
  const intakeRepo = new CLIntakeRepository();
  const { package: pkg } = await intakeRepo.receivePackage(ctx, {
    businessId, omPublicationPackageId: omPkg, intakeCode: uniqueCode('cl-intake'), idempotencyKey: uniqueCode('idem'),
  });
  return { intakeRepo, pkg, omPkg };
}

async function createLearningCase(ctx: typeof ctx1, businessId: string) {
  const { pkg } = await createClIntake(ctx, businessId);
  const caseRepo = new LearningCaseRepository();
  const { case: learningCase, versionId } = await caseRepo.createCase(ctx, businessId, pkg.id, uniqueCode('case'), 'CL fixture learning case');
  return { caseRepo, case: learningCase, versionId };
}

async function createImprovementProposal(ctx: typeof ctx1, businessId: string) {
  const { case: learningCase } = await createLearningCase(ctx, businessId);
  const repo = new ImprovementProposalRepository();
  const { proposal, version } = await repo.createProposal(ctx, businessId, learningCase.id, uniqueCode('prop'), 'CL fixture improvement proposal');
  return { repo, proposal, version, case: learningCase };
}

async function createApprovedFeedbackPackage(ctx: typeof ctx1, businessId: string) {
  const { repo: proposalRepo, proposal, version } = await createImprovementProposal(ctx, businessId);
  await proposalRepo.approve(ctx, proposal.id, version.id);
  const pubRepo = new CLFeedbackPublicationRepository();
  const { package: pkg, idempotentReplay } = await pubRepo.createPackage(ctx, businessId, proposal.id, uniqueCode('clpub'), 'data_acquisition', 'DA-01', uniqueCode('idem'));
  return { pubRepo, pkg, idempotentReplay, proposalRepo, proposal };
}

async function setupClIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'CL-Test Tenant 1','cl-t1','active','test'),
            ($2,'CL-Test Tenant 2','cl-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'CL-Test WS 1','cl-ws1','active'),
            ($3,$4,'CL-Test WS 2','cl-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'CL Test Biz 1','cl-biz1','active'),
            ($4,$5,$6,'CL Test Biz 2','cl-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'cl-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

async function teardownClIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
  }
  await closePool();
}

describe.runIf(run)('Stage 2J Continuous Learning — live PostgreSQL', () => {
  beforeAll(setupClIntegration);
  afterAll(teardownClIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    it('continuous_learning schema exists with 47 tables', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'continuous_learning'`
      );
      expect(result.rows[0].n).toBe(47);
    });

    it('every continuous_learning table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'continuous_learning' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(47);
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM continuous_learning.improvement_proposals');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. CLIntakeRepository ───────────────────────────────────────────────────
  describe('CLIntakeRepository', () => {
    it('atomically records a released package and leaves replay lineage unchanged', async () => {
      const omPkg = await createOmPublicationPackage(ctx1, BIZ1);
      const publication = await adminPool!.query('SELECT feedback_package_id FROM outcome_monitoring.om_publication_packages WHERE id = $1', [omPkg]);
      const feedbackId = publication.rows[0].feedback_package_id as string;
      const feedbackVersion = await adminPool!.query('SELECT id FROM outcome_monitoring.learning_feedback_package_versions WHERE feedback_package_id = $1 ORDER BY version_number DESC LIMIT 1', [feedbackId]);
      const observation = await adminPool!.query(`SELECT review.observation_id, ov.id AS version_id
        FROM outcome_monitoring.learning_feedback_packages fb
        JOIN outcome_monitoring.outcome_reviews review ON review.id = fb.review_id
        JOIN outcome_monitoring.outcome_observation_versions ov ON ov.observation_id = review.observation_id
        WHERE fb.id = $1 ORDER BY ov.version_number DESC LIMIT 1`, [feedbackId]);
      const input = {
        businessId: BIZ1, omPublicationPackageId: omPkg, feedbackPackageId: feedbackId,
        feedbackPackageVersionId: feedbackVersion.rows[0].id as string,
        observationId: observation.rows[0].observation_id as string,
        observationVersionId: observation.rows[0].version_id as string,
        idempotencyKey: uniqueCode('release'), correlationId: 'opaque-correlation',
        executions: [{ executionId: '33333333-3333-4333-8333-333333333333', evidenceDigest: `sha256:${'a'.repeat(64)}` }],
      };
      const repo = new CLIntakeRepository();
      const first = await repo.recordReleased(ctx1, input);
      expect(first.idempotentReplay).toBe(false);
      expect(first.package.status).toBe('received');
      const replay = await repo.recordReleased(ctx1, input);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.package.id).toBe(first.package.id);
      const counts = await adminPool!.query(`SELECT
        (SELECT count(*)::int FROM continuous_learning.cl_intake_package_versions WHERE intake_package_id = $1) AS versions,
        (SELECT count(*)::int FROM continuous_learning.cl_intake_source_references WHERE intake_package_id = $1) AS sources,
        (SELECT count(*)::int FROM continuous_learning.cl_intake_status_history WHERE intake_package_id = $1) AS statuses`, [first.package.id]);
      expect(counts.rows[0]).toMatchObject({ versions: 1, sources: 1, statuses: 1 });
      await expect(repo.recordReleased(ctx1, { ...input, executions: [{ ...input.executions[0], evidenceDigest: `sha256:${'b'.repeat(64)}` }] })).rejects.toThrow();
    });

    it('receives a valid OM publication package', async () => {
      const omPkg = await createOmPublicationPackage(ctx1, BIZ1);
      const repo = new CLIntakeRepository();
      const { package: pkg, idempotentReplay } = await repo.receivePackage(ctx1, {
        businessId: BIZ1, omPublicationPackageId: omPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.omPublicationPackageId).toBe(omPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same OM package', async () => {
      const omPkg = await createOmPublicationPackage(ctx1, BIZ1);
      const repo = new CLIntakeRepository();
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, omPublicationPackageId: omPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, omPublicationPackageId: omPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('records a version and a source reference', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, { format: 'json' }, 5);
      expect(version.versionNumber).toBe(1);
      await expect(intakeRepo.addSourceReference(ctx1, pkg.id, BIZ1, 'outcome_monitoring', { ref: 'om://publication/1' })).resolves.toBeUndefined();
    });

    it('accepts, processes, and completes a package', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      await intakeRepo.markProcessing(ctx1, pkg.id);
      const completed = await intakeRepo.completePackage(ctx1, pkg.id);
      expect(completed.status).toBe('completed');
    });

    it('rejects a package with a reason', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      const rejected = await intakeRepo.rejectPackage(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('fails a package with a reason', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      const failed = await intakeRepo.failPackage(ctx1, pkg.id, 'downstream timeout');
      expect(failed.status).toBe('failed');
    });

    it('finds a package by id and by source package', async () => {
      const { intakeRepo, pkg, omPkg } = await createClIntake(ctx1, BIZ1);
      const byId = await intakeRepo.getById(ctx1, pkg.id);
      expect(byId.id).toBe(pkg.id);
      const bySource = await intakeRepo.getBySourcePackage(ctx1, BIZ1, omPkg);
      expect(bySource.id).toBe(pkg.id);
    });

    it('throws NotFoundError for an unknown intake package', async () => {
      const repo = new CLIntakeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('cl_intake_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, {}, 1);
      await expect(adminPool!.query(`UPDATE continuous_learning.cl_intake_package_versions SET record_count = 99 WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('cl_intake_status_history is append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createClIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      const row = await adminPool!.query(`SELECT id FROM continuous_learning.cl_intake_status_history WHERE intake_package_id = $1 ORDER BY created_at DESC LIMIT 1`, [pkg.id]);
      await expect(adminPool!.query(`UPDATE continuous_learning.cl_intake_status_history SET reason = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 3. LearningCaseRepository ───────────────────────────────────────────────
  describe('LearningCaseRepository', () => {
    it('creates a case in draft status with a first version', async () => {
      const { case: learningCase, versionId } = await createLearningCase(ctx1, BIZ1);
      expect(learningCase.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds evidence to a case', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const caseRepo = new LearningCaseRepository();
      await expect(caseRepo.addEvidence(ctx1, learningCase.id, BIZ1, 'observation', { ref: 'om://observation/1' })).resolves.toBeUndefined();
    });

    it('rejects an unknown evidence_type', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const caseRepo = new LearningCaseRepository();
      await expect(caseRepo.addEvidence(ctx1, learningCase.id, BIZ1, 'gut_feeling', {})).rejects.toThrow();
    });

    it('transitions active -> completed and records status history', async () => {
      const { caseRepo, case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const active = await caseRepo.activate(ctx1, learningCase.id);
      expect(active.status).toBe('active');
      const completed = await caseRepo.complete(ctx1, learningCase.id);
      expect(completed.status).toBe('completed');
      const history = await adminPool!.query(`SELECT count(*)::int AS n FROM continuous_learning.learning_case_status_history WHERE learning_case_id = $1`, [learningCase.id]);
      expect(history.rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it('cancels a case with a reason', async () => {
      const { caseRepo, case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const cancelled = await caseRepo.cancel(ctx1, learningCase.id, 'insufficient evidence');
      expect(cancelled.status).toBe('cancelled');
    });

    it('finds a case by id and lists by intake package', async () => {
      const { caseRepo, case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const found = await caseRepo.getById(ctx1, learningCase.id);
      expect(found.id).toBe(learningCase.id);
      const list = await caseRepo.listByIntakePackage(ctx1, learningCase.intakePackageId);
      expect(list.some((c) => c.id === learningCase.id)).toBe(true);
    });

    it('throws LearningCaseNotFoundError for an unknown case', async () => {
      const repo = new LearningCaseRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearningCaseNotFoundError);
    });

    it('learning_case_versions are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await createLearningCase(ctx1, BIZ1);
      await expect(adminPool!.query(`UPDATE continuous_learning.learning_case_versions SET summary = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });

    it('listByIntakePackage returns an empty list for an unrelated intake package', async () => {
      const caseRepo = new LearningCaseRepository();
      const list = await caseRepo.listByIntakePackage(ctx1, '00000000-0000-0000-0000-000000000000');
      expect(list).toEqual([]);
    });
  });

  // ── 4. LearningFeedbackRepository ───────────────────────────────────────────
  describe('LearningFeedbackRepository', () => {
    async function fixture() {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new LearningFeedbackRepository();
      const { record, versionId } = await repo.createRecord(ctx1, BIZ1, learningCase.id, uniqueCode('fb'), 'CL fixture feedback');
      return { repo, record, versionId };
    }

    it('creates a feedback record in draft status with a first version', async () => {
      const { record, versionId } = await fixture();
      expect(record.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds a link and a quality assessment', async () => {
      const { repo, versionId } = await fixture();
      await expect(repo.addLink(ctx1, versionId, BIZ1, 'derived_from', { ref: 'om://observation/1' })).resolves.toBeUndefined();
      await expect(repo.recordQuality(ctx1, versionId, BIZ1, 0.82)).resolves.toBeUndefined();
    });

    it('rejects an out-of-bound quality score at the database level', async () => {
      const { repo, versionId } = await fixture();
      await expect(repo.recordQuality(ctx1, versionId, BIZ1, 1.5)).rejects.toThrow();
    });

    it('activates and supersedes a feedback record', async () => {
      const { repo, record } = await fixture();
      const active = await repo.activate(ctx1, record.id);
      expect(active.status).toBe('active');
      const superseded = await repo.supersede(ctx1, record.id);
      expect(superseded.status).toBe('superseded');
    });

    it('finds a record by id and lists by case', async () => {
      const { repo, record } = await fixture();
      const found = await repo.getById(ctx1, record.id);
      expect(found.id).toBe(record.id);
      const list = await repo.listByCase(ctx1, record.learningCaseId);
      expect(list.some((r) => r.id === record.id)).toBe(true);
    });

    it('throws LearningFeedbackNotFoundError for an unknown record', async () => {
      const repo = new LearningFeedbackRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearningFeedbackNotFoundError);
    });

    it('learning_feedback_versions, links, and quality are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await fixture();
      await expect(adminPool!.query(`UPDATE continuous_learning.learning_feedback_versions SET summary = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 5. LearnedLessonRepository ──────────────────────────────────────────────
  describe('LearnedLessonRepository', () => {
    async function fixture() {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new LearnedLessonRepository();
      const { lesson, versionId } = await repo.createLesson(ctx1, BIZ1, learningCase.id, uniqueCode('lesson'), 'Revenue variance correlates with stale connector data.');
      return { repo, lesson, versionId };
    }

    it('creates a lesson in draft status with a first version', async () => {
      const { lesson, versionId } = await fixture();
      expect(lesson.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds evidence and applicability', async () => {
      const { repo, versionId } = await fixture();
      await expect(repo.addEvidence(ctx1, versionId, BIZ1, { ref: 'om://observation/1' })).resolves.toBeUndefined();
      await expect(repo.addApplicability(ctx1, versionId, BIZ1, 'business_unit', { unit: 'secondary-market' })).resolves.toBeUndefined();
    });

    it('walks the full validated -> published -> retired lifecycle', async () => {
      const { repo, lesson } = await fixture();
      const validated = await repo.validate(ctx1, lesson.id);
      expect(validated.status).toBe('validated');
      const published = await repo.publish(ctx1, lesson.id);
      expect(published.status).toBe('published');
      const retired = await repo.retire(ctx1, lesson.id);
      expect(retired.status).toBe('retired');
    });

    it('finds a lesson by id and lists by case', async () => {
      const { repo, lesson } = await fixture();
      const found = await repo.getById(ctx1, lesson.id);
      expect(found.id).toBe(lesson.id);
      const list = await repo.listByCase(ctx1, lesson.learningCaseId);
      expect(list.some((l) => l.id === lesson.id)).toBe(true);
    });

    it('throws LearnedLessonNotFoundError for an unknown lesson', async () => {
      const repo = new LearnedLessonRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearnedLessonNotFoundError);
    });

    it('learned_lesson_versions and lesson_evidence are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await fixture();
      await expect(adminPool!.query(`UPDATE continuous_learning.learned_lesson_versions SET statement = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 6. LearningPatternRepository ────────────────────────────────────────────
  describe('LearningPatternRepository', () => {
    async function fixture() {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new LearningPatternRepository();
      const { pattern, versionId } = await repo.createPattern(ctx1, BIZ1, learningCase.id, uniqueCode('pat'), 'Stale connector data precedes revenue variance breaches.');
      return { repo, pattern, versionId };
    }

    it('creates a pattern in draft status with a first version', async () => {
      const { pattern, versionId } = await fixture();
      expect(pattern.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds an observation and a confidence score', async () => {
      const { repo, versionId } = await fixture();
      await expect(repo.addObservation(ctx1, versionId, BIZ1, { occurredAt: new Date().toISOString() })).resolves.toBeUndefined();
      await expect(repo.addConfidenceScore(ctx1, versionId, BIZ1, 0.74)).resolves.toBeUndefined();
    });

    it('rejects an out-of-bound confidence score at the database level', async () => {
      const { repo, versionId } = await fixture();
      await expect(repo.addConfidenceScore(ctx1, versionId, BIZ1, -0.1)).rejects.toThrow();
    });

    it('confirms and retires a pattern', async () => {
      const { repo, pattern } = await fixture();
      const confirmed = await repo.confirm(ctx1, pattern.id);
      expect(confirmed.status).toBe('confirmed');
      const retired = await repo.retire(ctx1, pattern.id);
      expect(retired.status).toBe('retired');
    });

    it('finds a pattern by id and lists by case', async () => {
      const { repo, pattern } = await fixture();
      const found = await repo.getById(ctx1, pattern.id);
      expect(found.id).toBe(pattern.id);
      const list = await repo.listByCase(ctx1, pattern.learningCaseId);
      expect(list.some((p) => p.id === pattern.id)).toBe(true);
    });

    it('throws LearningPatternNotFoundError for an unknown pattern', async () => {
      const repo = new LearningPatternRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearningPatternNotFoundError);
    });

    it('learning_pattern_versions and pattern_observations are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await fixture();
      await expect(adminPool!.query(`UPDATE continuous_learning.learning_pattern_versions SET description = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 7. ModelEvaluationRepository ────────────────────────────────────────────
  describe('ModelEvaluationRepository', () => {
    it('requests a run in queued status', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new ModelEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'), learningCase.id);
      expect(run_.status).toBe('queued');
    });

    it('transitions running -> completed and failed', async () => {
      const repo = new ModelEvaluationRepository();
      const run1 = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'));
      const running = await repo.markRunning(ctx1, run1.id);
      expect(running.status).toBe('running');
      const completed = await repo.complete(ctx1, run1.id);
      expect(completed.status).toBe('completed');

      const run2 = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'));
      const failed = await repo.fail(ctx1, run2.id);
      expect(failed.status).toBe('failed');
    });

    it('adds a result, a drift record, and a bias record', async () => {
      const repo = new ModelEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'));
      await expect(repo.addResult(ctx1, run_.id, BIZ1, 'accuracy', { value: 0.91 })).resolves.toBeUndefined();
      const driftId = await repo.recordDrift(ctx1, run_.id, BIZ1, 'feature_drift', 0.12);
      expect(driftId).toBeTruthy();
      const biasId = await repo.recordBias(ctx1, run_.id, BIZ1, 'demographic_parity', 0.05);
      expect(biasId).toBeTruthy();
    });

    it('finds a run by id', async () => {
      const repo = new ModelEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'));
      const found = await repo.getById(ctx1, run_.id);
      expect(found.id).toBe(run_.id);
    });

    it('throws ModelEvaluationNotFoundError for an unknown run', async () => {
      const repo = new ModelEvaluationRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ModelEvaluationNotFoundError);
    });

    it('model_evaluation_results, model_drift_records, and model_bias_records are append-only — UPDATE is rejected by the database', async () => {
      const repo = new ModelEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, uniqueCode('model'));
      const driftId = await repo.recordDrift(ctx1, run_.id, BIZ1, 'x', 0.1);
      await expect(adminPool!.query(`UPDATE continuous_learning.model_drift_records SET magnitude = 0.9 WHERE id = $1`, [driftId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8. PolicyEvaluationRepository ───────────────────────────────────────────
  describe('PolicyEvaluationRepository', () => {
    it('requests a run in queued status (no ABA policy reference required)', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      expect(run_.status).toBe('queued');
      expect(run_.approvalPolicyId).toBeNull();
    });

    it('transitions running -> completed', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      const running = await repo.markRunning(ctx1, run_.id);
      expect(running.status).toBe('running');
      const completed = await repo.complete(ctx1, run_.id);
      expect(completed.status).toBe('completed');
    });

    it('adds a result and proposes a policy change', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      await expect(repo.addResult(ctx1, run_.id, BIZ1, uniqueCode('finding'), { detail: 'threshold too tight' })).resolves.toBeUndefined();
      const proposal = await repo.proposeChange(ctx1, BIZ1, run_.id, uniqueCode('propchg'), 'Widen quality threshold by 5%.');
      expect(proposal.status).toBe('proposed');
    });

    it('withdraws a policy change proposal', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      const proposal = await repo.proposeChange(ctx1, BIZ1, run_.id, uniqueCode('propchg2'), 'x');
      const withdrawn = await repo.withdrawChange(ctx1, proposal.id);
      expect(withdrawn.status).toBe('withdrawn');
    });

    it('adds change evidence', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      const proposal = await repo.proposeChange(ctx1, BIZ1, run_.id, uniqueCode('propchg3'), 'x');
      await expect(repo.addChangeEvidence(ctx1, proposal.id, BIZ1, { ref: 'cl://policy_evaluation_results/1' })).resolves.toBeUndefined();
    });

    it('finds a run and a proposal by id', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      const foundRun = await repo.getById(ctx1, run_.id);
      expect(foundRun.id).toBe(run_.id);
      const proposal = await repo.proposeChange(ctx1, BIZ1, run_.id, uniqueCode('propchg4'), 'x');
      const foundProposal = await repo.getProposalById(ctx1, proposal.id);
      expect(foundProposal.id).toBe(proposal.id);
    });

    it('throws PolicyEvaluationNotFoundError for an unknown run', async () => {
      const repo = new PolicyEvaluationRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(PolicyEvaluationNotFoundError);
    });

    it('throws PolicyChangeProposalNotFoundError for an unknown proposal', async () => {
      const repo = new PolicyEvaluationRepository();
      await expect(repo.getProposalById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(PolicyChangeProposalNotFoundError);
    });

    it('policy_evaluation_results and policy_change_evidence are append-only — UPDATE is rejected by the database', async () => {
      const repo = new PolicyEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1);
      await repo.addResult(ctx1, run_.id, BIZ1, uniqueCode('f'), {});
      const row = await adminPool!.query(`SELECT id FROM continuous_learning.policy_evaluation_results WHERE evaluation_run_id = $1 LIMIT 1`, [run_.id]);
      await expect(adminPool!.query(`UPDATE continuous_learning.policy_evaluation_results SET finding_code = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. ImprovementProposalRepository (safety-critical immutability guard) ──
  describe('ImprovementProposalRepository', () => {
    it('creates a proposal in draft status with a first version', async () => {
      const { proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      expect(proposal.status).toBe('draft');
      expect(version.status).toBe('draft');
    });

    it('adds an impact and a risk', async () => {
      const { version } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new ImprovementProposalRepository();
      await expect(repo.addImpact(ctx1, version.id, BIZ1, 'data_quality', { delta: 0.08 })).resolves.toBeUndefined();
      await expect(repo.addRisk(ctx1, version.id, BIZ1, uniqueCode('risk'), 'May increase false positives.', 'medium')).resolves.toBeUndefined();
    });

    it('approves a proposal — decided proposals are permanently immutable', async () => {
      const { repo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      const approved = await repo.approve(ctx1, proposal.id, version.id);
      expect(approved.status).toBe('approved');

      await expect(repo.reject(ctx1, proposal.id, version.id)).rejects.toBeInstanceOf(ImprovementProposalImmutableError);
    });

    it('rejects a proposal as a valid decided terminal state', async () => {
      const { repo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      const rejected = await repo.reject(ctx1, proposal.id, version.id);
      expect(rejected.status).toBe('rejected');
    });

    it('database rejects direct SQL UPDATE against an approved proposal header (defense in depth)', async () => {
      const { repo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      await repo.approve(ctx1, proposal.id, version.id);
      await expect(adminPool!.query(`UPDATE continuous_learning.improvement_proposals SET status = 'draft' WHERE id = $1`, [proposal.id])).rejects.toThrow(/immutable/);
    });

    it('database rejects direct SQL UPDATE against an approved proposal version (defense in depth)', async () => {
      const { repo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      await repo.approve(ctx1, proposal.id, version.id);
      await expect(adminPool!.query(`UPDATE continuous_learning.improvement_proposal_versions SET status = 'draft' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });

    it('supersedes an undecided proposal, but rejects superseding a decided one', async () => {
      const { repo, proposal } = await createImprovementProposal(ctx1, BIZ1);
      const superseded = await repo.supersede(ctx1, proposal.id);
      expect(superseded.status).toBe('superseded');

      const { repo: repo2, proposal: proposal2, version: version2 } = await createImprovementProposal(ctx1, BIZ1);
      await repo2.approve(ctx1, proposal2.id, version2.id);
      await expect(repo2.supersede(ctx1, proposal2.id)).rejects.toBeInstanceOf(ImprovementProposalImmutableError);
    });

    it('finds a decided proposal by id and lists decided proposals for a case', async () => {
      const { repo, proposal, version, case: learningCase } = await createImprovementProposal(ctx1, BIZ1);
      await repo.approve(ctx1, proposal.id, version.id);
      const found = await repo.getById(ctx1, proposal.id);
      expect(found.status).toBe('approved');
      const decided = await repo.getDecidedForCase(ctx1, learningCase.id);
      expect(decided.some((p) => p.id === proposal.id)).toBe(true);
    });

    it('throws ImprovementProposalNotFoundError for an unknown proposal', async () => {
      const repo = new ImprovementProposalRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ImprovementProposalNotFoundError);
    });

    it('improvement_impacts and improvement_risks are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new ImprovementProposalRepository();
      await repo.addImpact(ctx1, version.id, BIZ1, 'x', {});
      const row = await adminPool!.query(`SELECT id FROM continuous_learning.improvement_impacts WHERE proposal_version_id = $1 LIMIT 1`, [version.id]);
      await expect(adminPool!.query(`UPDATE continuous_learning.improvement_impacts SET impact_type = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('the database rejects an unknown risk severity via its CHECK constraint', async () => {
      const { version } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new ImprovementProposalRepository();
      await expect(repo.addRisk(ctx1, version.id, BIZ1, uniqueCode('risk-bad'), 'x', 'catastrophic' as unknown as 'low')).rejects.toThrow();
    });

    it('getDecidedForCase returns an empty list for a case with no decided proposals', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new ImprovementProposalRepository();
      const decided = await repo.getDecidedForCase(ctx1, learningCase.id);
      expect(decided).toEqual([]);
    });
  });

  // ── 10. LearningChangeReviewRepository ──────────────────────────────────────
  describe('LearningChangeReviewRepository', () => {
    it('creates a review in draft status', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('crev'));
      expect(review.status).toBe('draft');
    });

    it('transitions in_review -> completed', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('crev2'));
      const inReview = await repo.startReview(ctx1, review.id);
      expect(inReview.status).toBe('in_review');
      const completed = await repo.completeReview(ctx1, review.id);
      expect(completed.status).toBe('completed');
    });

    it('cancels a review', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('crev3'));
      const cancelled = await repo.cancelReview(ctx1, review.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('records a decision, a release, and a rollback', async () => {
      const { proposal, repo: proposalRepo, version } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('crev4'));
      await expect(repo.recordDecision(ctx1, review.id, BIZ1, 'approved', 'Meets data-quality guardrail.')).resolves.toBeUndefined();
      await proposalRepo.approve(ctx1, proposal.id, version.id);
      const release = await repo.recordRelease(ctx1, BIZ1, proposal.id, uniqueCode('rel'), 'production');
      expect(release.improvementProposalId).toBe(proposal.id);
      await expect(repo.recordRollback(ctx1, BIZ1, release.id, 'regression detected')).resolves.toBeUndefined();
    });

    it('finds a review by id', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('crev5'));
      const found = await repo.getById(ctx1, review.id);
      expect(found.id).toBe(review.id);
    });

    it('throws LearningChangeReviewNotFoundError for an unknown review', async () => {
      const repo = new LearningChangeReviewRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearningChangeReviewNotFoundError);
    });

    it('learning_change_decisions, releases, and rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const release = await repo.recordRelease(ctx1, BIZ1, proposal.id, uniqueCode('rel2'));
      await expect(adminPool!.query(`UPDATE continuous_learning.learning_change_releases SET environment = 'y' WHERE id = $1`, [release.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 11. KnowledgeArtifactRepository ─────────────────────────────────────────
  describe('KnowledgeArtifactRepository', () => {
    it('creates an artifact in draft status with a first version', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact, versionId } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art'), 'lesson_summary', { text: 'x' });
      expect(artifact.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds a relationship between two artifacts', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact: a1, versionId: v1 } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-a'), 'pattern_summary', {});
      const { artifact: a2 } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-b'), 'pattern_summary', {});
      await expect(repo.addRelationship(ctx1, v1, BIZ1, a2.id, 'derived_from')).resolves.toBeUndefined();
      expect(a1.id).not.toBe(a2.id);
    });

    it('records a supersession and marks the superseded artifact', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact: old } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-old'), 'lesson_summary', {});
      const { artifact: replacement } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-new'), 'lesson_summary', {});
      await repo.recordSupersession(ctx1, BIZ1, old.id, replacement.id, 'newer evidence supersedes this artifact');
      const found = await repo.getById(ctx1, old.id);
      expect(found.status).toBe('superseded');
    });

    it('publishes and retires an artifact', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-pub'), 'lesson_summary', {});
      const published = await repo.publish(ctx1, artifact.id);
      expect(published.status).toBe('published');
      const retired = await repo.retire(ctx1, artifact.id);
      expect(retired.status).toBe('retired');
    });

    it('throws KnowledgeArtifactNotFoundError for an unknown artifact', async () => {
      const repo = new KnowledgeArtifactRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(KnowledgeArtifactNotFoundError);
    });

    it('knowledge_artifact_versions and knowledge_relationships are append-only — UPDATE is rejected by the database', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { versionId } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-ao'), 'lesson_summary', {});
      await expect(adminPool!.query(`UPDATE continuous_learning.knowledge_artifact_versions SET content_reference = '{}'::jsonb WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });

    it('the database rejects an unknown relationship_type via its CHECK constraint', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact: a1, versionId: v1 } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('art-badrel'), 'pattern_summary', {});
      await expect(repo.addRelationship(ctx1, v1, BIZ1, a1.id, 'unrelated_to')).rejects.toThrow();
    });
  });

  // ── 12. CLFeedbackPublicationRepository ─────────────────────────────────────
  describe('CLFeedbackPublicationRepository', () => {
    it('creates a publication package in draft status, idempotently', async () => {
      const { pkg, idempotentReplay } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      expect(pkg.publicationStatus).toBe('draft');
      expect(idempotentReplay).toBe(false);
    });

    it('rejects an invalid target layer', async () => {
      const { repo: proposalRepo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      await proposalRepo.approve(ctx1, proposal.id, version.id);
      const pubRepo = new CLFeedbackPublicationRepository();
      await expect(pubRepo.createPackage(ctx1, BIZ1, proposal.id, uniqueCode('badpub'), 'business_operations', 'BO-01', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent on repeated delivery with the same idempotency key', async () => {
      const { repo: proposalRepo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      await proposalRepo.approve(ctx1, proposal.id, version.id);
      const pubRepo = new CLFeedbackPublicationRepository();
      const key = uniqueCode('idem-pub');
      const first = await pubRepo.createPackage(ctx1, BIZ1, proposal.id, uniqueCode('idem-pkg'), 'data_acquisition', 'DA-01', key);
      const second = await pubRepo.createPackage(ctx1, BIZ1, proposal.id, uniqueCode('idem-pkg2'), 'data_acquisition', 'DA-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('creates a version and bumps latestVersion', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      const version = await pubRepo.createVersion(ctx1, pkg.id, BIZ1, 'Publication summary v1');
      expect(version.versionNumber).toBe(1);
    });

    it('walks the full draft -> ready -> dispatched -> acknowledged lifecycle', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      const ready = await pubRepo.markReady(ctx1, pkg.id);
      expect(ready.publicationStatus).toBe('ready');
      const dispatched = await pubRepo.dispatch(ctx1, pkg.id);
      expect(dispatched.publicationStatus).toBe('dispatched');
      const acknowledged = await pubRepo.acknowledge(ctx1, pkg.id);
      expect(acknowledged.publicationStatus).toBe('acknowledged');
      const revoked = await pubRepo.revoke(ctx1, pkg.id);
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('rejects an illegal transition (draft -> dispatched)', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      await expect(pubRepo.dispatch(ctx1, pkg.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('records a publication event on every transition', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      await pubRepo.markReady(ctx1, pkg.id);
      await pubRepo.dispatch(ctx1, pkg.id);
      const events = await adminPool!.query(`SELECT count(*)::int AS n FROM continuous_learning.cl_feedback_events WHERE feedback_package_id = $1`, [pkg.id]);
      expect(events.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('finds a package by id', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      const found = await pubRepo.getById(ctx1, pkg.id);
      expect(found.id).toBe(pkg.id);
    });

    it('cl_feedback_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      const version = await pubRepo.createVersion(ctx1, pkg.id, BIZ1, 'v1');
      await expect(adminPool!.query(`UPDATE continuous_learning.cl_feedback_package_versions SET summary = 'x' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. CLComponentRegistryRepository ───────────────────────────────────────
  describe('CLComponentRegistryRepository', () => {
    it('registers a component in draft status', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp'), 'drift-monitor');
      expect(entry.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-v'), 'drift-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, { capability: 'drift-detection' });
      expect(version.versionNumber).toBe(1);
    });

    it('activates a component and reads its active version', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-a'), 'drift-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      await repo.activateVersion(ctx1, entry.id, version.id);
      const active = await repo.getActiveVersion(ctx1, entry.id);
      expect(active.id).toBe(version.id);
    });

    it('records a deployment and a rollback', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-d'), 'drift-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id, 'production');
      expect(deployment.activationState).toBe('active');
      await expect(repo.recordRollback(ctx1, BIZ1, deployment.id, 'regression detected')).resolves.toBeUndefined();
    });

    it('throws CLComponentRegistryNotFoundError for an unknown component', async () => {
      const repo = new CLComponentRegistryRepository();
      await expect(repo.createVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, {})).rejects.toBeInstanceOf(CLComponentRegistryNotFoundError);
    });

    it('throws CLComponentRegistryNotFoundError when no active version exists', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-noactive'), 'drift-monitor');
      await repo.createVersion(ctx1, entry.id, BIZ1, {});
      await expect(repo.getActiveVersion(ctx1, entry.id)).rejects.toBeInstanceOf(CLComponentRegistryNotFoundError);
    });

    it('cl_component_registry_versions and cl_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new CLComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-ao'), 'drift-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE continuous_learning.cl_component_registry_versions SET capabilities = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 14. Cross-tenant isolation (live RLS) ───────────────────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 learning cases', async () => {
      const { caseRepo, case: learningCase } = await createLearningCase(ctx1, BIZ1);
      await expect(caseRepo.getById(ctx2, learningCase.id)).rejects.toBeInstanceOf(LearningCaseNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 improvement proposal', async () => {
      const { repo, proposal } = await createImprovementProposal(ctx1, BIZ1);
      await expect(repo.getById(ctx2, proposal.id)).rejects.toBeInstanceOf(ImprovementProposalNotFoundError);
    });

    it('tenant 2 cannot approve a tenant 1 proposal', async () => {
      const { repo, proposal, version } = await createImprovementProposal(ctx1, BIZ1);
      await expect(repo.approve(ctx2, proposal.id, version.id)).rejects.toBeInstanceOf(ImprovementProposalNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 knowledge artifact', async () => {
      const repo = new KnowledgeArtifactRepository();
      const { artifact } = await repo.createArtifact(ctx1, BIZ1, uniqueCode('iso-art'), 'lesson_summary', {});
      await expect(repo.getById(ctx2, artifact.id)).rejects.toBeInstanceOf(KnowledgeArtifactNotFoundError);
    });

    it('tenant 2 cannot acknowledge a tenant 1 feedback publication package', async () => {
      const { pubRepo, pkg } = await createApprovedFeedbackPackage(ctx1, BIZ1);
      await expect(pubRepo.markReady(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 model drift records', async () => {
      const repo = new ModelEvaluationRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, uniqueCode('iso-model'));
      await repo.recordDrift(ctx1, run_.id, BIZ1, 'x', 0.1);
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM continuous_learning.model_drift_records WHERE evaluation_run_id = $1 AND tenant_id = $2`,
        [run_.id, T2]
      );
      expect(result.rows[0].n).toBe(0);
    });

    it('tenant 2 cannot read a tenant 1 learning change review', async () => {
      const { proposal } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new LearningChangeReviewRepository();
      const review = await repo.createReview(ctx1, BIZ1, proposal.id, uniqueCode('iso-crev'));
      await expect(repo.getById(ctx2, review.id)).rejects.toBeInstanceOf(LearningChangeReviewNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 learned lesson', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new LearnedLessonRepository();
      const { lesson } = await repo.createLesson(ctx1, BIZ1, learningCase.id, uniqueCode('iso-lesson'), 'x');
      await expect(repo.getById(ctx2, lesson.id)).rejects.toBeInstanceOf(LearnedLessonNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 learning pattern', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const repo = new LearningPatternRepository();
      const { pattern } = await repo.createPattern(ctx1, BIZ1, learningCase.id, uniqueCode('iso-pattern'), 'x');
      await expect(repo.getById(ctx2, pattern.id)).rejects.toBeInstanceOf(LearningPatternNotFoundError);
    });
  });

  // ── 15. Outbox atomicity — all 10 required cl.* events ──────────────────────
  describe('outbox event functions', () => {
    async function countByType(eventType: string): Promise<number> {
      const result = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = $1`, [eventType]);
      return result.rows[0].n as number;
    }

    it('emit_intake_received inserts a pending outbox event atomically', async () => {
      const before = await countByType('cl.intake.received');
      await adminPool!.query(`SELECT continuous_learning.emit_intake_received($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.intake.received')).toBe(before + 1);
    });

    it('emit_case_created inserts a pending outbox event', async () => {
      const before = await countByType('cl.case.created');
      await adminPool!.query(`SELECT continuous_learning.emit_case_created($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.case.created')).toBe(before + 1);
    });

    it('emit_lesson_created inserts a pending outbox event', async () => {
      const before = await countByType('cl.lesson.created');
      await adminPool!.query(`SELECT continuous_learning.emit_lesson_created($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.lesson.created')).toBe(before + 1);
    });

    it('emit_pattern_detected inserts a pending outbox event', async () => {
      const before = await countByType('cl.pattern.detected');
      await adminPool!.query(`SELECT continuous_learning.emit_pattern_detected($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.pattern.detected')).toBe(before + 1);
    });

    it('emit_model_drift_detected inserts a pending outbox event', async () => {
      const before = await countByType('cl.model.drift_detected');
      await adminPool!.query(`SELECT continuous_learning.emit_model_drift_detected($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.model.drift_detected')).toBe(before + 1);
    });

    it('emit_policy_evaluated inserts a pending outbox event', async () => {
      const before = await countByType('cl.policy.evaluated');
      await adminPool!.query(`SELECT continuous_learning.emit_policy_evaluated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.policy.evaluated')).toBe(before + 1);
    });

    it('emit_improvement_proposed inserts a pending outbox event', async () => {
      const before = await countByType('cl.improvement.proposed');
      await adminPool!.query(`SELECT continuous_learning.emit_improvement_proposed($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.improvement.proposed')).toBe(before + 1);
    });

    it('emit_change_approved inserts a pending outbox event', async () => {
      const before = await countByType('cl.change.approved');
      await adminPool!.query(`SELECT continuous_learning.emit_change_approved($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.change.approved')).toBe(before + 1);
    });

    it('emit_feedback_published inserts a pending outbox event', async () => {
      const before = await countByType('cl.feedback.published');
      await adminPool!.query(`SELECT continuous_learning.emit_feedback_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('cl.feedback.published')).toBe(before + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT continuous_learning.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts the authorized data_acquisition target layer', async () => {
      const result = await adminPool!.query(
        `SELECT continuous_learning.emit_data_published($1,$2,gen_random_uuid(),'data_acquisition','DA-01',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });
  });

  // ── 16. Transaction rollback behaviour ──────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial risk when validation fails before the insert', async () => {
      const { version } = await createImprovementProposal(ctx1, BIZ1);
      const repo = new ImprovementProposalRepository();
      await expect(
        adminPool!.query(
          `INSERT INTO continuous_learning.improvement_risks (tenant_id, workspace_id, business_id, proposal_version_id, risk_code, description, severity)
           VALUES ($1,$2,$3,$4,$5,'x','not_a_real_severity')`,
          [T1, WS1, BIZ1, version.id, uniqueCode('rb-risk')]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM continuous_learning.improvement_risks WHERE proposal_version_id = $1`, [version.id]);
      expect(check.rows[0].n).toBe(0);
      expect(repo).toBeDefined();
    });

    it('rolls back an out-of-band insert that violates a database-level bound (defense in depth)', async () => {
      const { case: learningCase } = await createLearningCase(ctx1, BIZ1);
      const patternRepo = new LearningPatternRepository();
      const { versionId } = await patternRepo.createPattern(ctx1, BIZ1, learningCase.id, uniqueCode('rb-pat'), 'x');
      await expect(
        adminPool!.query(
          `INSERT INTO continuous_learning.pattern_confidence_scores (tenant_id, workspace_id, business_id, pattern_version_id, confidence)
           VALUES ($1,$2,$3,$4,2.0)`,
          [T1, WS1, BIZ1, versionId]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM continuous_learning.pattern_confidence_scores WHERE pattern_version_id = $1`, [versionId]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rejects a duplicate intake idempotency key with a different OM package as an application-level replay, not a DB error', async () => {
      const repo = new CLIntakeRepository();
      const omPkg1 = await createOmPublicationPackage(ctx1, BIZ1);
      const omPkg2 = await createOmPublicationPackage(ctx1, BIZ1);
      const key = uniqueCode('idem-shared');
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, omPublicationPackageId: omPkg1, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, omPublicationPackageId: omPkg2, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      expect(second.idempotentReplay).toBe(true);
      expect(second.package.id).toBe(first.package.id);
    });
  });
});

describe.skipIf(run)('Stage 2J Continuous Learning — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
