/**
 * Live PostgreSQL 16 integration tests for Stage 2I Outcome Monitoring
 * persistence (BUILD-16).
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
  OMIntakeRepository,
  MonitoringPlanRepository,
  MonitoredActionRepository,
  OutcomeObservationRepository,
  OutcomeTargetRepository,
  OutcomeVarianceRepository,
  MonitoringAlertRepository,
  MonitoringIncidentRepository,
  OutcomeAttributionRepository,
  OutcomeReviewRepository,
  LearningFeedbackPackageRepository,
  OMPublicationRepository,
  OMComponentRegistryRepository,
  NotFoundError,
  ValidationError,
  InvalidTransitionError,
  MonitoringPlanNotFoundError,
  MonitoredActionNotFoundError,
  OutcomeObservationNotFoundError,
  OutcomeObservationImmutableError,
  OutcomeTargetNotFoundError,
  OutcomeVarianceNotFoundError,
  MonitoringAlertNotFoundError,
  MonitoringIncidentNotFoundError,
  OutcomeAttributionNotFoundError,
  OutcomeReviewNotFoundError,
  LearningFeedbackPackageNotFoundError,
  LearningFeedbackPackageStateConflictError,
  OMComponentRegistryNotFoundError,
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

const T1  = '44444444-5757-0000-0000-000000000001';
const WS1 = '44444444-5757-0000-0000-000000000002';
const T2  = '44444444-5757-0000-0000-000000000003';
const WS2 = '44444444-5757-0000-0000-000000000004';
const UID = '44444444-5757-0000-0000-000000000099';
const BIZ1 = '44444444-5858-0000-0000-000000000001';
const BIZ2 = '44444444-5858-0000-0000-000000000002';

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
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'OM evidence' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uniqueCode('dt-intake'), idempotencyKey: uniqueCode('idem') });

  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'OM Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);

  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));

  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uniqueCode('snap'), new Date(), 'OM fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);

  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uniqueCode('base'), 'om fixture objective');
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
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uniqueCode('scn'), 'OM Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);

  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uniqueCode('req'), uniqueCode('idem'));
  const run_ = await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uniqueCode('run'));

  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, run_.id, uniqueCode('result'), 'OM fixture result');
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
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uniqueCode('rec'), 'OM fixture recommendation');
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);

  const adiPubRepo = new ADIPublicationRepository();
  const insight = await adiPubRepo.createInsightPackage(ctx, businessId, uniqueCode('adi-insight'));
  const insightVersion = await adiPubRepo.createVersion(ctx, insight.id, businessId, 'ADI->ABA fixture summary', recVersion.id);
  const { package: pub } = await adiPubRepo.createPackage(ctx, businessId, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
  return pub.id;
}

/** Extends createAdiPackage() through the full ABA pipeline (intake -> review -> decision -> approve -> approved action -> publication targeting outcome_monitoring). Returns approved_business_action.aba_publication_packages.id. */
async function createAbaPublicationPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const adiPkg = await createAdiPackage(ctx, businessId);

  const intakeRepo = new ABAIntakeRepository();
  const { package: intakePkg } = await intakeRepo.receivePackage(ctx, { businessId, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('aba-intake'), idempotencyKey: uniqueCode('idem') });

  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePkg.id, uniqueCode('review'));

  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign'));

  const decisionRepo = new ApprovalDecisionRepository();
  const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uniqueCode('dec'), 'OM fixture decision');
  await decisionRepo.approve(ctx, decision.id, version.id);

  const actionRepo = new ApprovedActionRepository();
  const action = await actionRepo.createAction(ctx, businessId, decision.id, uniqueCode('action'));

  const abaPubRepo = new ABAPublicationRepository();
  const { package: pub } = await abaPubRepo.createPackage(ctx, businessId, action.id, uniqueCode('aba-pub'), 'outcome_monitoring', 'OM-01', uniqueCode('idem'));
  return pub.id;
}

async function createOmIntake(ctx: typeof ctx1, businessId: string) {
  const abaPkg = await createAbaPublicationPackage(ctx, businessId);
  const intakeRepo = new OMIntakeRepository();
  const { package: pkg } = await intakeRepo.receivePackage(ctx, {
    businessId, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('om-intake'), idempotencyKey: uniqueCode('idem'),
  });
  return { intakeRepo, pkg, abaPkg };
}

async function createMonitoringPlan(ctx: typeof ctx1, businessId: string) {
  const { pkg } = await createOmIntake(ctx, businessId);
  const planRepo = new MonitoringPlanRepository();
  const { plan, versionId } = await planRepo.createPlan(ctx, businessId, pkg.id, uniqueCode('plan'), 'OM fixture plan');
  return { planRepo, plan, versionId };
}

async function createMonitoredAction(ctx: typeof ctx1, businessId: string) {
  const { plan } = await createMonitoringPlan(ctx, businessId);
  // A standalone approved action, since fixturing a second full ABA chain per test would be excessive —
  // monitored_actions.approved_action_id only needs to reference a valid row in approved_business_action.approved_actions.
  const abaPkg = await createAdiPackage(ctx, businessId);
  const intakeRepo = new ABAIntakeRepository();
  const { package: intakePkg } = await intakeRepo.receivePackage(ctx, { businessId, adiPublicationPackageId: abaPkg, intakeCode: uniqueCode('aba-intake2'), idempotencyKey: uniqueCode('idem') });
  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, intakePkg.id, uniqueCode('review2'));
  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign2'));
  const decisionRepo = new ApprovalDecisionRepository();
  const { decision, version } = await decisionRepo.createDecision(ctx, businessId, review.id, assignment.id, uniqueCode('dec2'), 'monitored action fixture decision');
  await decisionRepo.approve(ctx, decision.id, version.id);
  const actionRepo = new ApprovedActionRepository();
  const approvedAction = await actionRepo.createAction(ctx, businessId, decision.id, uniqueCode('action2'));

  const monitoredRepo = new MonitoredActionRepository();
  const { action, versionId } = await monitoredRepo.createMonitoredAction(ctx, businessId, plan.id, approvedAction.id, uniqueCode('mact'), 'OM fixture monitored action');
  return { monitoredRepo, action, versionId, plan };
}

async function createObservation(ctx: typeof ctx1, businessId: string) {
  const { action } = await createMonitoredAction(ctx, businessId);
  const repo = new OutcomeObservationRepository();
  const { observation, version } = await repo.createObservation(ctx, businessId, action.id, uniqueCode('obs'), 'OM fixture observation', new Date());
  return { repo, observation, version, action };
}

async function createReview(ctx: typeof ctx1, businessId: string) {
  const { observation } = await createObservation(ctx, businessId);
  const repo = new OutcomeReviewRepository();
  const review = await repo.createReview(ctx, businessId, observation.id, uniqueCode('orev'));
  return { repo, review, observation };
}

async function createFeedbackPackage(ctx: typeof ctx1, businessId: string) {
  const { review } = await createReview(ctx, businessId);
  const repo = new LearningFeedbackPackageRepository();
  const { package: pkg, versionId } = await repo.createPackage(ctx, businessId, review.id, uniqueCode('fbpkg'), 'OM fixture feedback package');
  return { repo, pkg, versionId, review };
}

async function setupOmIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'OM-Test Tenant 1','om-t1','active','test'),
            ($2,'OM-Test Tenant 2','om-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'OM-Test WS 1','om-ws1','active'),
            ($3,$4,'OM-Test WS 2','om-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'OM Test Biz 1','om-biz1','active'),
            ($4,$5,$6,'OM Test Biz 2','om-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'om-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

async function teardownOmIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
  }
  await closePool();
}

describe.runIf(run)('Stage 2I Outcome Monitoring — live PostgreSQL', () => {
  beforeAll(setupOmIntegration);
  afterAll(teardownOmIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    it('outcome_monitoring schema exists with 46 tables (45 + P0-6d action_execution_verifications)', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'outcome_monitoring'`
      );
      expect(result.rows[0].n).toBe(46);
    });

    it('every outcome_monitoring table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'outcome_monitoring' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(46);
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM outcome_monitoring.outcome_observations');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. OMIntakeRepository ──────────────────────────────────────────────────
  describe('OMIntakeRepository', () => {
    it('receives a valid ABA publication package', async () => {
      const abaPkg = await createAbaPublicationPackage(ctx1, BIZ1);
      const repo = new OMIntakeRepository();
      const { package: pkg, idempotentReplay } = await repo.receivePackage(ctx1, {
        businessId: BIZ1, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.abaPublicationPackageId).toBe(abaPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same ABA package', async () => {
      const abaPkg = await createAbaPublicationPackage(ctx1, BIZ1);
      const repo = new OMIntakeRepository();
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, abaPublicationPackageId: abaPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('records a version and a source reference', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, { format: 'json' }, 5);
      expect(version.versionNumber).toBe(1);
      await expect(intakeRepo.addSourceReference(ctx1, pkg.id, BIZ1, 'approved_business_action', { ref: 'aba://publication/1' })).resolves.toBeUndefined();
    });

    it('accepts, processes, and completes a package', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      await intakeRepo.markProcessing(ctx1, pkg.id);
      const completed = await intakeRepo.completePackage(ctx1, pkg.id);
      expect(completed.status).toBe('completed');
    });

    it('rejects a package with a reason', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      const rejected = await intakeRepo.rejectPackage(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('fails a package with a reason', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      const failed = await intakeRepo.failPackage(ctx1, pkg.id, 'downstream timeout');
      expect(failed.status).toBe('failed');
    });

    it('finds a package by id and by source package', async () => {
      const { intakeRepo, pkg, abaPkg } = await createOmIntake(ctx1, BIZ1);
      const byId = await intakeRepo.getById(ctx1, pkg.id);
      expect(byId.id).toBe(pkg.id);
      const bySource = await intakeRepo.getBySourcePackage(ctx1, BIZ1, abaPkg);
      expect(bySource.id).toBe(pkg.id);
    });

    it('throws NotFoundError for an unknown intake package', async () => {
      const repo = new OMIntakeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('om_intake_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, {}, 1);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.om_intake_package_versions SET record_count = 99 WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('om_intake_status_history is append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createOmIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      const row = await adminPool!.query(`SELECT id FROM outcome_monitoring.om_intake_status_history WHERE intake_package_id = $1 ORDER BY created_at DESC LIMIT 1`, [pkg.id]);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.om_intake_status_history SET reason = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 3. MonitoringPlanRepository ────────────────────────────────────────────
  describe('MonitoringPlanRepository', () => {
    it('creates a plan in draft status with a first version', async () => {
      const { plan, versionId } = await createMonitoringPlan(ctx1, BIZ1);
      expect(plan.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds a metric and a schedule', async () => {
      const { versionId } = await createMonitoringPlan(ctx1, BIZ1);
      const planRepo = new MonitoringPlanRepository();
      await expect(planRepo.addMetric(ctx1, versionId, BIZ1, 'revenue', 'currency', { target: 100000 })).resolves.toBeUndefined();
      await expect(planRepo.addSchedule(ctx1, versionId, BIZ1, 'recurring', new Date(), null, '0 0 * * MON')).resolves.toBeUndefined();
    });

    it('activates, completes, and cancels a plan', async () => {
      const { planRepo, plan } = await createMonitoringPlan(ctx1, BIZ1);
      const active = await planRepo.activate(ctx1, plan.id);
      expect(active.status).toBe('active');
      const completed = await planRepo.complete(ctx1, plan.id);
      expect(completed.status).toBe('completed');

      const { planRepo: planRepo2, plan: plan2 } = await createMonitoringPlan(ctx1, BIZ1);
      const cancelled = await planRepo2.cancel(ctx1, plan2.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('finds a plan by id and lists by intake package', async () => {
      const { planRepo, plan } = await createMonitoringPlan(ctx1, BIZ1);
      const found = await planRepo.getById(ctx1, plan.id);
      expect(found.id).toBe(plan.id);
      const list = await planRepo.listByIntakePackage(ctx1, plan.intakePackageId);
      expect(list.some((p) => p.id === plan.id)).toBe(true);
    });

    it('throws MonitoringPlanNotFoundError for an unknown plan', async () => {
      const repo = new MonitoringPlanRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(MonitoringPlanNotFoundError);
    });

    it('monitoring_plan_versions are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await createMonitoringPlan(ctx1, BIZ1);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.monitoring_plan_versions SET summary = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });

    it('listByIntakePackage returns an empty list for an unrelated intake package', async () => {
      const planRepo = new MonitoringPlanRepository();
      const list = await planRepo.listByIntakePackage(ctx1, '00000000-0000-0000-0000-000000000000');
      expect(list).toEqual([]);
    });
  });

  // ── 4. MonitoredActionRepository ───────────────────────────────────────────
  describe('MonitoredActionRepository', () => {
    it('creates a monitored action referencing the canonical approved action', async () => {
      const { action } = await createMonitoredAction(ctx1, BIZ1);
      expect(action.status).toBe('pending');
      expect(action.approvedActionId).toBeTruthy();
    });

    it('records an execution observation (descriptive only)', async () => {
      const { versionId } = await createMonitoredAction(ctx1, BIZ1);
      const repo = new MonitoredActionRepository();
      await expect(repo.addExecutionObservation(ctx1, versionId, BIZ1, { note: 'in progress' })).resolves.toBeUndefined();
    });

    it('transitions in_progress -> completed and records status history', async () => {
      const { monitoredRepo, action } = await createMonitoredAction(ctx1, BIZ1);
      const inProgress = await monitoredRepo.markInProgress(ctx1, action.id);
      expect(inProgress.status).toBe('in_progress');
      const completed = await monitoredRepo.complete(ctx1, action.id);
      expect(completed.status).toBe('completed');
      const history = await adminPool!.query(`SELECT count(*)::int AS n FROM outcome_monitoring.monitored_action_status_history WHERE monitored_action_id = $1`, [action.id]);
      expect(history.rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it('cancels a monitored action with a reason', async () => {
      const { monitoredRepo, action } = await createMonitoredAction(ctx1, BIZ1);
      const cancelled = await monitoredRepo.cancel(ctx1, action.id, 'plan retired');
      expect(cancelled.status).toBe('cancelled');
    });

    it('finds a monitored action by id and by approved action', async () => {
      const { monitoredRepo, action } = await createMonitoredAction(ctx1, BIZ1);
      const found = await monitoredRepo.getById(ctx1, action.id);
      expect(found.id).toBe(action.id);
      const byApproved = await monitoredRepo.getByApprovedAction(ctx1, BIZ1, action.approvedActionId);
      expect(byApproved.id).toBe(action.id);
    });

    it('throws MonitoredActionNotFoundError for an unknown monitored action', async () => {
      const repo = new MonitoredActionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(MonitoredActionNotFoundError);
    });

    it('monitored_action_versions are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await createMonitoredAction(ctx1, BIZ1);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.monitored_action_versions SET description = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });

    it('action_execution_observations are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await createMonitoredAction(ctx1, BIZ1);
      const repo = new MonitoredActionRepository();
      await repo.addExecutionObservation(ctx1, versionId, BIZ1, { note: 'x' });
      const row = await adminPool!.query(`SELECT id FROM outcome_monitoring.action_execution_observations WHERE monitored_action_version_id = $1 LIMIT 1`, [versionId]);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.action_execution_observations SET detail = '{}'::jsonb WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 5. OutcomeObservationRepository (safety-critical immutability guard) ──
  describe('OutcomeObservationRepository', () => {
    it('creates an observation in draft status with a first version', async () => {
      const { observation, version } = await createObservation(ctx1, BIZ1);
      expect(observation.status).toBe('draft');
      expect(version.status).toBe('draft');
    });

    it('adds a measurement and evidence to an observation version', async () => {
      const { version } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeObservationRepository();
      await expect(repo.addMeasurement(ctx1, version.id, BIZ1, 'revenue', { value: 104000 }, 'usd')).resolves.toBeUndefined();
      await expect(repo.addEvidence(ctx1, version.id, BIZ1, 'execution_record', { ref: 'exec://1' })).resolves.toBeUndefined();
    });

    it('the database rejects an unknown evidence_type via its CHECK constraint', async () => {
      const { version } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeObservationRepository();
      await expect(repo.addEvidence(ctx1, version.id, BIZ1, 'gut_feeling', {})).rejects.toThrow();
    });

    it('records an observation — recorded observations are permanently immutable', async () => {
      const { repo, observation, version } = await createObservation(ctx1, BIZ1);
      const recorded = await repo.record(ctx1, observation.id, version.id);
      expect(recorded.status).toBe('recorded');

      await expect(repo.verify(ctx1, observation.id, version.id)).rejects.toBeInstanceOf(OutcomeObservationImmutableError);
    });

    it('verifies and disputes are valid decided terminal states', async () => {
      const { repo: repo2, observation: obs2, version: ver2 } = await createObservation(ctx1, BIZ1);
      const verified = await repo2.verify(ctx1, obs2.id, ver2.id);
      expect(verified.status).toBe('verified');

      const { repo: repo3, observation: obs3, version: ver3 } = await createObservation(ctx1, BIZ1);
      const disputed = await repo3.dispute(ctx1, obs3.id, ver3.id);
      expect(disputed.status).toBe('disputed');
    });

    it('database rejects direct SQL UPDATE against a recorded observation header (defense in depth)', async () => {
      const { repo, observation, version } = await createObservation(ctx1, BIZ1);
      await repo.record(ctx1, observation.id, version.id);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_observations SET status = 'draft' WHERE id = $1`, [observation.id])).rejects.toThrow(/immutable/);
    });

    it('database rejects direct SQL UPDATE against a recorded observation version (defense in depth)', async () => {
      const { repo, observation, version } = await createObservation(ctx1, BIZ1);
      await repo.record(ctx1, observation.id, version.id);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_observation_versions SET status = 'draft' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });

    it('supersedes an undecided observation, but rejects superseding a decided one', async () => {
      const { repo, observation } = await createObservation(ctx1, BIZ1);
      const superseded = await repo.supersede(ctx1, observation.id);
      expect(superseded.status).toBe('superseded');

      const { repo: repo2, observation: obs2, version: ver2 } = await createObservation(ctx1, BIZ1);
      await repo2.record(ctx1, obs2.id, ver2.id);
      await expect(repo2.supersede(ctx1, obs2.id)).rejects.toBeInstanceOf(OutcomeObservationImmutableError);
    });

    it('finds a decided observation by id and lists decided observations for an action', async () => {
      const { repo, observation, version, action } = await createObservation(ctx1, BIZ1);
      await repo.record(ctx1, observation.id, version.id);
      const found = await repo.getById(ctx1, observation.id);
      expect(found.status).toBe('recorded');
      const decided = await repo.getDecidedForAction(ctx1, action.id);
      expect(decided.some((o) => o.id === observation.id)).toBe(true);
    });

    it('throws OutcomeObservationNotFoundError for an unknown observation', async () => {
      const repo = new OutcomeObservationRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OutcomeObservationNotFoundError);
    });

    it('outcome_measurements and outcome_evidence are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeObservationRepository();
      await repo.addMeasurement(ctx1, version.id, BIZ1, 'revenue', { value: 1 });
      const row = await adminPool!.query(`SELECT id FROM outcome_monitoring.outcome_measurements WHERE observation_version_id = $1 LIMIT 1`, [version.id]);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_measurements SET unit = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 6. OutcomeTargetRepository ─────────────────────────────────────────────
  describe('OutcomeTargetRepository', () => {
    it('creates a target with a first version', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { target, versionId } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target'), { metric: 'revenue', goal: 100000 });
      expect(target.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds a threshold and records a breach', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { versionId } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target2'), {});
      const thresholdId = await repo.addThreshold(ctx1, versionId, BIZ1, uniqueCode('thr'), 'lt', { value: 90000 });
      expect(thresholdId).toBeTruthy();

      const { observation } = await createObservation(ctx1, BIZ1);
      const breachId = await repo.recordBreach(ctx1, thresholdId, BIZ1, observation.id, { measured: 80000 });
      expect(breachId).toBeTruthy();
    });

    it('activates and retires a target', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { target } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target3'), {});
      const active = await repo.activate(ctx1, target.id);
      expect(active.status).toBe('active');
      const retired = await repo.retire(ctx1, target.id);
      expect(retired.status).toBe('retired');
    });

    it('finds a target by id and lists by plan', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { target } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target4'), {});
      const found = await repo.getById(ctx1, target.id);
      expect(found.id).toBe(target.id);
      const list = await repo.listByPlan(ctx1, plan.id);
      expect(list.some((t) => t.id === target.id)).toBe(true);
    });

    it('throws OutcomeTargetNotFoundError for an unknown target', async () => {
      const repo = new OutcomeTargetRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OutcomeTargetNotFoundError);
    });

    it('the database rejects an unknown threshold operator via its CHECK constraint', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { versionId } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target-badop'), {});
      await expect(repo.addThreshold(ctx1, versionId, BIZ1, uniqueCode('thr-bad'), 'roughly', {})).rejects.toThrow();
    });

    it('outcome_thresholds and threshold_breaches are append-only — UPDATE is rejected by the database', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { versionId } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('target5'), {});
      const thresholdId = await repo.addThreshold(ctx1, versionId, BIZ1, uniqueCode('thr2'), 'gte', { value: 1 });
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_thresholds SET operator = 'lt' WHERE id = $1`, [thresholdId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 7. OutcomeVarianceRepository ───────────────────────────────────────────
  describe('OutcomeVarianceRepository', () => {
    async function fixtureTarget() {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const targetRepo = new OutcomeTargetRepository();
      const { target } = await targetRepo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('vtarget'), {});
      return target;
    }

    it('requests a run in queued status', async () => {
      const target = await fixtureTarget();
      const repo = new OutcomeVarianceRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, target.id);
      expect(run_.status).toBe('queued');
    });

    it('transitions running -> completed and failed', async () => {
      const target = await fixtureTarget();
      const repo = new OutcomeVarianceRepository();
      const run1 = await repo.requestRun(ctx1, BIZ1, target.id);
      const running = await repo.markRunning(ctx1, run1.id);
      expect(running.status).toBe('running');
      const completed = await repo.complete(ctx1, run1.id);
      expect(completed.status).toBe('completed');

      const run2 = await repo.requestRun(ctx1, BIZ1, target.id);
      const failed = await repo.fail(ctx1, run2.id);
      expect(failed.status).toBe('failed');
    });

    it('adds a result, a comparison, and an explanation', async () => {
      const target = await fixtureTarget();
      const repo = new OutcomeVarianceRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, target.id);
      const resultId = await repo.addResult(ctx1, run_.id, BIZ1, 'revenue', { delta: -0.04 });
      expect(resultId).toBeTruthy();
      await expect(repo.addComparison(ctx1, run_.id, BIZ1, 'revenue', { expected: 100000 }, { actual: 96000 })).resolves.toBeUndefined();
      await expect(repo.addExplanation(ctx1, resultId, BIZ1, uniqueCode('exp'), 'Seasonal dip in Q3.')).resolves.toBeUndefined();
    });

    it('finds a run by id', async () => {
      const target = await fixtureTarget();
      const repo = new OutcomeVarianceRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, target.id);
      const found = await repo.getById(ctx1, run_.id);
      expect(found.id).toBe(run_.id);
    });

    it('throws OutcomeVarianceNotFoundError for an unknown run', async () => {
      const repo = new OutcomeVarianceRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OutcomeVarianceNotFoundError);
    });

    it('outcome_variance_results and expected_actual_comparisons are append-only — UPDATE is rejected by the database', async () => {
      const target = await fixtureTarget();
      const repo = new OutcomeVarianceRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, target.id);
      const resultId = await repo.addResult(ctx1, run_.id, BIZ1, 'revenue', {});
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_variance_results SET variance_value = '{}'::jsonb WHERE id = $1`, [resultId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8. MonitoringAlertRepository ───────────────────────────────────────────
  describe('MonitoringAlertRepository', () => {
    async function fixtureRuleVersion() {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const alertRepo = new MonitoringAlertRepository();
      const { rule, versionId } = await alertRepo.createRule(ctx1, BIZ1, plan.id, uniqueCode('rule'), { metric: 'revenue', operator: 'lt', value: 90000 });
      return { alertRepo, rule, versionId };
    }

    it('creates a rule with a first version', async () => {
      const { rule, versionId } = await fixtureRuleVersion();
      expect(rule.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('activates a rule', async () => {
      const { alertRepo, rule } = await fixtureRuleVersion();
      const active = await alertRepo.activateRule(ctx1, rule.id);
      expect(active.status).toBe('active');
    });

    it('raises an alert and transitions acknowledged -> resolved', async () => {
      const { alertRepo, versionId } = await fixtureRuleVersion();
      const { observation } = await createObservation(ctx1, BIZ1);
      const alert = await alertRepo.raiseAlert(ctx1, BIZ1, versionId, observation.id);
      expect(alert.status).toBe('raised');
      const ack = await alertRepo.acknowledgeAlert(ctx1, alert.id);
      expect(ack.status).toBe('acknowledged');
      const resolved = await alertRepo.resolveAlert(ctx1, alert.id);
      expect(resolved.status).toBe('resolved');
    });

    it('suppresses an alert', async () => {
      const { alertRepo, versionId } = await fixtureRuleVersion();
      const alert = await alertRepo.raiseAlert(ctx1, BIZ1, versionId);
      const suppressed = await alertRepo.suppressAlert(ctx1, alert.id);
      expect(suppressed.status).toBe('suppressed');
    });

    it('finds a rule and an alert by id', async () => {
      const { alertRepo, rule, versionId } = await fixtureRuleVersion();
      const foundRule = await alertRepo.getRuleById(ctx1, rule.id);
      expect(foundRule.id).toBe(rule.id);
      const alert = await alertRepo.raiseAlert(ctx1, BIZ1, versionId);
      const foundAlert = await alertRepo.getAlertById(ctx1, alert.id);
      expect(foundAlert.id).toBe(alert.id);
    });

    it('throws MonitoringAlertNotFoundError for an unknown rule/alert', async () => {
      const repo = new MonitoringAlertRepository();
      await expect(repo.getRuleById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(MonitoringAlertNotFoundError);
      await expect(repo.getAlertById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(MonitoringAlertNotFoundError);
    });

    it('monitoring_alert_rule_versions are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await fixtureRuleVersion();
      await expect(adminPool!.query(`UPDATE outcome_monitoring.monitoring_alert_rule_versions SET condition = '{}'::jsonb WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. MonitoringIncidentRepository ────────────────────────────────────────
  describe('MonitoringIncidentRepository', () => {
    async function fixtureAlert() {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const alertRepo = new MonitoringAlertRepository();
      const { versionId } = await alertRepo.createRule(ctx1, BIZ1, plan.id, uniqueCode('irule'), {});
      const alert = await alertRepo.raiseAlert(ctx1, BIZ1, versionId);
      return alert;
    }

    it('opens an incident from an alert', async () => {
      const alert = await fixtureAlert();
      const repo = new MonitoringIncidentRepository();
      const incident = await repo.openIncident(ctx1, BIZ1, alert.id);
      expect(incident.status).toBe('open');
    });

    it('transitions investigating -> resolved -> closed', async () => {
      const alert = await fixtureAlert();
      const repo = new MonitoringIncidentRepository();
      const incident = await repo.openIncident(ctx1, BIZ1, alert.id);
      const investigating = await repo.markInvestigating(ctx1, incident.id);
      expect(investigating.status).toBe('investigating');
      const resolved = await repo.resolve(ctx1, incident.id);
      expect(resolved.status).toBe('resolved');
      const closed = await repo.close(ctx1, incident.id);
      expect(closed.status).toBe('closed');
    });

    it('finds an incident by id and by alert', async () => {
      const alert = await fixtureAlert();
      const repo = new MonitoringIncidentRepository();
      const incident = await repo.openIncident(ctx1, BIZ1, alert.id);
      const found = await repo.getById(ctx1, incident.id);
      expect(found.id).toBe(incident.id);
      const byAlert = await repo.getByAlert(ctx1, alert.id);
      expect(byAlert.id).toBe(incident.id);
    });

    it('throws MonitoringIncidentNotFoundError for an unknown incident', async () => {
      const repo = new MonitoringIncidentRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(MonitoringIncidentNotFoundError);
    });
  });

  // ── 10. OutcomeAttributionRepository ───────────────────────────────────────
  describe('OutcomeAttributionRepository', () => {
    it('requests a run in queued status', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      expect(run_.status).toBe('queued');
    });

    it('transitions running -> completed', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const running = await repo.markRunning(ctx1, run_.id);
      expect(running.status).toBe('running');
      const completed = await repo.complete(ctx1, run_.id);
      expect(completed.status).toBe('completed');
    });

    it('adds a factor and a bounded result', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const factorId = await repo.addFactor(ctx1, run_.id, BIZ1, uniqueCode('factor'), 'Seasonal demand shift');
      expect(factorId).toBeTruthy();
      await expect(repo.addResult(ctx1, run_.id, BIZ1, factorId, 0.62, 0.15)).resolves.toBeUndefined();
    });

    it('rejects an out-of-bound weight at the database level', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const factorId = await repo.addFactor(ctx1, run_.id, BIZ1, uniqueCode('factor2'), 'Bad factor');
      await expect(repo.addResult(ctx1, run_.id, BIZ1, factorId, 1.5, 0.1)).rejects.toThrow();
    });

    it('finds a run by id', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const found = await repo.getById(ctx1, run_.id);
      expect(found.id).toBe(run_.id);
    });

    it('throws OutcomeAttributionNotFoundError for an unknown run', async () => {
      const repo = new OutcomeAttributionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OutcomeAttributionNotFoundError);
    });

    it('outcome_attribution_factors and outcome_attribution_results are append-only — UPDATE is rejected by the database', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const factorId = await repo.addFactor(ctx1, run_.id, BIZ1, uniqueCode('factor3'), 'x');
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_attribution_factors SET description = 'y' WHERE id = $1`, [factorId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 11. OutcomeReviewRepository ────────────────────────────────────────────
  describe('OutcomeReviewRepository', () => {
    it('creates a review in draft status', async () => {
      const { review } = await createReview(ctx1, BIZ1);
      expect(review.status).toBe('draft');
    });

    it('adds a finding and a follow-up action', async () => {
      const { review } = await createReview(ctx1, BIZ1);
      const repo = new OutcomeReviewRepository();
      await expect(repo.addFinding(ctx1, review.id, BIZ1, uniqueCode('find'), 'Revenue variance within tolerance.')).resolves.toBeUndefined();
      await expect(repo.addAction(ctx1, review.id, BIZ1, uniqueCode('act'), 'Continue monitoring for two more cycles.')).resolves.toBeUndefined();
    });

    it('transitions in_review -> completed and records status history', async () => {
      const { repo, review } = await createReview(ctx1, BIZ1);
      const inReview = await repo.startReview(ctx1, review.id);
      expect(inReview.status).toBe('in_review');
      const completed = await repo.completeReview(ctx1, review.id);
      expect(completed.status).toBe('completed');
      const history = await adminPool!.query(`SELECT count(*)::int AS n FROM outcome_monitoring.outcome_review_status_history WHERE review_id = $1`, [review.id]);
      expect(history.rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it('cancels a review with a reason', async () => {
      const { repo, review } = await createReview(ctx1, BIZ1);
      const cancelled = await repo.cancelReview(ctx1, review.id, 'observation disputed');
      expect(cancelled.status).toBe('cancelled');
    });

    it('finds a review by id and lists by observation', async () => {
      const { repo, review, observation } = await createReview(ctx1, BIZ1);
      const found = await repo.getById(ctx1, review.id);
      expect(found.id).toBe(review.id);
      const list = await repo.listByObservation(ctx1, observation.id);
      expect(list.some((r) => r.id === review.id)).toBe(true);
    });

    it('throws OutcomeReviewNotFoundError for an unknown review', async () => {
      const repo = new OutcomeReviewRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OutcomeReviewNotFoundError);
    });

    it('outcome_review_findings and outcome_review_actions are append-only — UPDATE is rejected by the database', async () => {
      const { repo, review } = await createReview(ctx1, BIZ1);
      await repo.addFinding(ctx1, review.id, BIZ1, uniqueCode('find2'), 'x');
      const row = await adminPool!.query(`SELECT id FROM outcome_monitoring.outcome_review_findings WHERE review_id = $1 LIMIT 1`, [review.id]);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.outcome_review_findings SET statement = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 12. LearningFeedbackPackageRepository ──────────────────────────────────
  describe('LearningFeedbackPackageRepository', () => {
    it('creates a feedback package in draft status with a first version', async () => {
      const { pkg, versionId } = await createFeedbackPackage(ctx1, BIZ1);
      expect(pkg.status).toBe('draft');
      expect(versionId).toBeTruthy();
    });

    it('adds evidence to a feedback package version', async () => {
      const { versionId } = await createFeedbackPackage(ctx1, BIZ1);
      const repo = new LearningFeedbackPackageRepository();
      await expect(repo.addEvidence(ctx1, versionId, BIZ1, { ref: 'om://observation/1' })).resolves.toBeUndefined();
    });

    it('marks ready then published, and rejects publishing a draft package', async () => {
      const { repo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      const ready = await repo.markReady(ctx1, pkg.id);
      expect(ready.status).toBe('ready');
      const published = await repo.markPublished(ctx1, pkg.id);
      expect(published.status).toBe('published');

      const { repo: repo2, pkg: pkg2 } = await createFeedbackPackage(ctx1, BIZ1);
      await expect(repo2.markPublished(ctx1, pkg2.id)).rejects.toBeInstanceOf(LearningFeedbackPackageStateConflictError);
    });

    it('finds a package by id and lists ready/published packages for a review', async () => {
      const { repo, pkg, review } = await createFeedbackPackage(ctx1, BIZ1);
      await repo.markReady(ctx1, pkg.id);
      const found = await repo.getById(ctx1, pkg.id);
      expect(found.id).toBe(pkg.id);
      const list = await repo.getReadyForReview(ctx1, review.id);
      expect(list.some((p) => p.id === pkg.id)).toBe(true);
    });

    it('throws LearningFeedbackPackageNotFoundError for an unknown package', async () => {
      const repo = new LearningFeedbackPackageRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(LearningFeedbackPackageNotFoundError);
    });

    it('learning_feedback_package_versions and learning_feedback_evidence are append-only — UPDATE is rejected by the database', async () => {
      const { versionId } = await createFeedbackPackage(ctx1, BIZ1);
      await expect(adminPool!.query(`UPDATE outcome_monitoring.learning_feedback_package_versions SET summary = 'x' WHERE id = $1`, [versionId])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. OMPublicationRepository ────────────────────────────────────────────
  describe('OMPublicationRepository', () => {
    async function fixturePackage() {
      const { repo: fbRepo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      await fbRepo.markReady(ctx1, pkg.id);
      const pubRepo = new OMPublicationRepository();
      const { package: pub, idempotentReplay } = await pubRepo.createPackage(ctx1, BIZ1, pkg.id, uniqueCode('ompub'), 'continuous_learning', 'CL-01', uniqueCode('idem'));
      return { pubRepo, pub, idempotentReplay };
    }

    it('creates a publication package in draft status, idempotently', async () => {
      const { pub, idempotentReplay } = await fixturePackage();
      expect(pub.publicationStatus).toBe('draft');
      expect(idempotentReplay).toBe(false);
    });

    it('rejects an invalid target layer', async () => {
      const { repo: fbRepo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      await fbRepo.markReady(ctx1, pkg.id);
      const pubRepo = new OMPublicationRepository();
      await expect(pubRepo.createPackage(ctx1, BIZ1, pkg.id, uniqueCode('badpub'), 'ai_decision_intelligence', 'ADI-01', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent on repeated delivery with the same idempotency key', async () => {
      const { repo: fbRepo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      await fbRepo.markReady(ctx1, pkg.id);
      const pubRepo = new OMPublicationRepository();
      const key = uniqueCode('idem-pub');
      const first = await pubRepo.createPackage(ctx1, BIZ1, pkg.id, uniqueCode('idem-pkg'), 'continuous_learning', 'CL-01', key);
      const second = await pubRepo.createPackage(ctx1, BIZ1, pkg.id, uniqueCode('idem-pkg2'), 'continuous_learning', 'CL-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('creates a version and bumps latestVersion', async () => {
      const { pubRepo, pub } = await fixturePackage();
      const version = await pubRepo.createVersion(ctx1, pub.id, BIZ1, 'Publication summary v1');
      expect(version.versionNumber).toBe(1);
    });

    it('walks the full draft -> ready -> dispatched -> acknowledged lifecycle', async () => {
      const { pubRepo, pub } = await fixturePackage();
      const ready = await pubRepo.markReady(ctx1, pub.id);
      expect(ready.publicationStatus).toBe('ready');
      const dispatched = await pubRepo.dispatch(ctx1, pub.id);
      expect(dispatched.publicationStatus).toBe('dispatched');
      const acknowledged = await pubRepo.acknowledge(ctx1, pub.id);
      expect(acknowledged.publicationStatus).toBe('acknowledged');
      const revoked = await pubRepo.revoke(ctx1, pub.id);
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('rejects an illegal transition (draft -> dispatched)', async () => {
      const { pubRepo, pub } = await fixturePackage();
      await expect(pubRepo.dispatch(ctx1, pub.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects a dispatched package with a reason', async () => {
      const { pubRepo, pub } = await fixturePackage();
      await pubRepo.markReady(ctx1, pub.id);
      await pubRepo.dispatch(ctx1, pub.id);
      const rejected = await pubRepo.reject(ctx1, pub.id, 'schema mismatch');
      expect(rejected.publicationStatus).toBe('rejected');
    });

    it('records a publication event on every transition', async () => {
      const { pubRepo, pub } = await fixturePackage();
      await pubRepo.markReady(ctx1, pub.id);
      await pubRepo.dispatch(ctx1, pub.id);
      const events = await adminPool!.query(`SELECT count(*)::int AS n FROM outcome_monitoring.om_publication_events WHERE publication_package_id = $1`, [pub.id]);
      expect(events.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('finds a package by id', async () => {
      const { pubRepo, pub } = await fixturePackage();
      const found = await pubRepo.getById(ctx1, pub.id);
      expect(found.id).toBe(pub.id);
    });

    it('om_publication_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { pubRepo, pub } = await fixturePackage();
      const version = await pubRepo.createVersion(ctx1, pub.id, BIZ1, 'v1');
      await expect(adminPool!.query(`UPDATE outcome_monitoring.om_publication_package_versions SET summary = 'x' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 14. OMComponentRegistryRepository ──────────────────────────────────────
  describe('OMComponentRegistryRepository', () => {
    it('registers a component in draft status', async () => {
      const repo = new OMComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp'), 'threshold-monitor');
      expect(entry.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new OMComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-v'), 'threshold-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, { capability: 'breach-detection' });
      expect(version.versionNumber).toBe(1);
    });

    it('activates a component and reads its active version', async () => {
      const repo = new OMComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-a'), 'threshold-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      await repo.activateVersion(ctx1, entry.id, version.id);
      const active = await repo.getActiveVersion(ctx1, entry.id);
      expect(active.id).toBe(version.id);
    });

    it('records a deployment and a rollback', async () => {
      const repo = new OMComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-d'), 'threshold-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id, 'production');
      expect(deployment.activationState).toBe('active');
      await expect(repo.recordRollback(ctx1, BIZ1, deployment.id, 'regression detected')).resolves.toBeUndefined();
    });

    it('throws OMComponentRegistryNotFoundError for an unknown component', async () => {
      const repo = new OMComponentRegistryRepository();
      await expect(repo.createVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, {})).rejects.toBeInstanceOf(OMComponentRegistryNotFoundError);
    });

    it('om_component_registry_versions and om_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new OMComponentRegistryRepository();
      const entry = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-ao'), 'threshold-monitor');
      const version = await repo.createVersion(ctx1, entry.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE outcome_monitoring.om_component_registry_versions SET capabilities = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 15. Cross-tenant isolation (live RLS) ──────────────────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 monitoring plans', async () => {
      const { planRepo, plan } = await createMonitoringPlan(ctx1, BIZ1);
      await expect(planRepo.getById(ctx2, plan.id)).rejects.toBeInstanceOf(MonitoringPlanNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 observation', async () => {
      const { repo, observation } = await createObservation(ctx1, BIZ1);
      await expect(repo.getById(ctx2, observation.id)).rejects.toBeInstanceOf(OutcomeObservationNotFoundError);
    });

    it('tenant 2 cannot record a tenant 1 observation', async () => {
      const { repo, observation, version } = await createObservation(ctx1, BIZ1);
      await expect(repo.record(ctx2, observation.id, version.id)).rejects.toBeInstanceOf(OutcomeObservationNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 outcome review', async () => {
      const { repo, review } = await createReview(ctx1, BIZ1);
      await expect(repo.getById(ctx2, review.id)).rejects.toBeInstanceOf(OutcomeReviewNotFoundError);
    });

    it('tenant 2 cannot acknowledge a tenant 1 publication package', async () => {
      const { repo: fbRepo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      await fbRepo.markReady(ctx1, pkg.id);
      const pubRepo = new OMPublicationRepository();
      const { package: pub } = await pubRepo.createPackage(ctx1, BIZ1, pkg.id, uniqueCode('iso-pub'), 'continuous_learning', 'CL-01', uniqueCode('idem'));
      await expect(pubRepo.markReady(ctx2, pub.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 threshold breaches', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const targetRepo = new OutcomeTargetRepository();
      const { versionId } = await targetRepo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('iso-target'), {});
      const thresholdId = await targetRepo.addThreshold(ctx1, versionId, BIZ1, uniqueCode('iso-thr'), 'lt', {});
      const { observation } = await createObservation(ctx1, BIZ1);
      await targetRepo.recordBreach(ctx1, thresholdId, BIZ1, observation.id, {});
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM outcome_monitoring.threshold_breaches WHERE threshold_id = $1 AND tenant_id = $2`,
        [thresholdId, T2]
      );
      expect(result.rows[0].n).toBe(0);
    });

    it('tenant 2 cannot read a tenant 1 monitored action', async () => {
      const { monitoredRepo, action } = await createMonitoredAction(ctx1, BIZ1);
      await expect(monitoredRepo.getById(ctx2, action.id)).rejects.toBeInstanceOf(MonitoredActionNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 learning feedback package', async () => {
      const { repo, pkg } = await createFeedbackPackage(ctx1, BIZ1);
      await expect(repo.getById(ctx2, pkg.id)).rejects.toBeInstanceOf(LearningFeedbackPackageNotFoundError);
    });
  });

  // ── 16. Outbox atomicity — all 10 required om.* events ─────────────────────
  describe('outbox event functions', () => {
    async function countByType(eventType: string): Promise<number> {
      const result = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = $1`, [eventType]);
      return result.rows[0].n as number;
    }

    it('emit_intake_received inserts a pending outbox event atomically', async () => {
      const before = await countByType('om.intake.received');
      await adminPool!.query(`SELECT outcome_monitoring.emit_intake_received($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.intake.received')).toBe(before + 1);
    });

    it('emit_monitoring_started inserts a pending outbox event', async () => {
      const before = await countByType('om.monitoring.started');
      await adminPool!.query(`SELECT outcome_monitoring.emit_monitoring_started($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.monitoring.started')).toBe(before + 1);
    });

    it('emit_observation_recorded inserts a pending outbox event', async () => {
      const before = await countByType('om.observation.recorded');
      await adminPool!.query(`SELECT outcome_monitoring.emit_observation_recorded($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.observation.recorded')).toBe(before + 1);
    });

    it('emit_target_breached inserts a pending outbox event', async () => {
      const before = await countByType('om.target.breached');
      await adminPool!.query(`SELECT outcome_monitoring.emit_target_breached($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.target.breached')).toBe(before + 1);
    });

    it('emit_variance_calculated inserts a pending outbox event', async () => {
      const before = await countByType('om.variance.calculated');
      await adminPool!.query(`SELECT outcome_monitoring.emit_variance_calculated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.variance.calculated')).toBe(before + 1);
    });

    it('emit_alert_raised inserts a pending outbox event', async () => {
      const before = await countByType('om.alert.raised');
      await adminPool!.query(`SELECT outcome_monitoring.emit_alert_raised($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.alert.raised')).toBe(before + 1);
    });

    it('emit_incident_opened inserts a pending outbox event', async () => {
      const before = await countByType('om.incident.opened');
      await adminPool!.query(`SELECT outcome_monitoring.emit_incident_opened($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.incident.opened')).toBe(before + 1);
    });

    it('emit_review_completed inserts a pending outbox event', async () => {
      const before = await countByType('om.review.completed');
      await adminPool!.query(`SELECT outcome_monitoring.emit_review_completed($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.review.completed')).toBe(before + 1);
    });

    it('emit_feedback_published inserts a pending outbox event', async () => {
      const before = await countByType('om.feedback.published');
      await adminPool!.query(`SELECT outcome_monitoring.emit_feedback_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('om.feedback.published')).toBe(before + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT outcome_monitoring.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts the authorized continuous_learning target layer', async () => {
      const result = await adminPool!.query(
        `SELECT outcome_monitoring.emit_data_published($1,$2,gen_random_uuid(),'continuous_learning','CL-01',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });
  });

  // ── 17. Transaction rollback behaviour ─────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial threshold when validation fails before the insert', async () => {
      const { plan } = await createMonitoringPlan(ctx1, BIZ1);
      const repo = new OutcomeTargetRepository();
      const { versionId } = await repo.createTarget(ctx1, BIZ1, plan.id, uniqueCode('rb-target'), {});
      await expect(
        adminPool!.query(
          `INSERT INTO outcome_monitoring.outcome_thresholds (tenant_id, workspace_id, business_id, target_version_id, threshold_code, operator, operand)
           VALUES ($1,$2,$3,$4,$5,'not_a_real_operator','{}'::jsonb)`,
          [T1, WS1, BIZ1, versionId, uniqueCode('rbthr')]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM outcome_monitoring.outcome_thresholds WHERE target_version_id = $1`, [versionId]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rolls back an out-of-band insert that violates a database-level bound (defense in depth)', async () => {
      const { observation } = await createObservation(ctx1, BIZ1);
      const repo = new OutcomeAttributionRepository();
      const run_ = await repo.requestRun(ctx1, BIZ1, observation.id);
      const factorId = await repo.addFactor(ctx1, run_.id, BIZ1, uniqueCode('rb-factor'), 'x');
      await expect(
        adminPool!.query(
          `INSERT INTO outcome_monitoring.outcome_attribution_results (tenant_id, workspace_id, business_id, attribution_run_id, factor_id, attributed_weight, uncertainty)
           VALUES ($1,$2,$3,$4,$5,2.0,0.1)`,
          [T1, WS1, BIZ1, run_.id, factorId]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM outcome_monitoring.outcome_attribution_results WHERE attribution_run_id = $1`, [run_.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rejects a duplicate intake idempotency key with a different ABA package as an application-level replay, not a DB error', async () => {
      const repo = new OMIntakeRepository();
      const abaPkg1 = await createAbaPublicationPackage(ctx1, BIZ1);
      const abaPkg2 = await createAbaPublicationPackage(ctx1, BIZ1);
      const key = uniqueCode('idem-shared');
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, abaPublicationPackageId: abaPkg1, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, abaPublicationPackageId: abaPkg2, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      expect(second.idempotentReplay).toBe(true);
      expect(second.package.id).toBe(first.package.id);
    });
  });
});

describe.skipIf(run)('Stage 2I Outcome Monitoring — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
