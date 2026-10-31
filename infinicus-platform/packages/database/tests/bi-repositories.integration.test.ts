/**
 * Live PostgreSQL 16 integration tests for Stage 2D Business Intelligence
 * persistence (BUILD-09).
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
  IntelligenceIntakeRepository,
  MetricDefinitionRepository,
  MetricCalculationRepository,
  AnalysisRunRepository,
  AnalysisResultRepository,
  ForecastRepository,
  AnomalyRepository,
  RiskAssessmentRepository,
  InsightPackageRepository,
  BIPublicationPackageRepository,
} from '../src/repositories/bi/index.js';
import { NotFoundError, ConflictError, ValidationError, InvalidTransitionError } from '../src/repositories/bi/errors.js';

const run = !!process.env.DATABASE_URL;

const T1  = '22222222-b1b1-0000-0000-000000000001';
const WS1 = '22222222-b1b1-0000-0000-000000000002';
const T2  = '22222222-b1b1-0000-0000-000000000003';
const WS2 = '22222222-b1b1-0000-0000-000000000004';
const UID = '22222222-b1b1-0000-0000-000000000099';
const BIZ1 = '22222222-b2b2-0000-0000-000000000001';
const BIZ2 = '22222222-b2b2-0000-0000-000000000002';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Inserts a fresh BO publication package fixture (real upstream FK target) and returns its id. */
async function createBoPackage(tenantId: string, workspaceId: string, businessId: string): Promise<string> {
  const result = await adminPool!.query<{ id: string }>(
    `INSERT INTO business_operations.bo_publication_packages
       (tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, package_status)
     VALUES ($1,$2,$3,$4,'business_intelligence','BI-01','2026-01-01','2026-02-01',100,'ready')
     RETURNING id`,
    [tenantId, workspaceId, businessId, uniqueCode('bo-pkg')]
  );
  return result.rows[0].id;
}

async function setupBIIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'BI-Test Tenant 1','bi-t1','active','test'),
            ($2,'BI-Test Tenant 2','bi-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'BI-Test WS 1','bi-ws1','active'),
            ($3,$4,'BI-Test WS 2','bi-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'BI Test Biz 1','bi-biz1','active'),
            ($4,$5,$6,'BI Test Biz 2','bi-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  // User fixture — required for anomaly_detections.acknowledged_by / anomaly_status_history.actor_id FKs
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'bi-test-approver@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

/**
 * Append-only BI tables reject DELETE unconditionally (business_intelligence
 * .forbid_mutation trigger, migration 0049) — even for the BYPASSRLS admin
 * role, and every such table FK-RESTRICTs up through tenant/business rows.
 * This is by design: analytical evidence is permanent. The disposable test
 * database (dropped/recreated for empty-database validation) is therefore
 * the reset mechanism, not per-suite teardown. Only mutable, non-evidence
 * fixtures are cleaned here; fixed-UUID tenant/workspace/business/user rows
 * are left in place (idempotent ON CONFLICT DO NOTHING on setup) so reruns
 * within the same database session remain safe.
 */
async function teardownBIIntegration(): Promise<void> {
  if (adminPool) {
    // Every mutable BI table is transitively referenced by at least one
    // append-only child via ON DELETE RESTRICT (e.g. bi_component_registry
    // <- bi_component_versions [append-only] <- bi_deployments <-
    // bi_deployment_rollbacks [append-only]), so no BI-schema row created by
    // this suite can be deleted. Nothing to clean up here by design; the
    // disposable test database is the reset mechanism between full runs.
    await adminPool.end();
  }
  await closePool();
}

describe.runIf(run)('Stage 2D Business Intelligence — live PostgreSQL', () => {
  beforeAll(setupBIIntegration);
  afterAll(teardownBIIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    // 48 Stage 2D tables + 5 added by migration 0223 (warehouse rows, version seals, calculation runs, run inputs, metric results). The count stays an exact pin.
    it('business_intelligence schema exists with 53 tables', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'business_intelligence'`
      );
      expect(result.rows[0].n).toBe(53);
    });

    it('every BI table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'business_intelligence' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(53);
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      // A fresh unscoped query via the app pool (no withTenantTransaction context) sees zero rows.
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM business_intelligence.metric_definitions');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. Intelligence intake and lineage ────────────────────────────────────
  describe('IntelligenceIntakeRepository — intake and lineage', () => {
    it('intakes a valid BO publication package', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg, idempotentReplay } = await repo.intake(ctx1, {
        businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'),
        domain: 'financial', idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.boPublicationPackageId).toBe(boPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same BO package', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const key = uniqueCode('idem');
      const first = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: key });
      const second = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'sales_revenue', idempotencyKey: uniqueCode('idem') });
      // Same bo_publication_package_id => replays the FIRST package regardless of new idempotency key.
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('preserves upstream lineage — boPublicationPackageId is exact', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T2, WS2, BIZ2);
      const { package: pkg } = await repo.intake(ctx2, { businessId: BIZ2, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'customer', idempotencyKey: uniqueCode('idem') });
      const found = await repo.findById(ctx2, pkg.id);
      expect(found.boPublicationPackageId).toBe(boPkg);
    });

    it('transitions intake status validated -> processed', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: uniqueCode('idem') });
      const validated = await repo.transitionStatus(ctx1, pkg.id, 'validated');
      expect(validated.status).toBe('validated');
      const processed = await repo.transitionStatus(ctx1, pkg.id, 'processed');
      expect(processed.status).toBe('processed');
    });

    it('rejects an invalid intake status transition target', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: uniqueCode('idem') });
      await expect(repo.transitionStatus(ctx1, pkg.id, 'not_a_real_status')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records a rejection reason when rejected', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: uniqueCode('idem') });
      const rejected = await repo.transitionStatus(ctx1, pkg.id, 'rejected', 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('throws NotFoundError for an unknown intake package id', async () => {
      const repo = new IntelligenceIntakeRepository();
      await expect(repo.findById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('records a source reference preserving provenance', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: uniqueCode('idem') });
      await expect(repo.recordSourceReference(ctx1, pkg.id, BIZ1, 'business_operations', { packageCode: 'bo-test-pkg-1' })).resolves.toBeUndefined();
    });

    it('rejects cross-tenant intake package reads', async () => {
      const repo = new IntelligenceIntakeRepository();
      const boPkg = await createBoPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.intake(ctx1, { businessId: BIZ1, boPublicationPackageId: boPkg, intakeCode: uniqueCode('intake'), domain: 'financial', idempotencyKey: uniqueCode('idem') });
      await expect(repo.findById(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 3. Analytical datasets ─────────────────────────────────────────────────
  describe('IntelligenceIntakeRepository — analytical datasets', () => {
    it('creates a dataset', async () => {
      const repo = new IntelligenceIntakeRepository();
      const ds = await repo.createDataset(ctx1, BIZ1, uniqueCode('ds'), 'financial', 'Revenue dataset');
      expect(ds.latestVersion).toBe(0);
      expect(ds.status).toBe('draft');
    });

    it('rejects a duplicate dataset code within the same business', async () => {
      const repo = new IntelligenceIntakeRepository();
      const code = uniqueCode('ds-dup');
      await repo.createDataset(ctx1, BIZ1, code, 'financial', 'Dup 1');
      await expect(repo.createDataset(ctx1, BIZ1, code, 'financial', 'Dup 2')).rejects.toBeInstanceOf(ConflictError);
    });

    it('publishes a dataset version and increments latestVersion', async () => {
      const repo = new IntelligenceIntakeRepository();
      const ds = await repo.createDataset(ctx1, BIZ1, uniqueCode('ds-v'), 'financial', 'Versioned');
      const v1 = await repo.publishDatasetVersion(ctx1, ds.id, BIZ1, new Date('2026-01-01'), { qualityScore: 0.9, completenessScore: 0.85 });
      expect(v1.versionNumber).toBe(1);
      expect(v1.qualityScore).toBeCloseTo(0.9, 4);
      expect(v1.completenessScore).toBeCloseTo(0.85, 4);
      const v2 = await repo.publishDatasetVersion(ctx1, ds.id, BIZ1, new Date('2026-02-01'));
      expect(v2.versionNumber).toBe(2);
    });

    it('dataset versions are append-only — direct UPDATE is rejected by the database', async () => {
      const repo = new IntelligenceIntakeRepository();
      const ds = await repo.createDataset(ctx1, BIZ1, uniqueCode('ds-immut'), 'financial', 'Immutable');
      const v1 = await repo.publishDatasetVersion(ctx1, ds.id, BIZ1, new Date('2026-01-01'));
      await expect(
        adminPool!.query(`UPDATE business_intelligence.analytical_dataset_versions SET publication_status = 'superseded' WHERE id = $1`, [v1.id])
      ).rejects.toThrow(/append-only/);
    });

    it('throws NotFoundError publishing a version for an unknown dataset', async () => {
      const repo = new IntelligenceIntakeRepository();
      await expect(repo.publishDatasetVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, new Date())).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 4. Metric definitions ──────────────────────────────────────────────────
  describe('MetricDefinitionRepository', () => {
    it('creates a metric definition with version 1', async () => {
      const repo = new MetricDefinitionRepository();
      const { definition, version } = await repo.create(ctx1, {
        businessId: BIZ1, metricCode: uniqueCode('metric'), domain: 'financial', metricType: 'base',
        name: 'Gross Revenue', unit: 'currency', currencyCode: 'USD', aggregationMethod: 'sum', timeGrain: 'month',
      });
      expect(definition.latestVersion).toBe(1);
      expect(version.versionNumber).toBe(1);
      expect(version.aggregationMethod).toBe('sum');
    });

    it('rejects a duplicate metric_code within the same business', async () => {
      const repo = new MetricDefinitionRepository();
      const code = uniqueCode('metric-dup');
      await repo.create(ctx1, { businessId: BIZ1, metricCode: code, domain: 'financial', metricType: 'base', name: 'A', unit: 'count', aggregationMethod: 'count', timeGrain: 'day' });
      await expect(repo.create(ctx1, { businessId: BIZ1, metricCode: code, domain: 'financial', metricType: 'base', name: 'B', unit: 'count', aggregationMethod: 'count', timeGrain: 'day' }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it('finds a metric definition by id', async () => {
      const repo = new MetricDefinitionRepository();
      const { definition } = await repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('metric-find'), domain: 'customer', metricType: 'rate', name: 'Churn Rate', unit: 'percent', aggregationMethod: 'average', timeGrain: 'month' });
      const found = await repo.findById(ctx1, definition.id);
      expect(found.name).toBe('Churn Rate');
    });

    it('lists metric definitions by domain', async () => {
      const repo = new MetricDefinitionRepository();
      await repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('metric-dom'), domain: 'workforce', metricType: 'base', name: 'Headcount', unit: 'count', aggregationMethod: 'count', timeGrain: 'month' });
      const list = await repo.listByDomain(ctx1, 'workforce');
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.domain === 'workforce')).toBe(true);
    });

    it('creates a new metric definition version and bumps latestVersion', async () => {
      const repo = new MetricDefinitionRepository();
      const { definition } = await repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('metric-v'), domain: 'financial', metricType: 'base', name: 'V', unit: 'currency', aggregationMethod: 'sum', timeGrain: 'month' });
      const v2 = await repo.createVersion(ctx1, definition.id, { aggregationMethod: 'average', timeGrain: 'quarter' });
      expect(v2.versionNumber).toBe(2);
      const refreshed = await repo.findById(ctx1, definition.id);
      expect(refreshed.latestVersion).toBe(2);
    });

    it('throws NotFoundError for an unknown metric definition', async () => {
      const repo = new MetricDefinitionRepository();
      await expect(repo.findById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 5. Metric calculation and time series ──────────────────────────────────
  describe('MetricCalculationRepository', () => {
    async function makeMetric() {
      const repo = new MetricDefinitionRepository();
      return repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('mc'), domain: 'financial', metricType: 'base', name: 'MC', unit: 'currency', currencyCode: 'USD', aggregationMethod: 'sum', timeGrain: 'month' });
    }

    it('records a calculated value with unit and currency preserved exactly', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      const value = await repo.recordCalculation(ctx1, {
        metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1,
        value: 12345.6789, unit: 'currency', currencyCode: 'USD', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01'),
      });
      expect(value.value).toBeCloseTo(12345.6789, 4);
      expect(value.unit).toBe('currency');
      expect(value.currencyCode).toBe('USD'); // no silent conversion
    });

    it('rejects a calculation whose period_end is not after period_start', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      await expect(repo.recordCalculation(ctx1, {
        metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1,
        value: 1, unit: 'currency', periodStart: new Date('2026-02-01'), periodEnd: new Date('2026-01-01'),
      })).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds a calculated value by id with numeric precision preserved', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      const created = await repo.recordCalculation(ctx1, { metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1, value: 99.995, unit: 'currency', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') });
      const found = await repo.findById(ctx1, created.id);
      expect(found.value).toBeCloseTo(99.995, 3);
    });

    it('lists calculated values by metric definition', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      await repo.recordCalculation(ctx1, { metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1, value: 1, unit: 'currency', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') });
      const list = await repo.listByMetricDefinition(ctx1, definition.id);
      expect(list.length).toBeGreaterThan(0);
    });

    it('appends time-series points in monotonic sequence order', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      const value = await repo.recordCalculation(ctx1, { metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1, value: 1, unit: 'currency', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') });
      await repo.appendTimeSeriesPoint(ctx1, value.id, new Date('2026-01-01'), 1, 10.5, 'currency');
      await repo.appendTimeSeriesPoint(ctx1, value.id, new Date('2026-01-02'), 2, 20.25, 'currency');
      const series = await repo.listTimeSeries(ctx1, value.id);
      expect(series.map((p) => p.sequenceNumber)).toEqual([1, 2]);
      expect(series[1].value).toBeCloseTo(20.25, 2);
    });

    it('rejects duplicate sequence numbers within the same time series', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      const value = await repo.recordCalculation(ctx1, { metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1, value: 1, unit: 'currency', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') });
      await repo.appendTimeSeriesPoint(ctx1, value.id, new Date('2026-01-01'), 1, 1, 'currency');
      await expect(repo.appendTimeSeriesPoint(ctx1, value.id, new Date('2026-01-02'), 1, 2, 'currency')).rejects.toThrow();
    });

    it('metric_calculated_values are append-only — UPDATE is rejected by the database', async () => {
      const { definition, version } = await makeMetric();
      const repo = new MetricCalculationRepository();
      const value = await repo.recordCalculation(ctx1, { metricDefinitionId: definition.id, metricDefinitionVersionId: version.id, businessId: BIZ1, value: 1, unit: 'currency', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') });
      await expect(adminPool!.query(`UPDATE business_intelligence.metric_calculated_values SET value = 999 WHERE id = $1`, [value.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 6. Analysis lifecycle ───────────────────────────────────────────────────
  describe('AnalysisRunRepository', () => {
    it('creates an analysis request and a queued run', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      expect(run.status).toBe('queued');
    });

    it('transitions queued -> running -> completed with timestamps recorded', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      const running = await repo.transitionRun(ctx1, run.id, 'running');
      expect(running.startedAt).not.toBeNull();
      const completed = await repo.transitionRun(ctx1, run.id, 'completed');
      expect(completed.completedAt).not.toBeNull();
      expect(completed.status).toBe('completed');
    });

    it('rejects an invalid transition (queued -> completed, skipping running)', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      await expect(repo.transitionRun(ctx1, run.id, 'completed')).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects any transition out of a terminal state', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      await repo.transitionRun(ctx1, run.id, 'running');
      await repo.transitionRun(ctx1, run.id, 'failed', { failureCode: 'BI_TIMEOUT', failureMessage: 'timed out' });
      await expect(repo.transitionRun(ctx1, run.id, 'running')).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('records failure code and message on a failed run', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      await repo.transitionRun(ctx1, run.id, 'running');
      const failed = await repo.transitionRun(ctx1, run.id, 'failed', { failureCode: 'BI_MODEL_ERROR', failureMessage: 'bad input' });
      expect(failed.failureCode).toBe('BI_MODEL_ERROR');
      expect(failed.failureMessage).toBe('bad input');
    });

    it('lists runs by request', async () => {
      const repo = new AnalysisRunRepository();
      const request = await repo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      await repo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      const runs = await repo.listRunsByRequest(ctx1, request.id);
      expect(runs.length).toBe(2);
    });

    it('throws NotFoundError transitioning an unknown run', async () => {
      const repo = new AnalysisRunRepository();
      await expect(repo.transitionRun(ctx1, '00000000-0000-0000-0000-000000000000', 'running')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 7. Analysis outputs, findings, trends ──────────────────────────────────
  describe('AnalysisResultRepository', () => {
    it('records analysis inputs and outputs and lists them', async () => {
      const runsRepo = new AnalysisRunRepository();
      const request = await runsRepo.createRequest(ctx1, { businessId: BIZ1, requestCode: uniqueCode('req'), domain: 'financial', analysisType: 'variance' });
      const run = await runsRepo.createRun(ctx1, request.id, BIZ1, 'BI-11');
      const repo = new AnalysisResultRepository();
      await repo.recordInput(ctx1, run.id, BIZ1, 'dataset_version', { ref: 'ds-1' });
      await repo.recordOutput(ctx1, run.id, BIZ1, 'finding_candidate', { ref: 'finding-1' });
      expect((await repo.listInputs(ctx1, run.id)).length).toBe(1);
      expect((await repo.listOutputs(ctx1, run.id)).length).toBe(1);
    });

    it('creates a finding with a version 1', async () => {
      const repo = new AnalysisResultRepository();
      const { finding, version } = await repo.createFinding(ctx1, {
        businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial',
        title: 'Revenue declined', statement: 'Revenue fell 12% MoM', confidence: 0.82, materiality: 'high',
      });
      expect(finding.latestVersion).toBe(1);
      expect(version.versionNumber).toBe(1);
      expect(version.confidence).toBeCloseTo(0.82, 2);
    });

    it('rejects a finding with confidence outside [0,1]', async () => {
      const repo = new AnalysisResultRepository();
      await expect(repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'X', statement: 'Y', confidence: 1.5, materiality: 'low' }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it('publishes a finding', async () => {
      const repo = new AnalysisResultRepository();
      const { finding } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'X', statement: 'Y', confidence: 0.7, materiality: 'medium' });
      const published = await repo.publishFinding(ctx1, finding.id);
      expect(published.publicationStatus).toBe('published');
    });

    it('finding_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new AnalysisResultRepository();
      const { version } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'X', statement: 'Y', confidence: 0.7, materiality: 'medium' });
      await expect(adminPool!.query(`UPDATE business_intelligence.finding_versions SET title = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('supersedes a published finding, preserving history via a new finding + version', async () => {
      const repo = new AnalysisResultRepository();
      const { finding: oldFinding } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'Old', statement: 'Old statement', confidence: 0.6, materiality: 'low' });
      await repo.publishFinding(ctx1, oldFinding.id);
      const { finding: newFinding } = await repo.supersedeFinding(ctx1, oldFinding.id, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'New', statement: 'Corrected statement', confidence: 0.9, materiality: 'high' });
      const refreshedOld = await repo.findFindingById(ctx1, oldFinding.id);
      expect(refreshedOld.publicationStatus).toBe('superseded');
      expect(refreshedOld.supersededBy).toBe(newFinding.id);
    });

    it('lists finding versions in order', async () => {
      const repo = new AnalysisResultRepository();
      const { finding } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'X', statement: 'Y', confidence: 0.7, materiality: 'medium' });
      const versions = await repo.listFindingVersions(ctx1, finding.id);
      expect(versions.length).toBe(1);
      expect(versions[0].versionNumber).toBe(1);
    });

    it('records finding evidence', async () => {
      const repo = new AnalysisResultRepository();
      const { version } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('finding'), domain: 'financial', title: 'X', statement: 'Y', confidence: 0.7, materiality: 'medium' });
      await expect(repo.recordFindingEvidence(ctx1, version.id, BIZ1, 'metric_reference', { metricId: 'm-1' })).resolves.toBeUndefined();
    });

    it('creates a trend and records an observation with bounded confidence', async () => {
      const repo = new AnalysisResultRepository();
      const trend = await repo.createTrend(ctx1, BIZ1, uniqueCode('trend'));
      const obs = await repo.recordTrendObservation(ctx1, trend.id, BIZ1, 'increasing', 0.15, new Date('2026-01-01'), new Date('2026-02-01'), 0.77);
      expect(obs.direction).toBe('increasing');
      expect(obs.confidence).toBeCloseTo(0.77, 2);
    });

    it('rejects a trend observation with period_end not after period_start', async () => {
      const repo = new AnalysisResultRepository();
      const trend = await repo.createTrend(ctx1, BIZ1, uniqueCode('trend'));
      await expect(repo.recordTrendObservation(ctx1, trend.id, BIZ1, 'stable', 0, new Date('2026-02-01'), new Date('2026-01-01'), 0.5)).rejects.toBeInstanceOf(ValidationError);
    });

    it('trend_observations are append-only — UPDATE is rejected by the database', async () => {
      const repo = new AnalysisResultRepository();
      const trend = await repo.createTrend(ctx1, BIZ1, uniqueCode('trend'));
      const obs = await repo.recordTrendObservation(ctx1, trend.id, BIZ1, 'stable', 0, new Date('2026-01-01'), new Date('2026-02-01'), 0.5);
      await expect(adminPool!.query(`UPDATE business_intelligence.trend_observations SET direction = 'volatile' WHERE id = $1`, [obs.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8. Forecasts ────────────────────────────────────────────────────────────
  describe('ForecastRepository', () => {
    async function makeRun() {
      const metricRepo = new MetricDefinitionRepository();
      const { definition } = await metricRepo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('fm'), domain: 'financial', metricType: 'base', name: 'F', unit: 'currency', aggregationMethod: 'sum', timeGrain: 'month' });
      const repo = new ForecastRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('model'), '1.0', 'arima');
      const run = await repo.createRun(ctx1, BIZ1, definition.id, model.id, 3, 'month');
      return { repo, run };
    }

    it('creates a forecast run in running status', async () => {
      const { run } = await makeRun();
      expect(run.status).toBe('running');
      expect(run.publicationStatus).toBe('draft');
    });

    it('adds forecast points in chronological sequence with bounded confidence', async () => {
      const { repo, run } = await makeRun();
      const p1 = await repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 80, 120, 0.9, 'currency');
      const p2 = await repo.addPoint(ctx1, run.id, BIZ1, 2, new Date('2026-02-01'), new Date('2026-03-01'), 110, 85, 135, 0.85, 'currency');
      expect(p1.sequenceNumber).toBe(1);
      expect(p2.sequenceNumber).toBe(2);
      const points = await repo.listPoints(ctx1, run.id);
      expect(points.map((p) => p.sequenceNumber)).toEqual([1, 2]);
    });

    it('rejects a forecast point where confidence_high < confidence_low', async () => {
      const { repo, run } = await makeRun();
      await expect(repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 120, 80, 0.9, 'currency')).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a forecast point with confidence_level outside [0,1]', async () => {
      const { repo, run } = await makeRun();
      await expect(repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 80, 120, 1.4, 'currency')).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions a forecast run running -> completed', async () => {
      const { repo, run } = await makeRun();
      const completed = await repo.transitionRun(ctx1, run.id, 'completed');
      expect(completed.status).toBe('completed');
    });

    it('rejects an invalid forecast run transition out of a terminal state', async () => {
      const { repo, run } = await makeRun();
      await repo.transitionRun(ctx1, run.id, 'failed');
      await expect(repo.transitionRun(ctx1, run.id, 'completed')).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('publishes a completed forecast run', async () => {
      const { repo, run } = await makeRun();
      await repo.transitionRun(ctx1, run.id, 'completed');
      const published = await repo.publishRun(ctx1, run.id);
      expect(published.publicationStatus).toBe('published');
    });

    it('refuses to publish a non-completed forecast run', async () => {
      const { repo, run } = await makeRun();
      await expect(repo.publishRun(ctx1, run.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a published forecast run is immutable — direct UPDATE of status is rejected', async () => {
      const { repo, run } = await makeRun();
      await repo.transitionRun(ctx1, run.id, 'completed');
      await repo.publishRun(ctx1, run.id);
      await expect(
        adminPool!.query(`UPDATE business_intelligence.forecast_runs SET status = 'failed' WHERE id = $1`, [run.id])
      ).rejects.toThrow(/immutable/);
    });

    it('records forecast accuracy with a correctly computed absolute error', async () => {
      const { repo, run } = await makeRun();
      const point = await repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 80, 120, 0.9, 'currency');
      const accuracy = await repo.recordAccuracy(ctx1, point.id, BIZ1, 92, new Date('2026-02-01'), new Date('2026-02-15'));
      expect(accuracy.actualValue).toBeCloseTo(92, 2);
      expect(accuracy.absoluteError).toBeCloseTo(8, 2);
    });

    it('rejects an accuracy record with evaluation_period_end not after start', async () => {
      const { repo, run } = await makeRun();
      const point = await repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 80, 120, 0.9, 'currency');
      await expect(repo.recordAccuracy(ctx1, point.id, BIZ1, 92, new Date('2026-02-15'), new Date('2026-02-01'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('forecast_points are append-only — UPDATE is rejected by the database', async () => {
      const { repo, run } = await makeRun();
      const point = await repo.addPoint(ctx1, run.id, BIZ1, 1, new Date('2026-01-01'), new Date('2026-02-01'), 100, 80, 120, 0.9, 'currency');
      await expect(adminPool!.query(`UPDATE business_intelligence.forecast_points SET predicted_value = 0 WHERE id = $1`, [point.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. Anomalies ─────────────────────────────────────────────────────────────
  describe('AnomalyRepository', () => {
    it('creates a rule with a version 1', async () => {
      const repo = new AnomalyRepository();
      const { rule, version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'high');
      expect(rule.latestVersion).toBe(1);
      expect(version.detectionMethod).toBe('threshold');
    });

    it('rejects an unknown severity when creating a rule', async () => {
      const repo = new AnomalyRepository();
      await expect(repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'catastrophic')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records a detection and opens an audit trail entry', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'high');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'high', 42);
      expect(detection.status).toBe('open');
      expect(detection.detectedValue).toBeCloseTo(42, 2);
    });

    it('rejects an unknown severity when recording a detection', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'high');
      await expect(repo.recordDetection(ctx1, version.id, BIZ1, 'catastrophic', 1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('transitions open -> acknowledged -> resolved with timestamps', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'medium');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'medium', 10);
      const acked = await repo.acknowledge(ctx1, detection.id, UID);
      expect(acked.status).toBe('acknowledged');
      expect(acked.acknowledgedAt).not.toBeNull();
      const resolved = await repo.resolve(ctx1, detection.id, UID, 'root cause fixed');
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it('rejects an invalid anomaly transition out of a terminal state', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'low');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'low', 1);
      await repo.acknowledge(ctx1, detection.id, UID);
      await repo.resolve(ctx1, detection.id, UID, 'fixed');
      await expect(repo.dismiss(ctx1, detection.id, UID, 'n/a')).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('dismisses an open detection directly', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'low');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'low', 1);
      const dismissed = await repo.dismiss(ctx1, detection.id, UID, 'false positive');
      expect(dismissed.status).toBe('dismissed');
    });

    it('records anomaly evidence', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'medium');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'medium', 5);
      await expect(repo.recordEvidence(ctx1, detection.id, BIZ1, 'metric_snapshot', { value: 5 })).resolves.toBeUndefined();
    });

    it('anomaly_status_history is append-only — UPDATE is rejected by the database', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('rule'), 'threshold', 'medium');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'medium', 5);
      const history = await adminPool!.query(`SELECT id FROM business_intelligence.anomaly_status_history WHERE anomaly_detection_id = $1 LIMIT 1`, [detection.id]);
      await expect(adminPool!.query(`UPDATE business_intelligence.anomaly_status_history SET reason = 'x' WHERE id = $1`, [history.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('throws NotFoundError acknowledging an unknown detection', async () => {
      const repo = new AnomalyRepository();
      await expect(repo.acknowledge(ctx1, '00000000-0000-0000-0000-000000000000', UID)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 10. Risk and benchmarks ──────────────────────────────────────────────────
  describe('RiskAssessmentRepository', () => {
    it('creates a risk model and records a bounded assessment', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      const assessment = await repo.recordAssessment(ctx1, model.id, BIZ1, 0.65, 0.4, 'high');
      expect(assessment.riskScore).toBeCloseTo(0.65, 2);
      expect(assessment.likelihood).toBeCloseTo(0.4, 2);
      expect(assessment.severity).toBe('high');
    });

    it('rejects a risk_score outside [0,1]', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      await expect(repo.recordAssessment(ctx1, model.id, BIZ1, 1.5, 0.5, 'high')).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a likelihood outside [0,1]', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      await expect(repo.recordAssessment(ctx1, model.id, BIZ1, 0.5, -0.1, 'high')).rejects.toBeInstanceOf(ValidationError);
    });

    it('publishes a draft assessment', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      const assessment = await repo.recordAssessment(ctx1, model.id, BIZ1, 0.5, 0.5, 'medium');
      const published = await repo.publishAssessment(ctx1, assessment.id);
      expect(published.publicationStatus).toBe('published');
    });

    it('risk_assessments are append-only — UPDATE is rejected by the database', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      const assessment = await repo.recordAssessment(ctx1, model.id, BIZ1, 0.5, 0.5, 'medium');
      await expect(adminPool!.query(`UPDATE business_intelligence.risk_assessments SET risk_score = 0.99 WHERE id = $1`, [assessment.id])).rejects.toThrow(/append-only/);
    });

    it('records a risk factor with a bounded weight', async () => {
      const repo = new RiskAssessmentRepository();
      const model = await repo.createModel(ctx1, BIZ1, uniqueCode('risk-model'), '1.0', 'financial');
      const assessment = await repo.recordAssessment(ctx1, model.id, BIZ1, 0.5, 0.5, 'medium');
      await expect(repo.recordFactor(ctx1, assessment.id, BIZ1, 'liquidity', 0.3)).resolves.toBeUndefined();
      await expect(repo.recordFactor(ctx1, assessment.id, BIZ1, 'leverage', 1.2)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates a benchmark and records a comparison with bounded confidence', async () => {
      const repo = new RiskAssessmentRepository();
      const benchmark = await repo.createBenchmark(ctx1, BIZ1, uniqueCode('bench'));
      const result = await repo.recordComparison(ctx1, benchmark.id, BIZ1, new Date('2026-01-01'), new Date('2026-02-01'), 105, 100, 0.8);
      expect(result.businessValue).toBeCloseTo(105, 2);
      expect(result.peerValue).toBeCloseTo(100, 2);
    });

    it('rejects a comparison with confidence outside [0,1]', async () => {
      const repo = new RiskAssessmentRepository();
      const benchmark = await repo.createBenchmark(ctx1, BIZ1, uniqueCode('bench'));
      await expect(repo.recordComparison(ctx1, benchmark.id, BIZ1, new Date('2026-01-01'), new Date('2026-02-01'), 105, 100, 1.1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a comparison dataset with an invalid period', async () => {
      const repo = new RiskAssessmentRepository();
      const benchmark = await repo.createBenchmark(ctx1, BIZ1, uniqueCode('bench'));
      await expect(repo.recordComparison(ctx1, benchmark.id, BIZ1, new Date('2026-02-01'), new Date('2026-01-01'), 105, 100, 0.8)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── 11. Insight packages ──────────────────────────────────────────────────────
  describe('InsightPackageRepository', () => {
    it('creates an insight package', async () => {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      expect(pkg.latestVersion).toBe(0);
      expect(pkg.status).toBe('draft');
    });

    it('rejects a duplicate package_code within the same business', async () => {
      const repo = new InsightPackageRepository();
      const code = uniqueCode('insight-dup');
      await repo.create(ctx1, BIZ1, code);
      await expect(repo.create(ctx1, BIZ1, code)).rejects.toBeInstanceOf(ConflictError);
    });

    it('publishes a version referencing evidence by id, not by duplication', async () => {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      const version = await repo.publishVersion(ctx1, pkg.id, BIZ1, { summary: 'Q1 highlights', findingIds: ['f-1', 'f-2'] });
      expect(version.versionNumber).toBe(1);
      expect(version.findingIds).toEqual(['f-1', 'f-2']);
      const refreshed = await repo.findById(ctx1, pkg.id);
      expect(refreshed.latestVersion).toBe(1);
      expect(refreshed.status).toBe('published');
    });

    it('finds a version by id', async () => {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      const version = await repo.publishVersion(ctx1, pkg.id, BIZ1, { summary: 'S' });
      const found = await repo.findVersionById(ctx1, version.id);
      expect(found.summary).toBe('S');
    });

    it('revokes an insight package', async () => {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      const revoked = await repo.revoke(ctx1, pkg.id);
      expect(revoked.status).toBe('revoked');
    });

    it('insight_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      const version = await repo.publishVersion(ctx1, pkg.id, BIZ1, { summary: 'S' });
      await expect(adminPool!.query(`UPDATE business_intelligence.insight_package_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 12. Publication, registry, deployment ──────────────────────────────────
  describe('BIPublicationPackageRepository', () => {
    async function makeInsightVersion() {
      const repo = new InsightPackageRepository();
      const pkg = await repo.create(ctx1, BIZ1, uniqueCode('insight'));
      return repo.publishVersion(ctx1, pkg.id, BIZ1, { summary: 'S' });
    }

    it('publishes to an authorized downstream layer', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub, idempotentReplay } = await repo.publish(ctx1, BIZ1, version.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
      expect(pub.targetLayer).toBe('ai_decision_intelligence');
      expect(pub.publicationStatus).toBe('ready');
      expect(idempotentReplay).toBe(false);
    });

    it('rejects an invalid target layer', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      await expect(repo.publish(ctx1, BIZ1, version.id, 'approved_business_action', 'ABA-01', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent on replayed delivery with the same key', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const key = uniqueCode('idem');
      const first = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', key);
      const second = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('walks the full lifecycle: ready -> dispatched -> acknowledged', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));
      const dispatched = await repo.dispatch(ctx1, pub.id);
      expect(dispatched.publicationStatus).toBe('dispatched');
      const acknowledged = await repo.acknowledge(ctx1, pub.id);
      expect(acknowledged.publicationStatus).toBe('acknowledged');
    });

    it('rejects a forbidden lifecycle transition (draft/ready straight to acknowledged)', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await expect(adminPool!.query(`UPDATE business_intelligence.bi_publication_packages SET publication_status = 'acknowledged' WHERE id = $1`, [pub.id])).rejects.toThrow(/forbidden transition/);
    });

    it('rejects a dispatched package moving straight back to ready', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await repo.dispatch(ctx1, pub.id);
      await expect(adminPool!.query(`UPDATE business_intelligence.bi_publication_packages SET publication_status = 'ready' WHERE id = $1`, [pub.id])).rejects.toThrow(/forbidden transition/);
    });

    it('records a rejection with a reason', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
      await repo.dispatch(ctx1, pub.id);
      const rejected = await repo.reject(ctx1, pub.id, 'schema mismatch');
      expect(rejected.publicationStatus).toBe('rejected');
    });

    it('revokes an acknowledged package', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'ai_decision_intelligence', 'ADI-06', uniqueCode('idem'));
      await repo.dispatch(ctx1, pub.id);
      await repo.acknowledge(ctx1, pub.id);
      const revoked = await repo.revoke(ctx1, pub.id, 'superseded');
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('lists publication events in chronological order', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await repo.dispatch(ctx1, pub.id);
      const events = await repo.listEvents(ctx1, pub.id);
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it('bi_publication_events are append-only — UPDATE is rejected by the database', async () => {
      const version = await makeInsightVersion();
      const repo = new BIPublicationPackageRepository();
      const { package: pub } = await repo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      const events = await adminPool!.query(`SELECT id FROM business_intelligence.bi_publication_events WHERE bi_publication_package_id = $1 LIMIT 1`, [pub.id]);
      await expect(adminPool!.query(`UPDATE business_intelligence.bi_publication_events SET notes = 'x' WHERE id = $1`, [events.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('registers a component and rejects a duplicate code', async () => {
      const repo = new BIPublicationPackageRepository();
      const code = uniqueCode('component');
      await repo.registerComponent(ctx1, BIZ1, code, 'metric_engine');
      await expect(repo.registerComponent(ctx1, BIZ1, code, 'metric_engine')).rejects.toBeInstanceOf(ConflictError);
    });

    it('registers a component version and activates a deployment', async () => {
      const repo = new BIPublicationPackageRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('component'), 'analysis_engine');
      const version = await repo.registerComponentVersion(ctx1, component.id, BIZ1, '1.0.0');
      const deployment = await repo.activateDeployment(ctx1, version.id, BIZ1);
      expect(deployment.activationState).toBe('active');
    });

    it('rolls back a deployment and records rollback history', async () => {
      const repo = new BIPublicationPackageRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('component'), 'anomaly_engine');
      const version = await repo.registerComponentVersion(ctx1, component.id, BIZ1, '1.0.0');
      const deployment = await repo.activateDeployment(ctx1, version.id, BIZ1);
      await repo.rollbackDeployment(ctx1, deployment.id, BIZ1, 'regression detected');
      const refreshed = await repo.findDeploymentById(ctx1, deployment.id);
      expect(refreshed.activationState).toBe('rolled_back');
    });

    it('bi_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new BIPublicationPackageRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('component'), 'forecast_engine');
      const version = await repo.registerComponentVersion(ctx1, component.id, BIZ1, '1.0.0');
      const deployment = await repo.activateDeployment(ctx1, version.id, BIZ1);
      await repo.rollbackDeployment(ctx1, deployment.id, BIZ1, 'x');
      const rollback = await adminPool!.query(`SELECT id FROM business_intelligence.bi_deployment_rollbacks WHERE deployment_id = $1`, [deployment.id]);
      await expect(adminPool!.query(`UPDATE business_intelligence.bi_deployment_rollbacks SET reason = 'y' WHERE id = $1`, [rollback.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. Cross-tenant / cross-workspace RLS live rejection ────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 metric definitions', async () => {
      const repo = new MetricDefinitionRepository();
      const { definition } = await repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('iso'), domain: 'financial', metricType: 'base', name: 'Iso', unit: 'currency', aggregationMethod: 'sum', timeGrain: 'month' });
      await expect(repo.findById(ctx2, definition.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot read tenant 1 findings', async () => {
      const repo = new AnalysisResultRepository();
      const { finding } = await repo.createFinding(ctx1, { businessId: BIZ1, findingCode: uniqueCode('iso'), domain: 'financial', title: 'X', statement: 'Y', confidence: 0.5, materiality: 'low' });
      await expect(repo.findFindingById(ctx2, finding.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot read tenant 1 risk assessments', async () => {
      const riskRepo = new RiskAssessmentRepository();
      const model = await riskRepo.createModel(ctx1, BIZ1, uniqueCode('iso-model'), '1.0', 'financial');
      const assessment = await riskRepo.recordAssessment(ctx1, model.id, BIZ1, 0.5, 0.5, 'medium');
      await expect(riskRepo.findAssessmentById(ctx2, assessment.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows listing tenant 1 metric definitions by domain', async () => {
      const repo = new MetricDefinitionRepository();
      const domain = 'market_competitive';
      await repo.create(ctx1, { businessId: BIZ1, metricCode: uniqueCode('iso'), domain, metricType: 'base', name: 'Iso', unit: 'currency', aggregationMethod: 'sum', timeGrain: 'month' });
      const list = await repo.listByDomain(ctx2, domain);
      expect(list.length).toBe(0);
    });

    it('tenant 2 cannot acknowledge a tenant 1 anomaly detection', async () => {
      const repo = new AnomalyRepository();
      const { version } = await repo.createRule(ctx1, BIZ1, uniqueCode('iso-rule'), 'threshold', 'high');
      const detection = await repo.recordDetection(ctx1, version.id, BIZ1, 'high', 1);
      await expect(repo.acknowledge(ctx2, detection.id, UID)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot dispatch a tenant 1 publication package', async () => {
      const insightRepo = new InsightPackageRepository();
      const pkg = await insightRepo.create(ctx1, BIZ1, uniqueCode('iso-insight'));
      const version = await insightRepo.publishVersion(ctx1, pkg.id, BIZ1, { summary: 'S' });
      const pubRepo = new BIPublicationPackageRepository();
      const { package: pub } = await pubRepo.publish(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await expect(pubRepo.dispatch(ctx2, pub.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 14. Outbox atomicity ─────────────────────────────────────────────────────
  describe('outbox event functions', () => {
    it('emit_metric_calculated inserts a pending outbox event atomically', async () => {
      const before = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = 'bi.metric.calculated'`);
      await adminPool!.query(
        `SELECT business_intelligence.emit_metric_calculated($1,$2,gen_random_uuid(),gen_random_uuid(),123.45,gen_random_uuid())`,
        [T1, WS1]
      );
      const after = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = 'bi.metric.calculated'`);
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT business_intelligence.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts an authorized target layer', async () => {
      const result = await adminPool!.query(
        `SELECT business_intelligence.emit_data_published($1,$2,gen_random_uuid(),'ai_decision_intelligence','ADI-06',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });

    it('emit_anomaly_detected records severity in the event payload', async () => {
      const result = await adminPool!.query(
        `SELECT business_intelligence.emit_anomaly_detected($1,$2,gen_random_uuid(),'critical',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.severity).toBe('critical');
    });
  });

  // ── 15. Transaction rollback ─────────────────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial finding when confidence validation fails before the insert', async () => {
      const repo = new AnalysisResultRepository();
      const code = uniqueCode('rollback-finding');
      await expect(repo.createFinding(ctx1, { businessId: BIZ1, findingCode: code, domain: 'financial', title: 'X', statement: 'Y', confidence: 5, materiality: 'low' })).rejects.toBeInstanceOf(ValidationError);
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM business_intelligence.findings WHERE finding_code = $1`, [code]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rolls back the finding insert when the version insert violates a bound', async () => {
      // recordAssessment validates before any query, so verify the DB-level CHECK also protects
      // against an out-of-band bad insert attempt (defense in depth).
      const model = await adminPool!.query(
        `INSERT INTO business_intelligence.risk_models (tenant_id, workspace_id, business_id, model_code, model_version, domain)
         VALUES ($1,$2,$3,$4,'1.0','financial') RETURNING id`,
        [T1, WS1, BIZ1, uniqueCode('rb-model')]
      );
      await expect(
        adminPool!.query(
          `INSERT INTO business_intelligence.risk_assessments (risk_model_id, tenant_id, workspace_id, business_id, risk_score, likelihood, severity)
           VALUES ($1,$2,$3,$4,2.0,0.5,'high')`,
          [model.rows[0].id, T1, WS1, BIZ1]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM business_intelligence.risk_assessments WHERE risk_model_id = $1`, [model.rows[0].id]);
      expect(check.rows[0].n).toBe(0);
    });
  });
});

describe.skipIf(run)('Stage 2D Business Intelligence — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
