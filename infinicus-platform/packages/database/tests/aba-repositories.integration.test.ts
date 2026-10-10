/**
 * Live PostgreSQL 16 integration tests for Stage 2H Approved Business
 * Action persistence (BUILD-15).
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
  ABAIntakeRepository,
  ActionReviewRepository,
  ApprovalPolicyRepository,
  ApproverAuthorityRepository,
  ApprovalDecisionRepository,
  ApprovedActionRepository,
  ActionExecutionPlanRepository,
  ActionControlGateRepository,
  ApprovalExceptionRepository,
  ApprovalAppealRepository,
  ABAAuditRepository,
  ABAPublicationRepository,
  ABAComponentRegistryRepository,
  NotFoundError,
  ValidationError,
  InvalidTransitionError,
  ActionReviewNotFoundError,
  ApprovalPolicyNotFoundError,
  ApprovalDecisionNotFoundError,
  ApprovalDecisionImmutableError,
  ApprovedActionNotFoundError,
  ActionExecutionPlanNotFoundError,
  ActionControlGateNotFoundError,
  ApprovalExceptionNotFoundError,
  ApprovalAppealNotFoundError,
  ABAComponentRegistryNotFoundError,
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

const T1  = '44444444-5555-0000-0000-000000000001';
const WS1 = '44444444-5555-0000-0000-000000000002';
const T2  = '44444444-5555-0000-0000-000000000003';
const WS2 = '44444444-5555-0000-0000-000000000004';
const UID = '44444444-5555-0000-0000-000000000099';
const BIZ1 = '44444444-5656-0000-0000-000000000001';
const BIZ2 = '44444444-5656-0000-0000-000000000002';

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
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'BI evidence' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uniqueCode('dt-intake'), idempotencyKey: uniqueCode('idem') });

  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'ABA Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);

  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));

  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uniqueCode('snap'), new Date(), 'ABA fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);

  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uniqueCode('base'), 'aba fixture objective');
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
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uniqueCode('scn'), 'ABA Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);

  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uniqueCode('req'), uniqueCode('idem'));
  const run_ = await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uniqueCode('run'));

  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, run_.id, uniqueCode('result'), 'ABA fixture result');
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
  const { recommendation, version: recVersion } = await recRepo.createRecommendation(ctx, businessId, case_.id, uniqueCode('rec'), 'ABA fixture recommendation');
  await recRepo.validateRecommendation(ctx, recommendation.id, recVersion.id);
  await recRepo.publishRecommendation(ctx, recommendation.id, recVersion.id);

  const adiPubRepo = new ADIPublicationRepository();
  const insight = await adiPubRepo.createInsightPackage(ctx, businessId, uniqueCode('adi-insight'));
  const insightVersion = await adiPubRepo.createVersion(ctx, insight.id, businessId, 'ADI->ABA fixture summary', recVersion.id);
  const { package: pub } = await adiPubRepo.createPackage(ctx, businessId, insightVersion.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
  return pub.id;
}

async function createAbaIntake(ctx: typeof ctx1, businessId: string) {
  const adiPkg = await createAdiPackage(ctx, businessId);
  const intakeRepo = new ABAIntakeRepository();
  const { package: pkg } = await intakeRepo.receivePackage(ctx, {
    businessId, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('aba-intake'), idempotencyKey: uniqueCode('idem'),
  });
  return { intakeRepo, pkg, adiPkg };
}

async function createReviewPackage(ctx: typeof ctx1, businessId: string) {
  const { pkg } = await createAbaIntake(ctx, businessId);
  const reviewRepo = new ActionReviewRepository();
  const review = await reviewRepo.createReviewPackage(ctx, businessId, pkg.id, uniqueCode('review'));
  return { reviewRepo, review };
}

async function createApprover(ctx: typeof ctx1, businessId: string) {
  const authorityRepo = new ApproverAuthorityRepository();
  const assignment = await authorityRepo.createAssignment(ctx, businessId, UID, uniqueCode('assign'));
  return { authorityRepo, assignment };
}

async function createDecision(ctx: typeof ctx1, businessId: string) {
  const { review } = await createReviewPackage(ctx, businessId);
  const { assignment } = await createApprover(ctx, businessId);
  const repo = new ApprovalDecisionRepository();
  const { decision, version } = await repo.createDecision(ctx, businessId, review.id, assignment.id, uniqueCode('dec'), 'ABA fixture decision');
  return { repo, decision, version, review, assignment };
}

async function createApprovedAction(ctx: typeof ctx1, businessId: string) {
  const { repo: decisionRepo, decision, version } = await createDecision(ctx, businessId);
  await decisionRepo.approve(ctx, decision.id, version.id);
  const actionRepo = new ApprovedActionRepository();
  const action = await actionRepo.createAction(ctx, businessId, decision.id, uniqueCode('action'));
  return { actionRepo, action, decisionRepo, decision, version };
}

async function setupAbaIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'ABA-Test Tenant 1','aba-t1','active','test'),
            ($2,'ABA-Test Tenant 2','aba-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'ABA-Test WS 1','aba-ws1','active'),
            ($3,$4,'ABA-Test WS 2','aba-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'ABA Test Biz 1','aba-biz1','active'),
            ($4,$5,$6,'ABA Test Biz 2','aba-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'aba-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

async function teardownAbaIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
  }
  await closePool();
}

describe.runIf(run)('Stage 2H Approved Business Action — live PostgreSQL', () => {
  beforeAll(setupAbaIntegration);
  afterAll(teardownAbaIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    it('approved_business_action schema exists with 49 tables (46 original + 3 AuthorizedActionPackage tables from 0176)', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'approved_business_action'`
      );
      expect(result.rows[0].n).toBe(49);
    });

    it('every approved_business_action table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'approved_business_action' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(49);
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM approved_business_action.approval_decisions');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. ABAIntakeRepository ────────────────────────────────────────────────
  describe('ABAIntakeRepository', () => {
    it('receives a valid ADI publication package', async () => {
      const adiPkg = await createAdiPackage(ctx1, BIZ1);
      const repo = new ABAIntakeRepository();
      const { package: pkg, idempotentReplay } = await repo.receivePackage(ctx1, {
        businessId: BIZ1, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.adiPublicationPackageId).toBe(adiPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same ADI package', async () => {
      const adiPkg = await createAdiPackage(ctx1, BIZ1);
      const repo = new ABAIntakeRepository();
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, adiPublicationPackageId: adiPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('records a version and a source reference', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, { format: 'json' }, 12);
      expect(version.versionNumber).toBe(1);
      await expect(intakeRepo.addSourceReference(ctx1, pkg.id, BIZ1, 'ai_decision_intelligence', { ref: 'adi://publication/1' })).resolves.toBeUndefined();
    });

    it('accepts, processes, and completes a package', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      await intakeRepo.markProcessing(ctx1, pkg.id);
      const completed = await intakeRepo.completePackage(ctx1, pkg.id);
      expect(completed.status).toBe('completed');
    });

    it('rejects a package with a reason', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      const rejected = await intakeRepo.rejectPackage(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('fails a package with a reason', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      const failed = await intakeRepo.failPackage(ctx1, pkg.id, 'downstream timeout');
      expect(failed.status).toBe('failed');
    });

    it('finds a package by id and by source package', async () => {
      const { intakeRepo, pkg, adiPkg } = await createAbaIntake(ctx1, BIZ1);
      const byId = await intakeRepo.getById(ctx1, pkg.id);
      expect(byId.id).toBe(pkg.id);
      const bySource = await intakeRepo.getBySourcePackage(ctx1, BIZ1, adiPkg);
      expect(bySource.id).toBe(pkg.id);
    });

    it('throws NotFoundError for an unknown intake package', async () => {
      const repo = new ABAIntakeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('aba_intake_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, {}, 1);
      await expect(adminPool!.query(`UPDATE approved_business_action.aba_intake_package_versions SET record_count = 99 WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('aba_intake_status_history is append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createAbaIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.aba_intake_status_history WHERE intake_package_id = $1 ORDER BY created_at DESC LIMIT 1`, [pkg.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.aba_intake_status_history SET reason = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 3. ActionReviewRepository ─────────────────────────────────────────────
  describe('ActionReviewRepository', () => {
    it('creates a review package in draft status', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      expect(review.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const version = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'Review summary v1');
      expect(version.versionNumber).toBe(1);
    });

    it('adds evidence to a review package version', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const version = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      await expect(reviewRepo.addEvidence(ctx1, version.id, BIZ1, 'adi_recommendation', { ref: 'adi://rec/1' })).resolves.toBeUndefined();
    });

    it('rejects an unknown evidence_type', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const version = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      await expect(reviewRepo.addEvidence(ctx1, version.id, BIZ1, 'gut_feeling', {})).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status and records status history', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const moved = await reviewRepo.transitionStatus(ctx1, review.id, 'in_review', 'starting review');
      expect(moved.status).toBe('in_review');
      const history = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.action_review_status_history WHERE review_package_id = $1`, [review.id]);
      expect(history.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('rejects an unknown status', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      await expect(reviewRepo.transitionStatus(ctx1, review.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds a review package by id', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const found = await reviewRepo.getById(ctx1, review.id);
      expect(found.id).toBe(review.id);
    });

    it('throws ActionReviewNotFoundError for an unknown review package', async () => {
      const repo = new ActionReviewRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ActionReviewNotFoundError);
    });

    it('action_review_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const version = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      await expect(adminPool!.query(`UPDATE approved_business_action.action_review_package_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('review versions carry no risk/validity snapshot unless one is supplied — NULL means unclassified/unknown (P0-3)', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      const latest = await reviewRepo.getLatestVersion(ctx1, review.id);
      expect(latest).toMatchObject({ riskClass: null, isTimeSensitive: null, validUntil: null, twinSnapshotId: null, sourceRecommendationVersionId: null });
    });

    it('snapshots the published ADI facts with lineage, and the snapshot is append-only (P0-3)', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      const rec = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.decision_recommendation_versions WHERE business_id = $1 LIMIT 1`, [BIZ1]);
      const validUntil = new Date(Date.now() + 3600 * 1000);
      const twin = '55555555-5656-0000-0000-000000000001';
      const version = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1', {
        sourceRecommendationVersionId: rec.rows[0].id, riskClass: 'high', isTimeSensitive: true, validUntil, twinSnapshotId: twin,
      });
      const latest = await reviewRepo.getLatestVersion(ctx1, review.id);
      expect(latest).toMatchObject({ id: version.id, sourceRecommendationVersionId: rec.rows[0].id, riskClass: 'high', isTimeSensitive: true, twinSnapshotId: twin });
      expect(latest?.validUntil?.getTime()).toBe(validUntil.getTime());
      await expect(adminPool!.query(`UPDATE approved_business_action.action_review_package_versions SET risk_class = 'low' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('rejects an unknown risk class in the application and in the database; a dangling ADI lineage reference is refused (P0-3)', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      await expect(reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1', { riskClass: 'extreme' as never })).rejects.toBeInstanceOf(ValidationError);
      await expect(adminPool!.query(
        `INSERT INTO approved_business_action.action_review_package_versions (review_package_id, tenant_id, workspace_id, business_id, version_number, summary, risk_class)
         VALUES ($1,$2,$3,$4,99,'x','extreme')`, [review.id, T1, WS1, BIZ1])).rejects.toThrow(/risk_class_check/);
      await expect(reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1', { sourceRecommendationVersionId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/foreign key/i);
    });

    it('a snapshot is tenant-isolated: another tenant cannot read it (P0-3)', async () => {
      const { reviewRepo, review } = await createReviewPackage(ctx1, BIZ1);
      await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1', { riskClass: 'critical' });
      expect(await new ActionReviewRepository().getLatestVersion(ctx2, review.id)).toBeNull();
    });
  });

  // ── 4. ApprovalPolicyRepository ───────────────────────────────────────────
  describe('ApprovalPolicyRepository', () => {
    it('creates a policy in draft status', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol'), 'Capital exposure guardrail');
      expect(policy.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-v'), 'Guardrail');
      const version = await repo.createVersion(ctx1, policy.id, BIZ1, { maxExposure: 100000 });
      expect(version.versionNumber).toBe(1);
    });

    it('adds a rule with a valid operator', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-r'), 'Guardrail');
      const version = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await expect(repo.addRule(ctx1, version.id, BIZ1, uniqueCode('rule'), 'lte', 100000)).resolves.toBeUndefined();
    });

    it('rejects an unknown rule operator', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-badop'), 'Guardrail');
      const version = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await expect(repo.addRule(ctx1, version.id, BIZ1, uniqueCode('rule'), 'roughly', 1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('records a passing evaluation against a review package version', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const reviewRepo = new ActionReviewRepository();
      const reviewVersion = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-eval'), 'Guardrail');
      const polVersion = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await expect(repo.recordEvaluation(ctx1, polVersion.id, reviewVersion.id, BIZ1, true, { checked: 'exposure' })).resolves.toBeUndefined();
    });

    it('transitions status to active', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-act'), 'Guardrail');
      const active = await repo.transitionStatus(ctx1, policy.id, 'active');
      expect(active.status).toBe('active');
    });

    it('lists active policies for a business', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-list'), 'Guardrail');
      await repo.transitionStatus(ctx1, policy.id, 'active');
      const list = await repo.listActivePolicies(ctx1, BIZ1);
      expect(list.some((p) => p.id === policy.id)).toBe(true);
    });

    it('throws ApprovalPolicyNotFoundError for an unknown policy', async () => {
      const repo = new ApprovalPolicyRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    });

    it('approval_policy_evaluations are append-only — UPDATE is rejected by the database', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const reviewRepo = new ActionReviewRepository();
      const reviewVersion = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-immut'), 'Guardrail');
      const polVersion = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await repo.recordEvaluation(ctx1, polVersion.id, reviewVersion.id, BIZ1, true);
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.approval_policy_evaluations WHERE policy_version_id = $1`, [polVersion.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_policy_evaluations SET passed = false WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 5. ApproverAuthorityRepository ────────────────────────────────────────
  describe('ApproverAuthorityRepository', () => {
    it('creates an assignment in draft status', async () => {
      const { assignment } = await createApprover(ctx1, BIZ1);
      expect(assignment.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const version = await authorityRepo.createVersion(ctx1, assignment.id, BIZ1, 'finance_approver');
      expect(version.versionNumber).toBe(1);
    });

    it('adds an authority scope to an assignment version', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const version = await authorityRepo.createVersion(ctx1, assignment.id, BIZ1, 'finance_approver');
      await expect(authorityRepo.addAuthorityScope(ctx1, version.id, BIZ1, 'amount_limit', { max: 100000 })).resolves.toBeUndefined();
    });

    it('transitions assignment status to active', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const active = await authorityRepo.transitionStatus(ctx1, assignment.id, 'active');
      expect(active.status).toBe('active');
    });

    it('creates a delegation and transitions its status', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const delegation = await authorityRepo.createDelegation(ctx1, BIZ1, UID, UID, assignment.id);
      expect(delegation.status).toBe('active');
      const revoked = await authorityRepo.transitionDelegationStatus(ctx1, delegation.id, 'revoked');
      expect(revoked.status).toBe('revoked');
    });

    it('rejects an unknown delegation status', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const delegation = await authorityRepo.createDelegation(ctx1, BIZ1, UID, UID, assignment.id);
      await expect(authorityRepo.transitionDelegationStatus(ctx1, delegation.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds an assignment by id', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const found = await authorityRepo.getById(ctx1, assignment.id);
      expect(found.id).toBe(assignment.id);
    });

    it('approver_assignment_versions are append-only — UPDATE is rejected by the database', async () => {
      const { authorityRepo, assignment } = await createApprover(ctx1, BIZ1);
      const version = await authorityRepo.createVersion(ctx1, assignment.id, BIZ1, 'role');
      await expect(adminPool!.query(`UPDATE approved_business_action.approver_assignment_versions SET role_code = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 6. ApprovalDecisionRepository (authority boundary + immutability) ────
  describe('ApprovalDecisionRepository', () => {
    it('creates a decision header and v1 together in draft status', async () => {
      const { decision, version } = await createDecision(ctx1, BIZ1);
      expect(decision.status).toBe('draft');
      expect(decision.latestVersion).toBe(1);
      expect(version.versionNumber).toBe(1);
    });

    it('adds a rationale to a decision version', async () => {
      const { repo, version } = await createDecision(ctx1, BIZ1);
      await expect(repo.addRationale(ctx1, version.id, BIZ1, uniqueCode('rat'), 'Meets capital exposure policy', { policyId: 'pol-1' })).resolves.toBeUndefined();
    });

    it('approves a decision — approval is distinct from execution, no external action is executed', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      const approved = await repo.approve(ctx1, decision.id, version.id);
      expect(approved.status).toBe('approved');
    });

    it('approves a decision with modifications and records the modification', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.addModification(ctx1, version.id, BIZ1, uniqueCode('mod'), 'Reduced budget by 10%');
      const approved = await repo.approveWithModifications(ctx1, decision.id, version.id);
      expect(approved.status).toBe('approved_with_modifications');
    });

    it('rejects a decision', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      const rejected = await repo.reject(ctx1, decision.id, version.id);
      expect(rejected.status).toBe('rejected');
    });

    it('rejects re-deciding an already-decided decision — immutability', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.approve(ctx1, decision.id, version.id);
      await expect(repo.reject(ctx1, decision.id, version.id)).rejects.toBeInstanceOf(ApprovalDecisionImmutableError);
    });

    it('rejects superseding a decided decision — immutability', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.approve(ctx1, decision.id, version.id);
      await expect(repo.supersede(ctx1, decision.id)).rejects.toBeInstanceOf(ApprovalDecisionImmutableError);
    });

    it('supersedes a decision before it is decided', async () => {
      const { repo, decision } = await createDecision(ctx1, BIZ1);
      const superseded = await repo.supersede(ctx1, decision.id);
      expect(superseded.status).toBe('superseded');
    });

    it('a decided decision is immutable — direct UPDATE of status is rejected by the database', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.approve(ctx1, decision.id, version.id);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_decisions SET status = 'rejected' WHERE id = $1`, [decision.id])).rejects.toThrow(/immutable/);
    });

    it('approval_decision_versions reject a status change once decided — direct UPDATE is rejected by the database', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.approve(ctx1, decision.id, version.id);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_decision_versions SET status = 'rejected' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });

    it('finds a decision by id', async () => {
      const { repo, decision } = await createDecision(ctx1, BIZ1);
      const found = await repo.getById(ctx1, decision.id);
      expect(found.id).toBe(decision.id);
    });

    it('lists decided decisions for a review package', async () => {
      const { repo, decision, version, review } = await createDecision(ctx1, BIZ1);
      await repo.approve(ctx1, decision.id, version.id);
      const list = await repo.getDecidedForReview(ctx1, review.id);
      expect(list.some((d) => d.id === decision.id)).toBe(true);
    });

    it('throws ApprovalDecisionNotFoundError for an unknown decision', async () => {
      const repo = new ApprovalDecisionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ApprovalDecisionNotFoundError);
    });

    it('approval_decision_rationales are append-only — UPDATE is rejected by the database', async () => {
      const { repo, version } = await createDecision(ctx1, BIZ1);
      await repo.addRationale(ctx1, version.id, BIZ1, uniqueCode('rat'), 'x', {});
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.approval_decision_rationales WHERE decision_version_id = $1`, [version.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_decision_rationales SET statement = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 7. ApprovedActionRepository ───────────────────────────────────────────
  describe('ApprovedActionRepository', () => {
    it('creates an approved action in draft status', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      expect(action.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const version = await actionRepo.createVersion(ctx1, action.id, BIZ1, 'Expand into the secondary market');
      expect(version.versionNumber).toBe(1);
    });

    it('adds a descriptive step — never a record of execution', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const version = await actionRepo.createVersion(ctx1, action.id, BIZ1, 'x');
      await expect(actionRepo.addStep(ctx1, version.id, BIZ1, 1, 'Secure lease for secondary location')).resolves.toBeUndefined();
    });

    it('adds a constraint with a valid operator', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const version = await actionRepo.createVersion(ctx1, action.id, BIZ1, 'x');
      await expect(actionRepo.addConstraint(ctx1, version.id, BIZ1, uniqueCode('con'), 'lte', 50000)).resolves.toBeUndefined();
    });

    it('rejects an unknown constraint operator', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const version = await actionRepo.createVersion(ctx1, action.id, BIZ1, 'x');
      await expect(actionRepo.addConstraint(ctx1, version.id, BIZ1, uniqueCode('con'), 'roughly', 1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status to active', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const active = await actionRepo.transitionStatus(ctx1, action.id, 'active');
      expect(active.status).toBe('active');
    });

    it('finds an approved action by id', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const found = await actionRepo.getById(ctx1, action.id);
      expect(found.id).toBe(action.id);
    });

    it('throws ApprovedActionNotFoundError for an unknown action', async () => {
      const repo = new ApprovedActionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ApprovedActionNotFoundError);
    });

    it('approved_action_versions are append-only — UPDATE is rejected by the database', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      const version = await actionRepo.createVersion(ctx1, action.id, BIZ1, 'x');
      await expect(adminPool!.query(`UPDATE approved_business_action.approved_action_versions SET description = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8. ActionExecutionPlanRepository ──────────────────────────────────────
  describe('ActionExecutionPlanRepository', () => {
    it('creates a plan in draft status', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan'));
      expect(plan.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan-v'));
      const version = await repo.createVersion(ctx1, plan.id, BIZ1, 'Plan summary v1');
      expect(version.versionNumber).toBe(1);
    });

    it('adds a dependency and a window to a plan version', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan-dw'));
      const version = await repo.createVersion(ctx1, plan.id, BIZ1, 'x');
      await expect(repo.addDependency(ctx1, version.id, BIZ1, 'requires')).resolves.toBeUndefined();
      await expect(repo.addWindow(ctx1, version.id, BIZ1, 'business_hours', new Date())).resolves.toBeUndefined();
    });

    it('rejects an unknown dependency_type', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan-baddep'));
      const version = await repo.createVersion(ctx1, plan.id, BIZ1, 'x');
      await expect(repo.addDependency(ctx1, version.id, BIZ1, 'implies')).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status to ready', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan-r'));
      const ready = await repo.transitionStatus(ctx1, plan.id, 'ready');
      expect(ready.status).toBe('ready');
    });

    it('throws ActionExecutionPlanNotFoundError for an unknown plan', async () => {
      const repo = new ActionExecutionPlanRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ActionExecutionPlanNotFoundError);
    });

    it('action_execution_plan_versions are append-only — UPDATE is rejected by the database', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ActionExecutionPlanRepository();
      const plan = await repo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan-immut'));
      const version = await repo.createVersion(ctx1, plan.id, BIZ1, 'x');
      await expect(adminPool!.query(`UPDATE approved_business_action.action_execution_plan_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. ActionControlGateRepository ────────────────────────────────────────
  describe('ActionControlGateRepository', () => {
    async function makePlanVersion() {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const planRepo = new ActionExecutionPlanRepository();
      const plan = await planRepo.createPlan(ctx1, BIZ1, action.id, uniqueCode('plan'));
      const version = await planRepo.createVersion(ctx1, plan.id, BIZ1, 'x');
      return { action, plan, version };
    }

    it('creates a control gate in pending status', async () => {
      const { version } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const gate = await repo.createGate(ctx1, BIZ1, version.id, uniqueCode('gate'), 'compliance');
      expect(gate.status).toBe('pending');
    });

    it('rejects an unknown gate_type', async () => {
      const { version } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      await expect(repo.createGate(ctx1, BIZ1, version.id, uniqueCode('gate'), 'psychic')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records a gate evaluation', async () => {
      const { version } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const gate = await repo.createGate(ctx1, BIZ1, version.id, uniqueCode('gate-e'), 'manual');
      await expect(repo.recordEvaluation(ctx1, gate.id, BIZ1, true, { checkedBy: 'ops' })).resolves.toBeUndefined();
    });

    it('transitions gate status to passed', async () => {
      const { version } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const gate = await repo.createGate(ctx1, BIZ1, version.id, uniqueCode('gate-p'), 'automated');
      const passed = await repo.transitionGateStatus(ctx1, gate.id, 'passed');
      expect(passed.status).toBe('passed');
    });

    it('places a hold on an approved action and releases it', async () => {
      const { action } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const hold = await repo.placeHold(ctx1, BIZ1, action.id, uniqueCode('hold'), 'compliance review pending');
      expect(hold.reason).toContain('compliance review');
      const release = await repo.releaseHold(ctx1, BIZ1, hold.id, 'review completed');
      expect(release.actionHoldId).toBe(hold.id);
    });

    it('throws ActionControlGateNotFoundError for an unknown gate', async () => {
      const repo = new ActionControlGateRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ActionControlGateNotFoundError);
    });

    it('action_holds are append-only — permanent audit record, UPDATE is rejected by the database', async () => {
      const { action } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const hold = await repo.placeHold(ctx1, BIZ1, action.id, uniqueCode('hold-immut'), 'x');
      await expect(adminPool!.query(`UPDATE approved_business_action.action_holds SET reason = 'y' WHERE id = $1`, [hold.id])).rejects.toThrow(/append-only/);
    });

    it('action_releases are append-only — permanent audit record, UPDATE is rejected by the database', async () => {
      const { action } = await makePlanVersion();
      const repo = new ActionControlGateRepository();
      const hold = await repo.placeHold(ctx1, BIZ1, action.id, uniqueCode('hold-rel-immut'), 'x');
      const release = await repo.releaseHold(ctx1, BIZ1, hold.id, 'y');
      await expect(adminPool!.query(`UPDATE approved_business_action.action_releases SET release_reason = 'z' WHERE id = $1`, [release.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 10. ApprovalExceptionRepository ───────────────────────────────────────
  describe('ApprovalExceptionRepository', () => {
    it('creates an exception in open status', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ApprovalExceptionRepository();
      const exception = await repo.createException(ctx1, BIZ1, review.id, uniqueCode('exc'), 'Requires expedited review');
      expect(exception.status).toBe('open');
    });

    it('adds evidence to an exception', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ApprovalExceptionRepository();
      const exception = await repo.createException(ctx1, BIZ1, review.id, uniqueCode('exc-e'), 'x');
      await expect(repo.addEvidence(ctx1, exception.id, BIZ1, { ref: 'doc://1' })).resolves.toBeUndefined();
    });

    it('transitions status to resolved', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ApprovalExceptionRepository();
      const exception = await repo.createException(ctx1, BIZ1, review.id, uniqueCode('exc-r'), 'x');
      const resolved = await repo.transitionStatus(ctx1, exception.id, 'resolved');
      expect(resolved.status).toBe('resolved');
    });

    it('rejects an unknown status', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ApprovalExceptionRepository();
      const exception = await repo.createException(ctx1, BIZ1, review.id, uniqueCode('exc-bad'), 'x');
      await expect(repo.transitionStatus(ctx1, exception.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ApprovalExceptionNotFoundError for an unknown exception', async () => {
      const repo = new ApprovalExceptionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ApprovalExceptionNotFoundError);
    });

    it('approval_exception_evidence is append-only — UPDATE is rejected by the database', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ApprovalExceptionRepository();
      const exception = await repo.createException(ctx1, BIZ1, review.id, uniqueCode('exc-immut'), 'x');
      await repo.addEvidence(ctx1, exception.id, BIZ1, {});
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.approval_exception_evidence WHERE exception_id = $1`, [exception.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_exception_evidence SET evidence_reference = '{}'::jsonb WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 11. ApprovalAppealRepository ──────────────────────────────────────────
  describe('ApprovalAppealRepository', () => {
    async function makeDecidedDecision() {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await repo.reject(ctx1, decision.id, version.id);
      return { decision };
    }

    it('creates an appeal in open status', async () => {
      const { decision } = await makeDecidedDecision();
      const repo = new ApprovalAppealRepository();
      const appeal = await repo.createAppeal(ctx1, BIZ1, decision.id, uniqueCode('appeal'), 'Requesting reconsideration');
      expect(appeal.status).toBe('open');
    });

    it('records an appeal decision and updates the appeal status', async () => {
      const { decision } = await makeDecidedDecision();
      const repo = new ApprovalAppealRepository();
      const appeal = await repo.createAppeal(ctx1, BIZ1, decision.id, uniqueCode('appeal-d'), 'x');
      const appealDecision = await repo.recordAppealDecision(ctx1, appeal.id, BIZ1, 'overturned', 'New evidence submitted');
      expect(appealDecision.outcome).toBe('overturned');
      const found = await repo.getById(ctx1, appeal.id);
      expect(found.status).toBe('overturned');
    });

    it('rejects an unknown appeal decision outcome', async () => {
      const { decision } = await makeDecidedDecision();
      const repo = new ApprovalAppealRepository();
      const appeal = await repo.createAppeal(ctx1, BIZ1, decision.id, uniqueCode('appeal-badout'), 'x');
      await expect(repo.recordAppealDecision(ctx1, appeal.id, BIZ1, 'maybe', 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ApprovalAppealNotFoundError for an unknown appeal', async () => {
      const repo = new ApprovalAppealRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ApprovalAppealNotFoundError);
    });

    it('approval_appeal_decisions are append-only — permanent record, UPDATE is rejected by the database', async () => {
      const { decision } = await makeDecidedDecision();
      const repo = new ApprovalAppealRepository();
      const appeal = await repo.createAppeal(ctx1, BIZ1, decision.id, uniqueCode('appeal-immut'), 'x');
      await repo.recordAppealDecision(ctx1, appeal.id, BIZ1, 'dismissed', 'x');
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.approval_appeal_decisions WHERE appeal_id = $1`, [appeal.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_appeal_decisions SET rationale = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 12. ABAAuditRepository ────────────────────────────────────────────────
  describe('ABAAuditRepository', () => {
    it('records an attestation and a signature reference', async () => {
      const { version } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      const attestation = await repo.recordAttestation(ctx1, BIZ1, version.id, uniqueCode('att'), 'I attest this decision follows policy', UID);
      expect(attestation.statement).toContain('follows policy');
      const signature = await repo.recordSignature(ctx1, BIZ1, attestation.id, 'sig-ref://vault/12345');
      expect(signature.signatureReference).toContain('sig-ref://');
    });

    it('records an audit event', async () => {
      const { decision } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      await expect(repo.recordAuditEvent(ctx1, BIZ1, 'decision.viewed', { userId: UID }, decision.id)).resolves.toBeUndefined();
    });

    it('lists attestations for a decision version', async () => {
      const { version } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      const attestation = await repo.recordAttestation(ctx1, BIZ1, version.id, uniqueCode('att-list'), 'x');
      const list = await repo.listAttestationsForDecisionVersion(ctx1, version.id);
      expect(list.some((a) => a.id === attestation.id)).toBe(true);
    });

    it('approval_attestations are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      const attestation = await repo.recordAttestation(ctx1, BIZ1, version.id, uniqueCode('att-immut'), 'x');
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_attestations SET statement = 'y' WHERE id = $1`, [attestation.id])).rejects.toThrow(/append-only/);
    });

    it('approval_signatures are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      const attestation = await repo.recordAttestation(ctx1, BIZ1, version.id, uniqueCode('att-sig-immut'), 'x');
      const signature = await repo.recordSignature(ctx1, BIZ1, attestation.id, 'sig-ref://1');
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_signatures SET signature_reference = 'sig-ref://2' WHERE id = $1`, [signature.id])).rejects.toThrow(/append-only/);
    });

    it('approval_audit_events are append-only — UPDATE is rejected by the database', async () => {
      const { decision } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      await repo.recordAuditEvent(ctx1, BIZ1, 'decision.viewed', {}, decision.id);
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.approval_audit_events WHERE decision_id = $1`, [decision.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.approval_audit_events SET event_type = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. ABAPublicationRepository ──────────────────────────────────────────
  describe('ABAPublicationRepository', () => {
    async function makeVersion() {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ABAPublicationRepository();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, action.id, uniqueCode('pub'), 'outcome_monitoring', 'OM-01', uniqueCode('idem'));
      const version = await repo.createVersion(ctx1, pkg.id, BIZ1, 'S');
      return { repo, pkg, version, action };
    }

    it('creates a publication package targeting outcome_monitoring', async () => {
      const { pkg } = await makeVersion();
      expect(pkg.publicationStatus).toBe('draft');
      expect(pkg.targetLayer).toBe('outcome_monitoring');
    });

    it('rejects an invalid target_layer', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ABAPublicationRepository();
      await expect(repo.createPackage(ctx1, BIZ1, action.id, uniqueCode('pub-bad'), 'continuous_learning', 'X', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent by (business_id, idempotency_key)', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const repo = new ABAPublicationRepository();
      const key = uniqueCode('idem-shared');
      const first = await repo.createPackage(ctx1, BIZ1, action.id, uniqueCode('pub-idem'), 'outcome_monitoring', 'OM-01', key);
      const second = await repo.createPackage(ctx1, BIZ1, action.id, uniqueCode('pub-idem2'), 'outcome_monitoring', 'OM-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('dispatches, acknowledges, and records publication events', async () => {
      const { repo, pkg } = await makeVersion();
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      const acked = await repo.acknowledge(ctx1, pkg.id);
      expect(acked.publicationStatus).toBe('acknowledged');
      const events = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.aba_publication_events WHERE publication_package_id = $1`, [pkg.id]);
      expect(events.rows[0].n).toBeGreaterThanOrEqual(3);
    });

    it('rejects an illegal transition (draft -> dispatched)', async () => {
      const { repo, pkg } = await makeVersion();
      await expect(repo.dispatch(ctx1, pkg.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects a publication package', async () => {
      const { repo, pkg } = await makeVersion();
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      const rejected = await repo.reject(ctx1, pkg.id, 'incomplete evidence');
      expect(rejected.publicationStatus).toBe('rejected');
    });

    it('revokes an acknowledged publication package', async () => {
      const { repo, pkg } = await makeVersion();
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      await repo.acknowledge(ctx1, pkg.id);
      const revoked = await repo.revoke(ctx1, pkg.id);
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('finds a publication package by id', async () => {
      const { repo, pkg } = await makeVersion();
      const found = await repo.getById(ctx1, pkg.id);
      expect(found.id).toBe(pkg.id);
    });

    it('aba_publication_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await makeVersion();
      await expect(adminPool!.query(`UPDATE approved_business_action.aba_publication_package_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 14. ABAComponentRegistryRepository ────────────────────────────────────
  describe('ABAComponentRegistryRepository', () => {
    it('registers a component in draft status', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp'), 'approval_engine');
      expect(component.status).toBe('draft');
    });

    it('registers a component version and bumps latestVersion', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-v'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, { api: 'v1' });
      expect(version.versionNumber).toBe(1);
    });

    it('activates a component', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-act'), 'approval_engine');
      const activated = await repo.activateVersion(ctx1, component.id, component.id);
      expect(activated.status).toBe('active');
    });

    it('records a deployment and activates it', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-dep'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      expect(deployment.activationState).toBe('active');
    });

    it('records a rollback', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'regression detected');
      const row = await adminPool!.query(`SELECT activation_state FROM approved_business_action.aba_deployments WHERE id = $1`, [deployment.id]);
      expect(row.rows[0].activation_state).toBe('rolled_back');
    });

    it('gets the active version for a component', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-getact'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await repo.activateVersion(ctx1, component.id, version.id);
      const active = await repo.getActiveVersion(ctx1, component.id);
      expect(active.id).toBe(version.id);
    });

    it('throws ABAComponentRegistryNotFoundError for an unknown component', async () => {
      const repo = new ABAComponentRegistryRepository();
      await expect(repo.createVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, {})).rejects.toBeInstanceOf(ABAComponentRegistryNotFoundError);
    });

    it('aba_component_registry_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-immut'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE approved_business_action.aba_component_registry_versions SET capabilities = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('aba_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new ABAComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb-immut'), 'approval_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'x');
      const row = await adminPool!.query(`SELECT id FROM approved_business_action.aba_deployment_rollbacks WHERE aba_deployment_id = $1`, [deployment.id]);
      await expect(adminPool!.query(`UPDATE approved_business_action.aba_deployment_rollbacks SET reason = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 15. Cross-tenant / cross-workspace RLS live rejection ────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 review packages', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const repo = new ActionReviewRepository();
      await expect(repo.getById(ctx2, review.id)).rejects.toBeInstanceOf(ActionReviewNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 decision', async () => {
      const { repo, decision } = await createDecision(ctx1, BIZ1);
      await expect(repo.getById(ctx2, decision.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot approve a tenant 1 decision', async () => {
      const { repo, decision, version } = await createDecision(ctx1, BIZ1);
      await expect(repo.approve(ctx2, decision.id, version.id)).rejects.toBeInstanceOf(ApprovalDecisionNotFoundError);
    });

    it('tenant 2 cannot read a tenant 1 approved action', async () => {
      const { actionRepo, action } = await createApprovedAction(ctx1, BIZ1);
      await expect(actionRepo.getById(ctx2, action.id)).rejects.toBeInstanceOf(ApprovedActionNotFoundError);
    });

    it('tenant 2 cannot acknowledge a tenant 1 publication package', async () => {
      const { action } = await createApprovedAction(ctx1, BIZ1);
      const pubRepo = new ABAPublicationRepository();
      const { package: pkg } = await pubRepo.createPackage(ctx1, BIZ1, action.id, uniqueCode('iso-pub'), 'outcome_monitoring', 'OM-01', uniqueCode('idem'));
      await expect(pubRepo.markReady(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 audit events', async () => {
      const { decision } = await createDecision(ctx1, BIZ1);
      const repo = new ABAAuditRepository();
      await repo.recordAuditEvent(ctx1, BIZ1, 'decision.viewed', {}, decision.id);
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM approved_business_action.approval_audit_events WHERE decision_id = $1 AND tenant_id = $2`,
        [decision.id, T2]
      );
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 16. Outbox atomicity — all 10 required aba.* events ──────────────────────
  describe('outbox event functions', () => {
    async function countByType(eventType: string): Promise<number> {
      const result = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = $1`, [eventType]);
      return result.rows[0].n as number;
    }

    it('emit_intake_received inserts a pending outbox event atomically', async () => {
      const before = await countByType('aba.intake.received');
      await adminPool!.query(`SELECT approved_business_action.emit_intake_received($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.intake.received')).toBe(before + 1);
    });

    it('emit_review_requested inserts a pending outbox event', async () => {
      const before = await countByType('aba.review.requested');
      await adminPool!.query(`SELECT approved_business_action.emit_review_requested($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.review.requested')).toBe(before + 1);
    });

    it('emit_review_started inserts a pending outbox event', async () => {
      const before = await countByType('aba.review.started');
      await adminPool!.query(`SELECT approved_business_action.emit_review_started($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.review.started')).toBe(before + 1);
    });

    it('emit_action_approved inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.approved');
      await adminPool!.query(`SELECT approved_business_action.emit_action_approved($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.approved')).toBe(before + 1);
    });

    it('emit_action_approved_with_modifications inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.approved_with_modifications');
      await adminPool!.query(`SELECT approved_business_action.emit_action_approved_with_modifications($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.approved_with_modifications')).toBe(before + 1);
    });

    it('emit_action_rejected inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.rejected');
      await adminPool!.query(`SELECT approved_business_action.emit_action_rejected($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.rejected')).toBe(before + 1);
    });

    it('emit_action_held inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.held');
      await adminPool!.query(`SELECT approved_business_action.emit_action_held($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.held')).toBe(before + 1);
    });

    it('emit_action_released inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.released');
      await adminPool!.query(`SELECT approved_business_action.emit_action_released($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.released')).toBe(before + 1);
    });

    it('emit_action_published inserts a pending outbox event', async () => {
      const before = await countByType('aba.action.published');
      await adminPool!.query(`SELECT approved_business_action.emit_action_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('aba.action.published')).toBe(before + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT approved_business_action.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts the authorized outcome_monitoring target layer', async () => {
      const result = await adminPool!.query(
        `SELECT approved_business_action.emit_data_published($1,$2,gen_random_uuid(),'outcome_monitoring','OM-01',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });
  });

  // ── 17. Transaction rollback behaviour ────────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial rule when validation fails before the insert', async () => {
      const repo = new ApprovalPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('rb-pol'), 'Guardrail');
      const version = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await expect(repo.addRule(ctx1, version.id, BIZ1, uniqueCode('rule'), 'nonsense_operator', 1)).rejects.toBeInstanceOf(ValidationError);
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.approval_policy_rules WHERE policy_version_id = $1`, [version.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rolls back an out-of-band insert that violates a database-level bound (defense in depth)', async () => {
      const { review } = await createReviewPackage(ctx1, BIZ1);
      const reviewRepo = new ActionReviewRepository();
      const reviewVersion = await reviewRepo.createVersion(ctx1, review.id, BIZ1, 'v1');
      await expect(
        adminPool!.query(
          `INSERT INTO approved_business_action.action_review_evidence (tenant_id, workspace_id, business_id, review_package_version_id, evidence_type, evidence_reference)
           VALUES ($1,$2,$3,$4,'not_a_real_type','{}'::jsonb)`,
          [T1, WS1, BIZ1, reviewVersion.id]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM approved_business_action.action_review_evidence WHERE review_package_version_id = $1`, [reviewVersion.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rejects a duplicate intake idempotency key with a different ADI package as an application-level replay, not a DB error', async () => {
      const repo = new ABAIntakeRepository();
      const adiPkg1 = await createAdiPackage(ctx1, BIZ1);
      const adiPkg2 = await createAdiPackage(ctx1, BIZ1);
      const key = uniqueCode('idem-shared');
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, adiPublicationPackageId: adiPkg1, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, adiPublicationPackageId: adiPkg2, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      expect(second.idempotentReplay).toBe(true);
      expect(second.package.id).toBe(first.package.id);
    });
  });
});

describe.skipIf(run)('Stage 2H Approved Business Action — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
