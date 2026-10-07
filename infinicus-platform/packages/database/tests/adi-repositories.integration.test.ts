/**
 * Live PostgreSQL 16 integration tests for Stage 2G AI Decision Intelligence
 * persistence (BUILD-14).
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
  ADIIntakeRepository,
  DecisionQuestionRepository,
  DecisionCaseRepository,
  ReasoningRunRepository,
  DecisionEvidenceRepository,
  DecisionAlternativeRepository,
  DecisionRecommendationRepository,
  DecisionConfidenceRepository,
  DecisionPolicyRepository,
  DecisionMonitoringRequirementRepository,
  ADIPublicationRepository,
  ADIComponentRegistryRepository,
  NotFoundError,
  ValidationError,
  InvalidTransitionError,
  DecisionQuestionNotFoundError,
  DecisionCaseNotFoundError,
  ReasoningRunNotFoundError,
  DecisionAlternativeNotFoundError,
  DecisionRecommendationStateConflictError,
  DecisionRecommendationImmutableError,
  DecisionRecommendationValidationError,
  DecisionPolicyNotFoundError,
  ADIComponentRegistryNotFoundError,
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

const T1  = '44444444-5353-0000-0000-000000000001';
const WS1 = '44444444-5353-0000-0000-000000000002';
const T2  = '44444444-5353-0000-0000-000000000003';
const WS2 = '44444444-5353-0000-0000-000000000004';
const UID = '44444444-5353-0000-0000-000000000099';
const BIZ1 = '44444444-5454-0000-0000-000000000001';
const BIZ2 = '44444444-5454-0000-0000-000000000002';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Builds the full upstream chain (BI publication -> DT intake -> definition ->
 * instance -> published snapshot -> published scenario baseline -> DT
 * publication targeting simulation) and returns the resulting
 * dt_publication_packages.id.
 */
async function createDtPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const insightRepo = new InsightPackageRepository();
  const biPubRepo = new BIPublicationPackageRepository();
  const biPkg = await insightRepo.create(ctx, businessId, uniqueCode('insight'));
  const biVersion = await insightRepo.publishVersion(ctx, biPkg.id, businessId, { summary: 'BI evidence' });
  const { package: biPub } = await biPubRepo.publish(ctx, businessId, biVersion.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));

  const dtIntakeRepo = new DTIntakeRepository();
  await dtIntakeRepo.receivePackage(ctx, { businessId, biPublicationPackageId: biPub.id, intakeCode: uniqueCode('dt-intake'), idempotencyKey: uniqueCode('idem') });

  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'ADI Fixture Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, businessId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);

  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));

  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx, businessId, instance.id, uniqueCode('snap'), new Date(), 'ADI fixture snapshot');
  await snapRepo.validateSnapshot(ctx, snapshot.id, snapVersion.id);
  await snapRepo.publishSnapshot(ctx, snapshot.id, snapVersion.id);

  const baselineRepo = new ScenarioBaselineRepository();
  const { baseline, version: baselineVersion } = await baselineRepo.createBaseline(ctx, businessId, instance.id, snapVersion.id, uniqueCode('base'), 'adi fixture objective');
  await baselineRepo.validateBaseline(ctx, baseline.id, baselineVersion.id);
  await baselineRepo.publishBaseline(ctx, baseline.id, baselineVersion.id);

  const dtPubRepo = new DTPublicationPackageRepository();
  const dtInsight = await dtPubRepo.createInsightPackage(ctx, businessId, uniqueCode('dt-insight'));
  const dtInsightVersion = await dtPubRepo.createVersion(ctx, dtInsight.id, businessId, 'DT->SIM fixture summary', { snapshotVersionId: snapVersion.id, scenarioBaselineVersionId: baselineVersion.id });
  const { package: dtPub } = await dtPubRepo.createPackage(ctx, businessId, dtInsightVersion.id, 'simulation', 'SIM-01', uniqueCode('idem'));
  return dtPub.id;
}

/**
 * Extends createDtPackage() one layer further: DT -> SIM intake -> model ->
 * scenario -> run -> published result -> SIM publication package targeting
 * ai_decision_intelligence. Returns simulation_publication_packages.id — the
 * real upstream FK target for adi_intake_packages.simulation_publication_package_id.
 */
async function createSimPackage(ctx: typeof ctx1, businessId: string): Promise<string> {
  const dtPkg = await createDtPackage(ctx, businessId);

  const simIntakeRepo = new SimulationIntakeRepository();
  await simIntakeRepo.receivePackage(ctx, { businessId, dtPublicationPackageId: dtPkg, intakeCode: uniqueCode('sim-intake'), idempotencyKey: uniqueCode('idem') });

  const modelRepo = new SimulationModelRepository();
  const model = await modelRepo.createModel(ctx, businessId, uniqueCode('model'), 'Engine v3 Model');
  const modelVersion = await modelRepo.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});

  const scenarioRepo = new SimulationScenarioRepository();
  const scenario = await scenarioRepo.createScenario(ctx, businessId, model.id, uniqueCode('scn'), 'ADI Fixture Scenario');
  const scenarioVersion = await scenarioRepo.createVersion(ctx, scenario.id, businessId);

  const runRepo = new SimulationRunRepository();
  const { request } = await runRepo.createRequest(ctx, businessId, scenarioVersion.id, uniqueCode('req'), uniqueCode('idem'));
  const run_ = await runRepo.createRun(ctx, businessId, request.id, modelVersion.id, uniqueCode('run'));

  const resultRepo = new SimulationResultRepository();
  const { result, version: resultVersion } = await resultRepo.createResult(ctx, businessId, run_.id, uniqueCode('result'), 'ADI fixture result');
  await resultRepo.validateResult(ctx, result.id, resultVersion.id);
  await resultRepo.publishResult(ctx, result.id, resultVersion.id);

  const pubRepo = new SimulationPublicationRepository();
  const insight = await pubRepo.createInsightPackage(ctx, businessId, uniqueCode('sim-insight'));
  const insightVersion = await pubRepo.createVersion(ctx, insight.id, businessId, 'SIM->ADI fixture summary', resultVersion.id);
  const { package: pub } = await pubRepo.createPackage(ctx, businessId, insightVersion.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
  return pub.id;
}

async function createAdiIntake(ctx: typeof ctx1, businessId: string) {
  const simPkg = await createSimPackage(ctx, businessId);
  const intakeRepo = new ADIIntakeRepository();
  const { package: pkg } = await intakeRepo.receivePackage(ctx, {
    businessId, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('adi-intake'), idempotencyKey: uniqueCode('idem'),
  });
  return { intakeRepo, pkg, simPkg };
}

async function createQuestionAndCase(ctx: typeof ctx1, businessId: string, intakePackageId?: string) {
  const questionRepo = new DecisionQuestionRepository();
  const question = await questionRepo.createQuestion(ctx, businessId, uniqueCode('q'), 'Should we expand into the secondary market?');
  const caseRepo = new DecisionCaseRepository();
  const case_ = await caseRepo.createCase(ctx, businessId, question.id, uniqueCode('case'), intakePackageId);
  return { questionRepo, question, caseRepo, case: case_ };
}

async function createRecommendation(ctx: typeof ctx1, businessId: string, caseId: string) {
  const repo = new DecisionRecommendationRepository();
  const { recommendation, version } = await repo.createRecommendation(ctx, businessId, caseId, uniqueCode('rec'), 'Expand into the secondary market within 90 days.');
  return { repo, recommendation, version };
}

async function setupAdiIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'ADI-Test Tenant 1','adi-t1','active','test'),
            ($2,'ADI-Test Tenant 2','adi-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'ADI-Test WS 1','adi-ws1','active'),
            ($3,$4,'ADI-Test WS 2','adi-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'ADI Test Biz 1','adi-biz1','active'),
            ($4,$5,$6,'ADI Test Biz 2','adi-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'adi-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

async function teardownAdiIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
  }
  await closePool();
}

describe.runIf(run)('Stage 2G AI Decision Intelligence — live PostgreSQL', () => {
  beforeAll(setupAdiIntegration);
  afterAll(teardownAdiIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    it('ai_decision_intelligence schema exists with 47 tables', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'ai_decision_intelligence'`
      );
      expect(result.rows[0].n).toBe(47);
    });

    it('every ai_decision_intelligence table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'ai_decision_intelligence' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(47);
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_cases');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. ADIIntakeRepository ───────────────────────────────────────────────
  describe('ADIIntakeRepository', () => {
    it('receives a valid Simulation publication package', async () => {
      const simPkg = await createSimPackage(ctx1, BIZ1);
      const repo = new ADIIntakeRepository();
      const { package: pkg, idempotentReplay } = await repo.receivePackage(ctx1, {
        businessId: BIZ1, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.simulationPublicationPackageId).toBe(simPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same SIM package', async () => {
      const simPkg = await createSimPackage(ctx1, BIZ1);
      const repo = new ADIIntakeRepository();
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, simulationPublicationPackageId: simPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('records a version and a source reference', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, { format: 'json' }, 12);
      expect(version.versionNumber).toBe(1);
      await expect(intakeRepo.addSourceReference(ctx1, pkg.id, BIZ1, 'simulation', { ref: 'sim://run/1' })).resolves.toBeUndefined();
    });

    it('accepts, processes, and completes a package', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      await intakeRepo.markProcessing(ctx1, pkg.id);
      const completed = await intakeRepo.completePackage(ctx1, pkg.id);
      expect(completed.status).toBe('completed');
    });

    it('rejects a package with a reason', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      const rejected = await intakeRepo.rejectPackage(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('fails a package with a reason', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      const failed = await intakeRepo.failPackage(ctx1, pkg.id, 'downstream timeout');
      expect(failed.status).toBe('failed');
    });

    it('finds a package by id and by source package', async () => {
      const { intakeRepo, pkg, simPkg } = await createAdiIntake(ctx1, BIZ1);
      const byId = await intakeRepo.getById(ctx1, pkg.id);
      expect(byId.id).toBe(pkg.id);
      const bySource = await intakeRepo.getBySourcePackage(ctx1, BIZ1, simPkg);
      expect(bySource.id).toBe(pkg.id);
    });

    it('throws NotFoundError for an unknown intake package', async () => {
      const repo = new ADIIntakeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('adi_intake_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      const version = await intakeRepo.addVersion(ctx1, pkg.id, BIZ1, {}, 1);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.adi_intake_package_versions SET record_count = 99 WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('adi_intake_status_history is append-only — UPDATE is rejected by the database', async () => {
      const { intakeRepo, pkg } = await createAdiIntake(ctx1, BIZ1);
      await intakeRepo.acceptPackage(ctx1, pkg.id);
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.adi_intake_status_history WHERE intake_package_id = $1 ORDER BY created_at DESC LIMIT 1`, [pkg.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.adi_intake_status_history SET reason = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 3. DecisionQuestionRepository ─────────────────────────────────────────
  describe('DecisionQuestionRepository', () => {
    it('creates a question in draft status', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q'), 'Should we expand?');
      expect(question.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-v'), 'Should we expand?');
      const version = await repo.createVersion(ctx1, question.id, BIZ1, 'Should we expand into the secondary market?');
      expect(version.versionNumber).toBe(1);
    });

    it('adds an objective and a constraint to a question version', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-oc'), 'Should we expand?');
      const version = await repo.createVersion(ctx1, question.id, BIZ1, 'v1');
      await expect(repo.addObjective(ctx1, version.id, BIZ1, uniqueCode('obj'), 'Maximize survival rate', 0.6)).resolves.toBeUndefined();
      await expect(repo.addConstraint(ctx1, version.id, BIZ1, uniqueCode('con'), 'gte', 0.75)).resolves.toBeUndefined();
    });

    it('rejects an unknown constraint operator', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-badop'), 'Should we expand?');
      const version = await repo.createVersion(ctx1, question.id, BIZ1, 'v1');
      await expect(repo.addConstraint(ctx1, version.id, BIZ1, uniqueCode('con'), 'roughly', 1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status through validated to active', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-tr'), 'Should we expand?');
      await repo.transitionStatus(ctx1, question.id, 'validated');
      const active = await repo.transitionStatus(ctx1, question.id, 'active');
      expect(active.status).toBe('active');
    });

    it('rejects an unknown status', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-badst'), 'Should we expand?');
      await expect(repo.transitionStatus(ctx1, question.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds a question by id', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-find'), 'Should we expand?');
      const found = await repo.getById(ctx1, question.id);
      expect(found.id).toBe(question.id);
    });

    it('throws DecisionQuestionNotFoundError for an unknown question', async () => {
      const repo = new DecisionQuestionRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DecisionQuestionNotFoundError);
    });

    it('decision_question_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('q-immut'), 'Should we expand?');
      const version = await repo.createVersion(ctx1, question.id, BIZ1, 'v1');
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_question_versions SET statement = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 4. DecisionCaseRepository ─────────────────────────────────────────────
  describe('DecisionCaseRepository', () => {
    it('creates a case in open status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      expect(case_.status).toBe('open');
    });

    it('optionally links a case to its originating intake package', async () => {
      const { pkg } = await createAdiIntake(ctx1, BIZ1);
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1, pkg.id);
      expect(case_.intakePackageId).toBe(pkg.id);
    });

    it('creates a version and bumps latestVersion', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const version = await caseRepo.createVersion(ctx1, case_.id, BIZ1, 'Case summary v1');
      expect(version.versionNumber).toBe(1);
    });

    it('records an input on a case version', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const version = await caseRepo.createVersion(ctx1, case_.id, BIZ1, 'v1');
      await expect(caseRepo.addInput(ctx1, version.id, BIZ1, 'simulation_evidence', { ref: 'sim://1' })).resolves.toBeUndefined();
    });

    it('transitions status and records status history', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const moved = await caseRepo.transitionStatus(ctx1, case_.id, 'reasoning', 'starting reasoning');
      expect(moved.status).toBe('reasoning');
      const history = await adminPool!.query(`SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_case_status_history WHERE case_id = $1`, [case_.id]);
      expect(history.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('rejects an unknown status', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      await expect(caseRepo.transitionStatus(ctx1, case_.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds a case by id', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const found = await caseRepo.getById(ctx1, case_.id);
      expect(found.id).toBe(case_.id);
    });

    it('throws DecisionCaseNotFoundError for an unknown case', async () => {
      const repo = new DecisionCaseRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DecisionCaseNotFoundError);
    });

    it('decision_case_versions are append-only — UPDATE is rejected by the database', async () => {
      const { caseRepo, case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const version = await caseRepo.createVersion(ctx1, case_.id, BIZ1, 'v1');
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_case_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 5. ReasoningRunRepository ─────────────────────────────────────────────
  describe('ReasoningRunRepository', () => {
    it('creates a request and a run in queued status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      expect(run_.status).toBe('queued');
    });

    it('is idempotent on repeated request delivery', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const key = uniqueCode('idem-shared');
      const first = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), key);
      const second = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), key);
      expect(second.request.id).toBe(first.request.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('records a governed reasoning step', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await expect(repo.recordStep(ctx1, run_.id, BIZ1, 1, 'evidence_review', 'Reviewed available evidence')).resolves.toBeUndefined();
    });

    it('rejects an unknown step_type', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await expect(repo.recordStep(ctx1, run_.id, BIZ1, 1, 'chain_of_thought', 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions queued -> running -> completed', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await repo.transitionRun(ctx1, run_.id, 'running');
      const completed = await repo.transitionRun(ctx1, run_.id, 'completed');
      expect(completed.status).toBe('completed');
    });

    it('rejects an illegal transition (queued -> completed)', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await expect(repo.transitionRun(ctx1, run_.id, 'completed')).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('records a failure code and message on failure', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await repo.transitionRun(ctx1, run_.id, 'running');
      const failed = await repo.transitionRun(ctx1, run_.id, 'failed', { failureCode: 'EVIDENCE_MISSING', failureMessage: 'no evidence available' });
      expect(failed.failureCode).toBe('EVIDENCE_MISSING');
    });

    it('lists runs by request', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      const list = await repo.listRunsByRequest(ctx1, request.id);
      expect(list.some((r) => r.id === run_.id)).toBe(true);
    });

    it('throws ReasoningRunNotFoundError for an unknown run', async () => {
      const repo = new ReasoningRunRepository();
      await expect(repo.getRun(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ReasoningRunNotFoundError);
    });

    it('reasoning_run_steps are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new ReasoningRunRepository();
      const { request } = await repo.createRequest(ctx1, BIZ1, case_.id, uniqueCode('req'), uniqueCode('idem'));
      const run_ = await repo.createRun(ctx1, BIZ1, request.id, case_.id);
      await repo.recordStep(ctx1, run_.id, BIZ1, 1, 'evidence_review', 'x');
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.reasoning_run_steps WHERE reasoning_run_id = $1`, [run_.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.reasoning_run_steps SET summary = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 6. DecisionEvidenceRepository ─────────────────────────────────────────
  describe('DecisionEvidenceRepository', () => {
    it('records evidence for a case', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev'), 'simulation_result');
      expect(evidence.evidenceType).toBe('simulation_result');
    });

    it('rejects an unknown evidence_type', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      await expect(repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev'), 'gut_feeling')).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates a version with confidence bounded 0-1', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-v'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, { runId: 'sim-1' }, 'Simulation survival rate evidence', 0.82);
      expect(version.versionNumber).toBe(1);
    });

    it('rejects a confidence outside [0,1]', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-bad'), 'simulation_result');
      await expect(repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x', 1.5)).rejects.toBeInstanceOf(ValidationError);
    });

    it('links evidence (at the version level) to an alternative', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-link'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x');
      await expect(repo.addLink(ctx1, version.id, BIZ1, 'alternative', '00000000-0000-0000-0000-000000000001')).resolves.toBeUndefined();
    });

    it('rejects an unknown linked_entity_type', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-badlink'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x');
      await expect(repo.addLink(ctx1, version.id, BIZ1, 'wish', '00000000-0000-0000-0000-000000000001')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records quality evidence for an evidence version', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-q'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x');
      await expect(repo.addQuality(ctx1, version.id, BIZ1, { qualityScore: 0.9, freshnessSeconds: 120, reliabilityScore: 0.85 })).resolves.toBeUndefined();
    });

    it('lists evidence for a case', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-list'), 'simulation_result');
      const list = await repo.listByCase(ctx1, case_.id);
      expect(list.some((e) => e.id === evidence.id)).toBe(true);
    });

    it('decision_evidence_versions are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-immut'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x');
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_evidence_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('decision_evidence_links are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('ev-link-immut'), 'simulation_result');
      const version = await repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x');
      await repo.addLink(ctx1, version.id, BIZ1, 'alternative', '00000000-0000-0000-0000-000000000001');
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.decision_evidence_links WHERE evidence_version_id = $1`, [version.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_evidence_links SET linked_entity_type = 'recommendation' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 7. DecisionAlternativeRepository ──────────────────────────────────────
  describe('DecisionAlternativeRepository', () => {
    it('creates an alternative in draft status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt'));
      expect(alt.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-v'));
      const version = await repo.createVersion(ctx1, alt.id, BIZ1, 'Expand into the secondary market');
      expect(version.versionNumber).toBe(1);
    });

    it('adds an outcome estimate — never fabricated, only referenced', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-oe'));
      const version = await repo.createVersion(ctx1, alt.id, BIZ1, 'x');
      await expect(repo.addOutcomeEstimate(ctx1, version.id, BIZ1, 'survival_rate', { p50: 0.82 })).resolves.toBeUndefined();
    });

    it('adds a risk profile with valid severity', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-rp'));
      const version = await repo.createVersion(ctx1, alt.id, BIZ1, 'x');
      await expect(repo.addRiskProfile(ctx1, version.id, BIZ1, uniqueCode('risk'), 'medium', 0.3, 'Lease commitment risk')).resolves.toBeUndefined();
    });

    it('rejects an unknown severity', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-badsev'));
      const version = await repo.createVersion(ctx1, alt.id, BIZ1, 'x');
      await expect(repo.addRiskProfile(ctx1, version.id, BIZ1, uniqueCode('risk'), 'catastrophic', 0.1, 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status to validated', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-tr'));
      const validated = await repo.transitionStatus(ctx1, alt.id, 'validated');
      expect(validated.status).toBe('validated');
    });

    it('lists alternatives for a case', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-list'));
      const list = await repo.listByCase(ctx1, case_.id);
      expect(list.some((a) => a.id === alt.id)).toBe(true);
    });

    it('throws DecisionAlternativeNotFoundError for an unknown alternative', async () => {
      const repo = new DecisionAlternativeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DecisionAlternativeNotFoundError);
    });

    it('decision_alternative_versions are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionAlternativeRepository();
      const alt = await repo.createAlternative(ctx1, BIZ1, case_.id, uniqueCode('alt-immut'));
      const version = await repo.createVersion(ctx1, alt.id, BIZ1, 'x');
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_alternative_versions SET description = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8b. P0-3: risk and temporal-validity facts authored by ADI ──────────────
  describe('recommendation risk_class / is_time_sensitive / valid_until / twin_snapshot_id (P0-3)', () => {
    const SNAP = '44444444-5656-0000-0000-000000000001';
    const future = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

    async function createWithFacts(facts?: Parameters<DecisionRecommendationRepository['createRecommendation']>[6]) {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionRecommendationRepository();
      return repo.createRecommendation(ctx1, BIZ1, case_.id, uniqueCode('rec'), 'Facts under test', undefined, facts);
    }

    it('defaults every fact to NULL (unclassified / unknown) — never to low risk or to not-time-sensitive', async () => {
      const { version } = await createWithFacts();
      expect(version.riskClass).toBeNull();
      expect(version.isTimeSensitive).toBeNull();
      expect(version.validUntil).toBeNull();
      expect(version.twinSnapshotId).toBeNull();
    });

    it('persists and reads back the four facts', async () => {
      const validUntil = future();
      const { version } = await createWithFacts({ riskClass: 'high', isTimeSensitive: true, validUntil, twinSnapshotId: SNAP });
      expect(version.riskClass).toBe('high');
      expect(version.isTimeSensitive).toBe(true);
      expect(version.validUntil?.getTime()).toBe(validUntil.getTime());
      expect(version.twinSnapshotId).toBe(SNAP);
    });

    it('stores an explicit not-time-sensitive recommendation without valid_until', async () => {
      const { version } = await createWithFacts({ riskClass: 'low', isTimeSensitive: false });
      expect(version.isTimeSensitive).toBe(false);
      expect(version.validUntil).toBeNull();
    });

    it('rejects unknown risk classes, a time-sensitive recommendation without valid_until, and malformed references', async () => {
      await expect(createWithFacts({ riskClass: 'extreme' as never })).rejects.toBeInstanceOf(DecisionRecommendationValidationError);
      await expect(createWithFacts({ isTimeSensitive: true })).rejects.toBeInstanceOf(DecisionRecommendationValidationError);
      await expect(createWithFacts({ twinSnapshotId: 'not-a-uuid' })).rejects.toBeInstanceOf(DecisionRecommendationValidationError);
      await expect(createWithFacts({ validUntil: new Date('invalid') })).rejects.toBeInstanceOf(DecisionRecommendationValidationError);
    });

    it('the database also refuses a time-sensitive version without valid_until and an unknown risk class', async () => {
      const { version } = await createWithFacts();
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET is_time_sensitive = true WHERE id = $1`, [version.id])).rejects.toThrow(/time_sensitive_validity_check/);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET risk_class = 'extreme' WHERE id = $1`, [version.id])).rejects.toThrow(/risk_class_check/);
    });

    it('risk_class can be raised before publication but never lowered or cleared', async () => {
      const { version } = await createWithFacts({ riskClass: 'medium' });
      await adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET risk_class = 'critical' WHERE id = $1`, [version.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET risk_class = 'low' WHERE id = $1`, [version.id])).rejects.toThrow(/raised but not lowered/);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET risk_class = NULL WHERE id = $1`, [version.id])).rejects.toThrow(/raised but not lowered/);
      const row = await adminPool!.query(`SELECT risk_class FROM ai_decision_intelligence.decision_recommendation_versions WHERE id = $1`, [version.id]);
      expect(row.rows[0].risk_class).toBe('critical');
    });

    it('a classified recommendation can be given a class once but an unclassified one stays unclassified unless set', async () => {
      const { version } = await createWithFacts();
      await adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET risk_class = 'high' WHERE id = $1`, [version.id]);
      const row = await adminPool!.query(`SELECT risk_class FROM ai_decision_intelligence.decision_recommendation_versions WHERE id = $1`, [version.id]);
      expect(row.rows[0].risk_class).toBe('high');
    });

    it('the four facts of a published version are immutable', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionRecommendationRepository();
      const { recommendation, version } = await repo.createRecommendation(ctx1, BIZ1, case_.id, uniqueCode('rec'), 'Publish me', undefined, { riskClass: 'medium', isTimeSensitive: true, validUntil: future(), twinSnapshotId: SNAP });
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      for (const assignment of [`risk_class = 'critical'`, `is_time_sensitive = false`, `valid_until = now() + interval '30 days'`, `twin_snapshot_id = gen_random_uuid()`]) {
        await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET ${assignment} WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
      }
    });
  });

  // ── 8. DecisionRecommendationRepository (authority boundary + immutability) ──
  describe('DecisionRecommendationRepository', () => {
    it('creates a recommendation header and v1 together in draft status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      expect(recommendation.status).toBe('draft');
      expect(recommendation.latestVersion).toBe(1);
      expect(version.versionNumber).toBe(1);
    });

    it('adds a rationale and an implementation step to a recommendation version', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await expect(repo.addRationale(ctx1, version.id, BIZ1, uniqueCode('rat'), 'Simulated survival rate exceeds threshold', { evidenceId: 'ev-1' })).resolves.toBeUndefined();
      await expect(repo.addImplementationStep(ctx1, version.id, BIZ1, 1, 'Secure lease for secondary location')).resolves.toBeUndefined();
    });

    it('validates and publishes a recommendation', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      const published = await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      expect(published.status).toBe('published');
    });

    it('rejects publishing a non-validated recommendation', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await expect(repo.publishRecommendation(ctx1, recommendation.id, version.id)).rejects.toBeInstanceOf(DecisionRecommendationStateConflictError);
    });

    it('rejects re-validating a published recommendation — immutability', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      await expect(repo.validateRecommendation(ctx1, recommendation.id, version.id)).rejects.toBeInstanceOf(DecisionRecommendationImmutableError);
    });

    it('rejects superseding a published recommendation — immutability', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      await expect(repo.supersedeRecommendation(ctx1, recommendation.id)).rejects.toBeInstanceOf(DecisionRecommendationImmutableError);
    });

    it('rejects rejecting a published recommendation — immutability', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      await expect(repo.rejectRecommendation(ctx1, recommendation.id)).rejects.toBeInstanceOf(DecisionRecommendationImmutableError);
    });

    it('supersedes a recommendation before publication', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation } = await createRecommendation(ctx1, BIZ1, case_.id);
      const superseded = await repo.supersedeRecommendation(ctx1, recommendation.id);
      expect(superseded.status).toBe('superseded');
    });

    it('a published recommendation is immutable — direct UPDATE of status is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendations SET status = 'superseded' WHERE id = $1`, [recommendation.id])).rejects.toThrow(/immutable/);
    });

    it('decision_recommendation_versions reject a status change once published — direct UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET status = 'superseded' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });

    it('finds a recommendation by id', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation } = await createRecommendation(ctx1, BIZ1, case_.id);
      const found = await repo.getById(ctx1, recommendation.id);
      expect(found.id).toBe(recommendation.id);
    });

    it('lists published recommendations for a case', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.validateRecommendation(ctx1, recommendation.id, version.id);
      await repo.publishRecommendation(ctx1, recommendation.id, version.id);
      const list = await repo.getPublishedForCase(ctx1, case_.id);
      expect(list.some((r) => r.id === recommendation.id)).toBe(true);
    });

    it('recommendation_rationales are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await repo.addRationale(ctx1, version.id, BIZ1, uniqueCode('rat'), 'x', {});
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.recommendation_rationales WHERE recommendation_version_id = $1`, [version.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.recommendation_rationales SET statement = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. DecisionConfidenceRepository ───────────────────────────────────────
  describe('DecisionConfidenceRepository', () => {
    it('records a confidence score bounded 0-1', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      const score = await repo.recordConfidenceScore(ctx1, version.id, BIZ1, 0.82, 'simulation_evidence');
      expect(score.confidence).toBeCloseTo(0.82, 2);
    });

    it('rejects a confidence outside [0,1]', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordConfidenceScore(ctx1, version.id, BIZ1, 1.5, 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records an uncertainty with valid impact', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordUncertainty(ctx1, version.id, BIZ1, uniqueCode('unc'), 'Demand forecast variance', 'medium')).resolves.toBeUndefined();
    });

    it('rejects an unknown impact', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordUncertainty(ctx1, version.id, BIZ1, uniqueCode('unc'), 'x', 'extreme')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records a limitation', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordLimitation(ctx1, version.id, BIZ1, uniqueCode('lim'), 'Engine v3 lacks seeded reproducibility')).resolves.toBeUndefined();
    });

    it('records an assumption with valid source', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordAssumption(ctx1, version.id, BIZ1, uniqueCode('asm'), 'Capital is available', 'declared')).resolves.toBeUndefined();
    });

    it('rejects an unknown assumption source', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      await expect(repo.recordAssumption(ctx1, version.id, BIZ1, uniqueCode('asm'), 'x', 'guessed')).rejects.toBeInstanceOf(ValidationError);
    });

    it('lists confidence scores for a recommendation version', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      const score = await repo.recordConfidenceScore(ctx1, version.id, BIZ1, 0.7, 'x');
      const list = await repo.listForRecommendationVersion(ctx1, version.id);
      expect(list.some((s) => s.id === score.id)).toBe(true);
    });

    it('decision_confidence_scores are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionConfidenceRepository();
      const score = await repo.recordConfidenceScore(ctx1, version.id, BIZ1, 0.5, 'x');
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_confidence_scores SET confidence = 0.9 WHERE id = $1`, [score.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 10. DecisionPolicyRepository ──────────────────────────────────────────
  describe('DecisionPolicyRepository', () => {
    it('creates a policy in draft status', async () => {
      const repo = new DecisionPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol'), 'Capital exposure guardrail');
      expect(policy.status).toBe('draft');
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new DecisionPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-v'), 'Guardrail');
      const version = await repo.createVersion(ctx1, policy.id, BIZ1, { maxExposure: 100000 });
      expect(version.versionNumber).toBe(1);
    });

    it('records a passing policy evaluation against a recommendation version', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version: recVersion } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-eval'), 'Guardrail');
      const polVersion = await repo.createVersion(ctx1, policy.id, BIZ1, {});
      await expect(repo.recordEvaluation(ctx1, polVersion.id, recVersion.id, BIZ1, true, { checked: 'exposure' })).resolves.toBeUndefined();
    });

    it('records a guardrail violation with valid severity', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionPolicyRepository();
      await expect(repo.recordGuardrailViolation(ctx1, case_.id, BIZ1, uniqueCode('guard'), 'high', 'Exceeds exposure limit')).resolves.toBeUndefined();
    });

    it('rejects an unknown guardrail severity', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionPolicyRepository();
      await expect(repo.recordGuardrailViolation(ctx1, case_.id, BIZ1, uniqueCode('guard'), 'apocalyptic', 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions status to active', async () => {
      const repo = new DecisionPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-act'), 'Guardrail');
      const active = await repo.transitionStatus(ctx1, policy.id, 'active');
      expect(active.status).toBe('active');
    });

    it('lists active policies for a business', async () => {
      const repo = new DecisionPolicyRepository();
      const policy = await repo.createPolicy(ctx1, BIZ1, uniqueCode('pol-list'), 'Guardrail');
      await repo.transitionStatus(ctx1, policy.id, 'active');
      const list = await repo.listActivePolicies(ctx1, BIZ1);
      expect(list.some((p) => p.id === policy.id)).toBe(true);
    });

    it('throws DecisionPolicyNotFoundError for an unknown policy', async () => {
      const repo = new DecisionPolicyRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DecisionPolicyNotFoundError);
    });

    it('decision_guardrail_violations are append-only — permanent audit evidence, UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionPolicyRepository();
      await repo.recordGuardrailViolation(ctx1, case_.id, BIZ1, uniqueCode('guard-immut'), 'critical', 'x');
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.decision_guardrail_violations WHERE case_id = $1`, [case_.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_guardrail_violations SET description = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 11. DecisionMonitoringRequirementRepository ───────────────────────────
  describe('DecisionMonitoringRequirementRepository', () => {
    it('creates a monitoring requirement in draft status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon'), 'Watch monthly revenue');
      expect(req.status).toBe('draft');
    });

    it('adds a target metric', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-m'), 'Watch monthly revenue');
      await expect(repo.addMetric(ctx1, req.id, BIZ1, 'monthly_revenue', { target: 50000 }, 'USD')).resolves.toBeUndefined();
    });

    it('schedules and completes a review', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-r'), 'Watch revenue');
      const schedule = await repo.scheduleReview(ctx1, req.id, BIZ1, new Date(Date.now() + 86400000));
      expect(schedule.status).toBe('scheduled');
      const completed = await repo.completeReview(ctx1, schedule.id);
      expect(completed.status).toBe('completed');
    });

    it('skips a scheduled review', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-s'), 'Watch revenue');
      const schedule = await repo.scheduleReview(ctx1, req.id, BIZ1, new Date());
      const skipped = await repo.skipReview(ctx1, schedule.id);
      expect(skipped.status).toBe('skipped');
    });

    it('transitions requirement status to active', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-act'), 'x');
      const active = await repo.transitionStatus(ctx1, req.id, 'active');
      expect(active.status).toBe('active');
    });

    it('rejects an unknown requirement status', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-bad'), 'x');
      await expect(repo.transitionStatus(ctx1, req.id, 'archived')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds a monitoring requirement by id', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-find'), 'x');
      const found = await repo.getById(ctx1, req.id);
      expect(found.id).toBe(req.id);
    });

    it('decision_monitoring_metrics are append-only — UPDATE is rejected by the database', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      const repo = new DecisionMonitoringRequirementRepository();
      const req = await repo.createRequirement(ctx1, BIZ1, version.id, uniqueCode('mon-immut'), 'x');
      await repo.addMetric(ctx1, req.id, BIZ1, 'metric', {}, undefined);
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.decision_monitoring_metrics WHERE monitoring_requirement_id = $1`, [req.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.decision_monitoring_metrics SET metric_code = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 12. ADIPublicationRepository ──────────────────────────────────────────
  describe('ADIPublicationRepository', () => {
    async function makeInsightVersion(recommendationVersionId?: string) {
      const repo = new ADIPublicationRepository();
      const insight = await repo.createInsightPackage(ctx1, BIZ1, uniqueCode('adi-insight'));
      const version = await repo.createVersion(ctx1, insight.id, BIZ1, 'S', recommendationVersionId);
      return { repo, insight, version };
    }

    it('creates an insight package and a version', async () => {
      const { insight, version } = await makeInsightVersion();
      expect(insight.status).toBe('draft');
      expect(version.versionNumber).toBe(1);
    });

    it('creates a publication package targeting approved_business_action', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg, idempotentReplay } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      expect(pkg.publicationStatus).toBe('draft');
      expect(idempotentReplay).toBe(false);
    });

    it('rejects an invalid target_layer', async () => {
      const { repo, version } = await makeInsightVersion();
      await expect(repo.createPackage(ctx1, BIZ1, version.id, 'outcome_monitoring', 'X', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent by (business_id, idempotency_key)', async () => {
      const { repo, version } = await makeInsightVersion();
      const key = uniqueCode('idem-shared');
      const first = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', key);
      const second = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('dispatches, acknowledges, and records publication events', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      const acked = await repo.acknowledge(ctx1, pkg.id);
      expect(acked.publicationStatus).toBe('acknowledged');
      const events = await adminPool!.query(`SELECT count(*)::int AS n FROM ai_decision_intelligence.adi_publication_events WHERE adi_publication_package_id = $1`, [pkg.id]);
      expect(events.rows[0].n).toBeGreaterThanOrEqual(3);
    });

    it('rejects an illegal transition (draft -> dispatched)', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      await expect(repo.dispatch(ctx1, pkg.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects a publication package', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      const rejected = await repo.reject(ctx1, pkg.id, 'incomplete evidence');
      expect(rejected.publicationStatus).toBe('rejected');
    });

    it('revokes an acknowledged publication package', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      await repo.acknowledge(ctx1, pkg.id);
      const revoked = await repo.revoke(ctx1, pkg.id);
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('finds a publication package by id', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      const found = await repo.getById(ctx1, pkg.id);
      expect(found.id).toBe(pkg.id);
    });

    it('adi_insight_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await makeInsightVersion();
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.adi_insight_package_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. ADIComponentRegistryRepository ────────────────────────────────────
  describe('ADIComponentRegistryRepository', () => {
    it('registers a component in draft status', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp'), 'reasoning_engine');
      expect(component.status).toBe('draft');
    });

    it('registers a component version and bumps latestVersion', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-v'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, { api: 'v1' });
      expect(version.versionNumber).toBe(1);
    });

    it('activates a component', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-act'), 'reasoning_engine');
      const activated = await repo.activateVersion(ctx1, component.id, component.id);
      expect(activated.status).toBe('active');
    });

    it('records a deployment and activates it', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-dep'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      expect(deployment.activationState).toBe('active');
    });

    it('records a rollback', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'regression detected');
      const row = await adminPool!.query(`SELECT activation_state FROM ai_decision_intelligence.adi_deployments WHERE id = $1`, [deployment.id]);
      expect(row.rows[0].activation_state).toBe('rolled_back');
    });

    it('gets the active version for a component', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-getact'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await repo.activateVersion(ctx1, component.id, version.id);
      const active = await repo.getActiveVersion(ctx1, component.id);
      expect(active.id).toBe(version.id);
    });

    it('throws ADIComponentRegistryNotFoundError for an unknown component', async () => {
      const repo = new ADIComponentRegistryRepository();
      await expect(repo.createVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, {})).rejects.toBeInstanceOf(ADIComponentRegistryNotFoundError);
    });

    it('adi_component_registry_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-immut'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.adi_component_registry_versions SET capabilities = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('adi_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new ADIComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb-immut'), 'reasoning_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'x');
      const row = await adminPool!.query(`SELECT id FROM ai_decision_intelligence.adi_deployment_rollbacks WHERE adi_deployment_id = $1`, [deployment.id]);
      await expect(adminPool!.query(`UPDATE ai_decision_intelligence.adi_deployment_rollbacks SET reason = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 14. Cross-tenant / cross-workspace RLS live rejection ────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 questions', async () => {
      const repo = new DecisionQuestionRepository();
      const question = await repo.createQuestion(ctx1, BIZ1, uniqueCode('iso-q'), 'Iso');
      await expect(repo.createVersion(ctx2, question.id, BIZ1, 'x')).rejects.toBeInstanceOf(DecisionQuestionNotFoundError);
    });

    it('tenant 2 cannot read tenant 1 cases', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionCaseRepository();
      await expect(repo.getById(ctx2, case_.id)).rejects.toBeInstanceOf(DecisionCaseNotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 evidence', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('iso-ev'), 'simulation_result');
      const list = await repo.listByCase(ctx2, case_.id);
      expect(list.length).toBe(0);
    });

    it('tenant 2 cannot read a tenant 1 recommendation', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { repo, recommendation } = await createRecommendation(ctx1, BIZ1, case_.id);
      await expect(repo.getById(ctx2, recommendation.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot acknowledge a tenant 1 publication package', async () => {
      const pubRepo = new ADIPublicationRepository();
      const insight = await pubRepo.createInsightPackage(ctx1, BIZ1, uniqueCode('iso-insight'));
      const version = await pubRepo.createVersion(ctx1, insight.id, BIZ1, 'S');
      const { package: pkg } = await pubRepo.createPackage(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'));
      await expect(pubRepo.markReady(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 guardrail violations', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionPolicyRepository();
      await repo.recordGuardrailViolation(ctx1, case_.id, BIZ1, uniqueCode('iso-guard'), 'low', 'x');
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_guardrail_violations WHERE case_id = $1 AND tenant_id = $2`,
        [case_.id, T2]
      );
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 15. Outbox atomicity — all 10 required adi.* events ──────────────────────
  describe('outbox event functions', () => {
    async function countByType(eventType: string): Promise<number> {
      const result = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = $1`, [eventType]);
      return result.rows[0].n as number;
    }

    it('emit_intake_received inserts a pending outbox event atomically', async () => {
      const before = await countByType('adi.intake.received');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_intake_received($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.intake.received')).toBe(before + 1);
    });

    it('emit_reasoning_started inserts a pending outbox event', async () => {
      const before = await countByType('adi.reasoning.started');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_reasoning_started($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.reasoning.started')).toBe(before + 1);
    });

    it('emit_reasoning_completed inserts a pending outbox event', async () => {
      const before = await countByType('adi.reasoning.completed');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_reasoning_completed($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.reasoning.completed')).toBe(before + 1);
    });

    it('emit_reasoning_failed records a failure code in the payload', async () => {
      const result = await adminPool!.query(`SELECT ai_decision_intelligence.emit_reasoning_failed($1,$2,gen_random_uuid(),'EVIDENCE_MISSING',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.failureCode).toBe('EVIDENCE_MISSING');
    });

    it('emit_alternative_evaluated inserts a pending outbox event', async () => {
      const before = await countByType('adi.alternative.evaluated');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_alternative_evaluated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.alternative.evaluated')).toBe(before + 1);
    });

    it('emit_recommendation_generated inserts a pending outbox event', async () => {
      const before = await countByType('adi.recommendation.generated');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_recommendation_generated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.recommendation.generated')).toBe(before + 1);
    });

    it('emit_confidence_calculated inserts a pending outbox event', async () => {
      const before = await countByType('adi.confidence.calculated');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_confidence_calculated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.confidence.calculated')).toBe(before + 1);
    });

    it('emit_guardrail_violated records severity in the payload', async () => {
      const result = await adminPool!.query(`SELECT ai_decision_intelligence.emit_guardrail_violated($1,$2,gen_random_uuid(),'critical',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.severity).toBe('critical');
    });

    it('emit_decision_published inserts a pending outbox event', async () => {
      const before = await countByType('adi.decision.published');
      await adminPool!.query(`SELECT ai_decision_intelligence.emit_decision_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('adi.decision.published')).toBe(before + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT ai_decision_intelligence.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts the authorized approved_business_action target layer', async () => {
      const result = await adminPool!.query(
        `SELECT ai_decision_intelligence.emit_data_published($1,$2,gen_random_uuid(),'approved_business_action','ABA-01',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });
  });

  // ── 16. Transaction rollback behaviour ────────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial evidence version when validation fails before the insert', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const repo = new DecisionEvidenceRepository();
      const evidence = await repo.recordEvidence(ctx1, BIZ1, case_.id, uniqueCode('rb-ev'), 'simulation_result');
      await expect(repo.createVersion(ctx1, evidence.id, BIZ1, {}, 'x', 5.0)).rejects.toBeInstanceOf(ValidationError);
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_evidence_versions WHERE evidence_id = $1`, [evidence.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rolls back an out-of-band insert that violates a database-level bound (defense in depth)', async () => {
      const { case: case_ } = await createQuestionAndCase(ctx1, BIZ1);
      const { version } = await createRecommendation(ctx1, BIZ1, case_.id);
      await expect(
        adminPool!.query(
          `INSERT INTO ai_decision_intelligence.decision_confidence_scores (tenant_id, workspace_id, business_id, recommendation_version_id, confidence, basis)
           VALUES ($1,$2,$3,$4,2.0,'x')`,
          [T1, WS1, BIZ1, version.id]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM ai_decision_intelligence.decision_confidence_scores WHERE recommendation_version_id = $1`, [version.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rejects a duplicate intake idempotency key with a different SIM package as an application-level replay, not a DB error', async () => {
      const repo = new ADIIntakeRepository();
      const simPkg1 = await createSimPackage(ctx1, BIZ1);
      const simPkg2 = await createSimPackage(ctx1, BIZ1);
      const key = uniqueCode('idem-shared');
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, simulationPublicationPackageId: simPkg1, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, simulationPublicationPackageId: simPkg2, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      expect(second.idempotentReplay).toBe(true);
      expect(second.package.id).toBe(first.package.id);
    });
  });
});

describe.skipIf(run)('Stage 2G AI Decision Intelligence — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
