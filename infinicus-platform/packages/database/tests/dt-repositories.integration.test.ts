/**
 * Live PostgreSQL 16 integration tests for Stage 2E Business Digital Twin
 * persistence (BUILD-12).
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
  DTIntakeRepository,
  DigitalTwinDefinitionRepository,
  DigitalTwinInstanceRepository,
  DigitalTwinSnapshotRepository,
  StateVariableRepository,
  TwinEntityRepository,
  TwinAssumptionConstraintRepository,
  TwinCalibrationRepository,
  TwinValidationRepository,
  ScenarioBaselineRepository,
  DTPublicationPackageRepository,
  DTComponentRegistryRepository,
  NotFoundError,
  ConflictError,
  ValidationError,
  InvalidTransitionError,
  DigitalTwinDefinitionStateConflictError,
  DigitalTwinSnapshotStateConflictError,
  DigitalTwinSnapshotImmutableError,
  TwinCalibrationStateConflictError,
  TwinValidationStateConflictError,
  ScenarioBaselineStateConflictError,
  ScenarioBaselineValidationError,
} from '../src/repositories/dt/index.js';
import { InsightPackageRepository, BIPublicationPackageRepository } from '../src/repositories/bi/index.js';

const run = !!process.env.DATABASE_URL;

const T1  = '33333333-d1d1-0000-0000-000000000001';
const WS1 = '33333333-d1d1-0000-0000-000000000002';
const T2  = '33333333-d1d1-0000-0000-000000000003';
const WS2 = '33333333-d1d1-0000-0000-000000000004';
const UID = '33333333-d1d1-0000-0000-000000000099';
const BIZ1 = '33333333-d2d2-0000-0000-000000000001';
const BIZ2 = '33333333-d2d2-0000-0000-000000000002';

const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Inserts a fresh BI publication package fixture targeting business_digital_twin (real upstream FK target) and returns its id. */
async function createBiPackage(tenantId: string, workspaceId: string, businessId: string): Promise<string> {
  const insightRepo = new InsightPackageRepository();
  const pubRepo = new BIPublicationPackageRepository();
  const ctx = { tenantId, workspaceId, userId: UID };
  const pkg = await insightRepo.create(ctx, businessId, uniqueCode('insight'));
  const version = await insightRepo.publishVersion(ctx, pkg.id, businessId, { summary: 'DT intake fixture' });
  const { package: pub } = await pubRepo.publish(ctx, businessId, version.id, 'business_digital_twin', 'DT-01', uniqueCode('idem'));
  return pub.id;
}

async function setupDTIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'DT-Test Tenant 1','dt-t1','active','test'),
            ($2,'DT-Test Tenant 2','dt-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'DT-Test WS 1','dt-ws1','active'),
            ($3,$4,'DT-Test WS 2','dt-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,$3,'DT Test Biz 1','dt-biz1','active'),
            ($4,$5,$6,'DT Test Biz 2','dt-biz2','active')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ1, T1, WS1, BIZ2, T2, WS2]
  );
  await adminPool.query(
    `INSERT INTO identity.users (id, email, status)
     VALUES ($1,'dt-test-user@example.test','active')
     ON CONFLICT (id) DO NOTHING`,
    [UID]
  );
}

/**
 * Append-only DT tables reject DELETE unconditionally (business_digital_twin
 * .forbid_mutation trigger, migration 0062) — even for the BYPASSRLS admin
 * role, and every such table FK-RESTRICTs up through tenant/business rows.
 * The disposable test database is the reset mechanism, not per-suite teardown.
 */
async function teardownDTIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
  }
  await closePool();
}

async function makeDefinitionAndInstance(ctx: typeof ctx1, businessId: string) {
  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, businessId, uniqueCode('def'), 'Test Definition');
  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, businessId, definition.id, uniqueCode('inst'));
  return { defRepo, definition, instRepo, instance };
}

describe.runIf(run)('Stage 2E Business Digital Twin — live PostgreSQL', () => {
  beforeAll(setupDTIntegration);
  afterAll(teardownDTIntegration);

  // ── 1. Schema and security posture sanity ─────────────────────────────────
  describe('schema and RLS posture', () => {
    it('business_digital_twin schema exists with 51 tables', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'business_digital_twin'`
      );
      expect(result.rows[0].n).toBe(52); // 51 Stage 2E tables + dt_handoff_envelopes (migration 0221, NEW-BDT-SIM-01.SEC-01)
    });

    it('every DT table has RLS enabled and forced', async () => {
      const result = await adminPool!.query(
        `SELECT count(*)::int AS n FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
         WHERE t.schemaname = 'business_digital_twin' AND c.relrowsecurity AND c.relforcerowsecurity`
      );
      expect(result.rows[0].n).toBe(52); // 51 Stage 2E tables + dt_handoff_envelopes (migration 0221, NEW-BDT-SIM-01.SEC-01)
    });

    it('fails closed with no tenant context set (app_test_user, RLS enforced)', async () => {
      const { getPool } = await import('../src/client.js');
      const result = await getPool().query('SELECT count(*)::int AS n FROM business_digital_twin.digital_twin_definitions');
      expect(result.rows[0].n).toBe(0);
    });
  });

  // ── 2. DTIntakeRepository ──────────────────────────────────────────────────
  describe('DTIntakeRepository', () => {
    it('receives a valid BI publication package', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg, idempotentReplay } = await repo.receivePackage(ctx1, {
        businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem'),
      });
      expect(pkg.status).toBe('received');
      expect(pkg.biPublicationPackageId).toBe(biPkg);
      expect(idempotentReplay).toBe(false);
    });

    it('is idempotent on repeated delivery of the same BI package', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('preserves upstream lineage — biPublicationPackageId is exact', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T2, WS2, BIZ2);
      const { package: pkg } = await repo.receivePackage(ctx2, { businessId: BIZ2, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const found = await repo.getById(ctx2, pkg.id);
      expect(found.biPublicationPackageId).toBe(biPkg);
    });

    it('transitions received -> accepted -> processing -> completed', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const accepted = await repo.acceptPackage(ctx1, pkg.id);
      expect(accepted.status).toBe('accepted');
      const processing = await repo.markProcessing(ctx1, pkg.id);
      expect(processing.status).toBe('processing');
      const completed = await repo.completePackage(ctx1, pkg.id);
      expect(completed.status).toBe('completed');
    });

    it('rejects an unknown target status at the database CHECK constraint', async () => {
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const repo = new DTIntakeRepository();
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_intake_packages SET status = 'not_a_real_status' WHERE id = $1`, [pkg.id])).rejects.toThrow();
    });

    it('records a rejection reason when rejected', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const rejected = await repo.rejectPackage(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('schema mismatch');
    });

    it('records a failure reason when failed', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const failed = await repo.failPackage(ctx1, pkg.id, 'downstream error');
      expect(failed.status).toBe('failed');
    });

    it('throws NotFoundError for an unknown intake package id', async () => {
      const repo = new DTIntakeRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('finds an intake package by its source BI publication package', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const found = await repo.getBySourcePackage(ctx1, BIZ1, biPkg);
      expect(found.id).toBe(pkg.id);
    });

    it('rejects cross-tenant intake package reads', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      await expect(repo.getById(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('dt_intake_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new DTIntakeRepository();
      const biPkg = await createBiPackage(T1, WS1, BIZ1);
      const { package: pkg } = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg, intakeCode: uniqueCode('intake'), idempotencyKey: uniqueCode('idem') });
      const versionRow = await adminPool!.query(
        `INSERT INTO business_digital_twin.dt_intake_package_versions (intake_package_id, tenant_id, workspace_id, business_id, version_number, correlation_id)
         VALUES ($1,$2,$3,$4,1,gen_random_uuid()) RETURNING id`,
        [pkg.id, T1, WS1, BIZ1]
      );
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_intake_package_versions SET record_count = 999 WHERE id = $1`, [versionRow.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 3. DigitalTwinDefinitionRepository ─────────────────────────────────────
  describe('DigitalTwinDefinitionRepository', () => {
    it('creates a definition in draft status', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def'), 'Definition A');
      expect(def.status).toBe('draft');
      expect(def.latestVersion).toBe(0);
    });

    it('creates a version and bumps latestVersion', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-v'), 'Definition B');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, { fields: ['revenue'] });
      expect(version.versionNumber).toBe(1);
      expect(version.status).toBe('draft');
    });

    it('validates a version', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-val'), 'Definition C');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      const validated = await repo.validateVersion(ctx1, version.id);
      expect(validated.status).toBe('validated');
    });

    it('activates a validated version', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-act'), 'Definition D');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      await repo.validateVersion(ctx1, version.id);
      const activated = await repo.activateVersion(ctx1, version.id);
      expect(activated.status).toBe('active');
    });

    it('rejects activating a version that was never validated', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-noval'), 'Definition E');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      await expect(repo.activateVersion(ctx1, version.id)).rejects.toBeInstanceOf(DigitalTwinDefinitionStateConflictError);
    });

    it('supersedes a version', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-sup'), 'Definition F');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      const superseded = await repo.supersedeVersion(ctx1, version.id);
      expect(superseded.status).toBe('superseded');
    });

    it('gets the active version for a definition', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-getact'), 'Definition G');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      await repo.validateVersion(ctx1, version.id);
      await repo.activateVersion(ctx1, version.id);
      const active = await repo.getActiveVersion(ctx1, def.id);
      expect(active.id).toBe(version.id);
    });

    it('throws NotFoundError when no active version exists', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-noact'), 'Definition H');
      await expect(repo.getActiveVersion(ctx1, def.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('digital_twin_definition_versions reject reverting an active version to draft', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-immut'), 'Definition I');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      await repo.validateVersion(ctx1, version.id);
      await repo.activateVersion(ctx1, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_definition_versions SET status = 'draft' WHERE id = $1`, [version.id])).rejects.toThrow(/cannot revert to draft/);
    });

    it('digital_twin_definitions reject reverting active/retired to draft', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('def-revert'), 'Definition J');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, {});
      await repo.validateVersion(ctx1, version.id);
      await repo.activateVersion(ctx1, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_definitions SET status = 'draft' WHERE id = $1`, [def.id])).rejects.toThrow(/cannot revert to draft/);
    });
  });

  // ── 4. DigitalTwinInstanceRepository ───────────────────────────────────────
  describe('DigitalTwinInstanceRepository', () => {
    it('creates an instance in initializing status', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      expect(instance.status).toBe('initializing');
      expect(instance.latestVersion).toBe(0);
    });

    it('creates a version and bumps latestVersion', async () => {
      const { instRepo, instance, defRepo, definition } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const defVersion = await defRepo.createVersion(ctx1, definition.id, BIZ1, {});
      const version = await instRepo.createVersion(ctx1, instance.id, BIZ1, defVersion.id);
      expect(version.versionNumber).toBe(1);
    });

    it('transitions initializing -> active', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const active = await instRepo.transitionStatus(ctx1, instance.id, 'active');
      expect(active.status).toBe('active');
    });

    it('rejects an unknown status transition target', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await expect(instRepo.transitionStatus(ctx1, instance.id, 'not_a_real_status')).rejects.toBeInstanceOf(ValidationError);
    });

    it('finds an instance by id', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const found = await instRepo.getById(ctx1, instance.id);
      expect(found.id).toBe(instance.id);
    });

    it('lists active instances for a business', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await instRepo.transitionStatus(ctx1, instance.id, 'active');
      const list = await instRepo.getActiveForBusiness(ctx1, BIZ1);
      expect(list.some((i) => i.id === instance.id)).toBe(true);
    });

    it('throws NotFoundError for an unknown instance id', async () => {
      const instRepo = new DigitalTwinInstanceRepository();
      await expect(instRepo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('digital_twin_instance_status_history is append-only — UPDATE is rejected by the database', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await instRepo.transitionStatus(ctx1, instance.id, 'active');
      const history = await adminPool!.query(`SELECT id FROM business_digital_twin.digital_twin_instance_status_history WHERE instance_id = $1 LIMIT 1`, [instance.id]);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_instance_status_history SET reason = 'x' WHERE id = $1`, [history.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 5. DigitalTwinSnapshotRepository ───────────────────────────────────────
  describe('DigitalTwinSnapshotRepository', () => {
    async function makeSnapshot() {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new DigitalTwinSnapshotRepository();
      const { snapshot, version } = await repo.createSnapshot(ctx1, BIZ1, instance.id, uniqueCode('snap'), new Date('2026-01-01'), 'Snapshot summary');
      return { repo, instance, snapshot, version };
    }

    it('creates a snapshot header and v1 together', async () => {
      const { snapshot, version } = await makeSnapshot();
      expect(snapshot.status).toBe('draft');
      expect(snapshot.latestVersion).toBe(1);
      expect(version.versionNumber).toBe(1);
    });

    it('adds a value to a snapshot version', async () => {
      const { repo, version } = await makeSnapshot();
      await expect(repo.addValue(ctx1, version.id, 'revenue', 1000)).resolves.toBeUndefined();
    });

    it('adds evidence to a snapshot version', async () => {
      const { repo, version } = await makeSnapshot();
      await expect(repo.addEvidence(ctx1, version.id, 'metric_reference', { metricId: 'm-1' })).resolves.toBeUndefined();
    });

    it('validates a snapshot', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      const validated = await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      expect(validated.status).toBe('validated');
    });

    it('publishes a validated snapshot', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      const published = await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      expect(published.status).toBe('published');
    });

    it('rejects publishing a non-validated snapshot', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await expect(repo.publishSnapshot(ctx1, snapshot.id, version.id)).rejects.toBeInstanceOf(DigitalTwinSnapshotStateConflictError);
    });

    it('rejects re-validating a published snapshot', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      await expect(repo.validateSnapshot(ctx1, snapshot.id, version.id)).rejects.toBeInstanceOf(DigitalTwinSnapshotImmutableError);
    });

    it('supersedes a snapshot before publication', async () => {
      const { repo, snapshot } = await makeSnapshot();
      const superseded = await repo.supersedeSnapshot(ctx1, snapshot.id);
      expect(superseded.status).toBe('superseded');
    });

    it('rejects superseding a published snapshot — immutability', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      await expect(repo.supersedeSnapshot(ctx1, snapshot.id)).rejects.toBeInstanceOf(DigitalTwinSnapshotImmutableError);
    });

    it('a published snapshot is immutable — direct UPDATE of status is rejected', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_snapshots SET status = 'superseded' WHERE id = $1`, [snapshot.id])).rejects.toThrow(/immutable/);
    });

    it('finds a snapshot by id', async () => {
      const { repo, snapshot } = await makeSnapshot();
      const found = await repo.getById(ctx1, snapshot.id);
      expect(found.id).toBe(snapshot.id);
    });

    it('throws NotFoundError for an unknown snapshot id', async () => {
      const repo = new DigitalTwinSnapshotRepository();
      await expect(repo.getById(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lists published snapshots for an instance', async () => {
      const { repo, instance, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      const list = await repo.getPublishedForInstance(ctx1, instance.id);
      expect(list.some((s) => s.id === snapshot.id)).toBe(true);
    });

    it('digital_twin_snapshot_values are append-only — UPDATE is rejected by the database', async () => {
      const { repo, version } = await makeSnapshot();
      await repo.addValue(ctx1, version.id, 'revenue', 1000);
      const row = await adminPool!.query(`SELECT id FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id = $1 LIMIT 1`, [version.id]);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_snapshot_values SET variable_code = 'x' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('digital_twin_snapshot_versions reject a status change once published', async () => {
      const { repo, snapshot, version } = await makeSnapshot();
      await repo.validateSnapshot(ctx1, snapshot.id, version.id);
      await repo.publishSnapshot(ctx1, snapshot.id, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.digital_twin_snapshot_versions SET status = 'superseded' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });
  });

  // ── 6. StateVariableRepository ─────────────────────────────────────────────
  describe('StateVariableRepository', () => {
    it('creates a definition with a valid category and value type', async () => {
      const repo = new StateVariableRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv'), 'Revenue Rate', 'financial', 'currency');
      expect(def.category).toBe('financial');
      expect(def.valueType).toBe('currency');
    });

    it('rejects an unknown category', async () => {
      const repo = new StateVariableRepository();
      await expect(repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-bad'), 'X', 'not_a_category', 'number')).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an unknown value type', async () => {
      const repo = new StateVariableRepository();
      await expect(repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-bad2'), 'X', 'financial', 'not_a_type')).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates a new version and bumps latestVersion', async () => {
      const repo = new StateVariableRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-v'), 'X', 'operational', 'number');
      const version = await repo.createVersion(ctx1, def.id, BIZ1, { precision: 2 });
      expect(version.versionNumber).toBe(1);
    });

    it('records a value for an instance', async () => {
      const repo = new StateVariableRepository();
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-val'), 'X', 'operational', 'number');
      const value = await repo.recordValue(ctx1, def.id, BIZ1, instance.id, 42, new Date('2026-01-01'));
      expect(value.valueJson).toBe(42);
    });

    it('records quality metadata for a value', async () => {
      const repo = new StateVariableRepository();
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-q'), 'X', 'operational', 'number');
      const value = await repo.recordValue(ctx1, def.id, BIZ1, instance.id, 1, new Date());
      await expect(repo.recordQuality(ctx1, value.id, { qualityScore: 0.9 })).resolves.toBeUndefined();
    });

    it('finds a definition by id', async () => {
      const repo = new StateVariableRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-find'), 'Findable', 'customer', 'string');
      const found = await repo.getDefinition(ctx1, def.id);
      expect(found.name).toBe('Findable');
    });

    it('throws NotFoundError for an unknown definition', async () => {
      const repo = new StateVariableRepository();
      await expect(repo.getDefinition(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lists values for a definition and instance in descending order', async () => {
      const repo = new StateVariableRepository();
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-list'), 'X', 'operational', 'number');
      await repo.recordValue(ctx1, def.id, BIZ1, instance.id, 1, new Date('2026-01-01'));
      await repo.recordValue(ctx1, def.id, BIZ1, instance.id, 2, new Date('2026-02-01'));
      const list = await repo.listValues(ctx1, def.id, instance.id);
      expect(list.length).toBe(2);
    });

    it('state_variable_values are append-only — UPDATE is rejected by the database', async () => {
      const repo = new StateVariableRepository();
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('sv-immut'), 'X', 'operational', 'number');
      const value = await repo.recordValue(ctx1, def.id, BIZ1, instance.id, 1, new Date());
      await expect(adminPool!.query(`UPDATE business_digital_twin.state_variable_values SET value_json = '999' WHERE id = $1`, [value.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 7. TwinEntityRepository ─────────────────────────────────────────────────
  describe('TwinEntityRepository', () => {
    it('creates an entity with a valid type', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const entity = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent'), 'customer', 'Acme Corp');
      expect(entity.entityType).toBe('customer');
    });

    it('rejects an unknown entity type', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      await expect(repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-bad'), 'not_a_type', 'X')).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates an entity version', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const entity = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-v'), 'product', 'Widget');
      const version = await repo.createEntityVersion(ctx1, entity.id, BIZ1, { sku: 'W-1' });
      expect(version.versionNumber).toBe(1);
    });

    it('creates a relationship between two entities', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const a = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-a'), 'customer', 'A');
      const b = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-b'), 'product', 'B');
      const rel = await repo.createRelationship(ctx1, BIZ1, instance.id, a.id, b.id, 'purchases');
      expect(rel.relationshipType).toBe('purchases');
    });

    it('creates a relationship version', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const a = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-c'), 'customer', 'C');
      const b = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-d'), 'product', 'D');
      const rel = await repo.createRelationship(ctx1, BIZ1, instance.id, a.id, b.id, 'purchases');
      const version = await repo.createRelationshipVersion(ctx1, rel.id, BIZ1, { frequency: 'monthly' });
      expect(version.versionNumber).toBe(1);
    });

    it('gets the full entity graph for an instance', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const a = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-e'), 'customer', 'E');
      const b = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-f'), 'product', 'F');
      await repo.createRelationship(ctx1, BIZ1, instance.id, a.id, b.id, 'purchases');
      const graph = await repo.getEntityGraph(ctx1, instance.id);
      expect(graph.entities.length).toBeGreaterThanOrEqual(2);
      expect(graph.relationships.length).toBeGreaterThanOrEqual(1);
    });

    it('twin_entity_versions are append-only — UPDATE is rejected by the database', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      const entity = await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('ent-immut'), 'customer', 'G');
      const version = await repo.createEntityVersion(ctx1, entity.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE business_digital_twin.twin_entity_versions SET attributes = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 8. TwinAssumptionConstraintRepository ──────────────────────────────────
  describe('TwinAssumptionConstraintRepository', () => {
    it('creates an assumption with a valid source', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const assumption = await repo.createAssumption(ctx1, BIZ1, instance.id, uniqueCode('asm'), 'declared', 'Growth continues at 5%');
      expect(assumption.source).toBe('declared');
    });

    it('rejects an unknown assumption source', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      await expect(repo.createAssumption(ctx1, BIZ1, instance.id, uniqueCode('asm-bad'), 'not_a_source', 'X')).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates an assumption version', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const assumption = await repo.createAssumption(ctx1, BIZ1, instance.id, uniqueCode('asm-v'), 'observed', 'X');
      const version = await repo.createAssumptionVersion(ctx1, assumption.id, BIZ1, 'Updated statement');
      expect(version.versionNumber).toBe(1);
    });

    it('creates a constraint with a valid operator', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const constraint = await repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns'), 'lte', 1000);
      expect(constraint.operator).toBe('lte');
    });

    it('rejects an unknown constraint operator', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      await expect(repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns-bad'), 'not_an_op', 1)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates a constraint version', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const constraint = await repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns-v'), 'gt', 0);
      const version = await repo.createConstraintVersion(ctx1, constraint.id, BIZ1, 'gte', 1);
      expect(version.versionNumber).toBe(1);
    });

    it('evaluates a constraint', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const constraint = await repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns-eval'), 'gt', 0);
      const evaluation = await repo.evaluateConstraint(ctx1, constraint.id, BIZ1, true, 5);
      expect(evaluation.satisfied).toBe(true);
    });

    it('lists constraint evaluations for a snapshot version', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const snapRepo = new DigitalTwinSnapshotRepository();
      const { version: snapVersion } = await snapRepo.createSnapshot(ctx1, BIZ1, instance.id, uniqueCode('snap-cns'), new Date(), 'S');
      const repo = new TwinAssumptionConstraintRepository();
      const constraint = await repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns-list'), 'gt', 0);
      await repo.evaluateConstraint(ctx1, constraint.id, BIZ1, true, 5, snapVersion.id);
      const list = await repo.listForSnapshot(ctx1, snapVersion.id);
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('twin_constraint_evaluations are append-only — UPDATE is rejected by the database', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinAssumptionConstraintRepository();
      const constraint = await repo.createConstraint(ctx1, BIZ1, instance.id, uniqueCode('cns-immut'), 'gt', 0);
      const evaluation = await repo.evaluateConstraint(ctx1, constraint.id, BIZ1, true, 5);
      await expect(adminPool!.query(`UPDATE business_digital_twin.twin_constraint_evaluations SET satisfied = false WHERE id = $1`, [evaluation.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 9. TwinCalibrationRepository ────────────────────────────────────────────
  describe('TwinCalibrationRepository', () => {
    it('creates a calibration run in requested status', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id, UID);
      expect(run.status).toBe('requested');
    });

    it('adds an input to a calibration run', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await expect(repo.addInput(ctx1, run.id, BIZ1, { ref: 'sv-1' })).resolves.toBeUndefined();
    });

    it('starts a requested run', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      const started = await repo.startRun(ctx1, run.id);
      expect(started.status).toBe('running');
    });

    it('rejects starting a run that is not requested', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await repo.startRun(ctx1, run.id);
      await expect(repo.startRun(ctx1, run.id)).rejects.toBeInstanceOf(TwinCalibrationStateConflictError);
    });

    it('completes a running run with results', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await repo.startRun(ctx1, run.id);
      const completed = await repo.completeRun(ctx1, run.id, BIZ1, [{ adjustedValue: 42, delta: 0.1 }]);
      expect(completed.status).toBe('completed');
    });

    it('rejects completing a run that is not running', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await expect(repo.completeRun(ctx1, run.id, BIZ1, [])).rejects.toBeInstanceOf(TwinCalibrationStateConflictError);
    });

    it('fails a run', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      const failed = await repo.failRun(ctx1, run.id);
      expect(failed.status).toBe('failed');
    });

    it('throws NotFoundError for an unknown calibration run', async () => {
      const repo = new TwinCalibrationRepository();
      await expect(repo.getRun(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('twin_calibration_results are append-only — UPDATE is rejected by the database', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinCalibrationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await repo.startRun(ctx1, run.id);
      await repo.completeRun(ctx1, run.id, BIZ1, [{ adjustedValue: 1 }]);
      const row = await adminPool!.query(`SELECT id FROM business_digital_twin.twin_calibration_results WHERE calibration_run_id = $1 LIMIT 1`, [run.id]);
      await expect(adminPool!.query(`UPDATE business_digital_twin.twin_calibration_results SET delta = 999 WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 10. TwinValidationRepository ────────────────────────────────────────────
  describe('TwinValidationRepository', () => {
    it('creates a validation run in running status', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      expect(run.status).toBe('running');
    });

    it('records a result with a valid outcome', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await expect(repo.recordResult(ctx1, run.id, BIZ1, 'passed', 'all checks passed')).resolves.toBeUndefined();
    });

    it('rejects an unknown outcome when recording a result', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await expect(repo.recordResult(ctx1, run.id, BIZ1, 'not_an_outcome', 'x')).rejects.toBeInstanceOf(ValidationError);
    });

    it('records an issue', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await expect(repo.recordIssue(ctx1, run.id, BIZ1, 'warning', 'DT_STALE_DATA', 'data is stale')).resolves.toBeUndefined();
    });

    it('completes a running run', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      const completed = await repo.completeRun(ctx1, run.id, 'passed');
      expect(completed.status).toBe('completed');
      expect(completed.outcome).toBe('passed');
    });

    it('marks the run failed when outcome is failed', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      const completed = await repo.completeRun(ctx1, run.id, 'failed');
      expect(completed.status).toBe('failed');
    });

    it('rejects completing a run that is not running', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinValidationRepository();
      const run = await repo.createRun(ctx1, BIZ1, instance.id);
      await repo.completeRun(ctx1, run.id, 'passed');
      await expect(repo.completeRun(ctx1, run.id, 'passed')).rejects.toBeInstanceOf(TwinValidationStateConflictError);
    });

    it('throws NotFoundError for an unknown validation run', async () => {
      const repo = new TwinValidationRepository();
      await expect(repo.getRun(ctx1, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── 11. ScenarioBaselineRepository ─────────────────────────────────────────
  describe('ScenarioBaselineRepository', () => {
    async function makeBaseline() {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const snapRepo = new DigitalTwinSnapshotRepository();
      const { snapshot, version: snapVersion } = await snapRepo.createSnapshot(ctx1, BIZ1, instance.id, uniqueCode('snap-base'), new Date(), 'S');
      await snapRepo.validateSnapshot(ctx1, snapshot.id, snapVersion.id);
      await snapRepo.publishSnapshot(ctx1, snapshot.id, snapVersion.id);
      const repo = new ScenarioBaselineRepository();
      const { baseline, version } = await repo.createBaseline(ctx1, BIZ1, instance.id, snapVersion.id, uniqueCode('base'), 'growth scenario');
      return { repo, instance, snapVersion, baseline, version };
    }

    it('creates a baseline header and v1 together', async () => {
      const { baseline, version } = await makeBaseline();
      expect(baseline.status).toBe('draft');
      expect(version.versionNumber).toBe(1);
    });

    it('creates a new version and bumps latestVersion', async () => {
      const { repo, baseline } = await makeBaseline();
      const version = await repo.createVersion(ctx1, baseline.id, BIZ1);
      expect(version.versionNumber).toBe(2);
    });

    it('rejects creating a version once published', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      await repo.publishBaseline(ctx1, baseline.id, version.id);
      await expect(repo.createVersion(ctx1, baseline.id, BIZ1)).rejects.toBeInstanceOf(ScenarioBaselineStateConflictError);
    });

    it('adds an input to a baseline version', async () => {
      const { repo, version } = await makeBaseline();
      await expect(repo.addInput(ctx1, version.id, BIZ1, 100)).resolves.toBeUndefined();
    });

    it('adds a constraint to a baseline version', async () => {
      const { repo, version } = await makeBaseline();
      await expect(repo.addConstraint(ctx1, version.id, BIZ1, 'lte', 1000)).resolves.toBeUndefined();
    });

    it('validates a baseline', async () => {
      const { repo, baseline, version } = await makeBaseline();
      const validated = await repo.validateBaseline(ctx1, baseline.id, version.id);
      expect(validated.status).toBe('validated');
    });

    it('rejects validating an already-published baseline', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      await repo.publishBaseline(ctx1, baseline.id, version.id);
      await expect(repo.validateBaseline(ctx1, baseline.id, version.id)).rejects.toBeInstanceOf(ScenarioBaselineStateConflictError);
    });

    it('publishes a validated baseline', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      const published = await repo.publishBaseline(ctx1, baseline.id, version.id);
      expect(published.status).toBe('published');
    });

    it('rejects publishing a draft (unvalidated) baseline', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await expect(repo.publishBaseline(ctx1, baseline.id, version.id)).rejects.toBeInstanceOf(ScenarioBaselineValidationError);
    });

    it('lists published baselines for a snapshot version', async () => {
      const { repo, baseline, version, snapVersion } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      await repo.publishBaseline(ctx1, baseline.id, version.id);
      const list = await repo.getPublishedForSnapshot(ctx1, snapVersion.id);
      expect(list.some((b) => b.id === baseline.id)).toBe(true);
    });

    it('a published baseline is immutable — direct UPDATE of status is rejected', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      await repo.publishBaseline(ctx1, baseline.id, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.scenario_baselines SET status = 'superseded' WHERE id = $1`, [baseline.id])).rejects.toThrow(/immutable/);
    });

    it('scenario_baseline_versions reject a status change once published', async () => {
      const { repo, baseline, version } = await makeBaseline();
      await repo.validateBaseline(ctx1, baseline.id, version.id);
      await repo.publishBaseline(ctx1, baseline.id, version.id);
      await expect(adminPool!.query(`UPDATE business_digital_twin.scenario_baseline_versions SET status = 'superseded' WHERE id = $1`, [version.id])).rejects.toThrow(/immutable/);
    });
  });

  // ── 12. DTPublicationPackageRepository ──────────────────────────────────────
  describe('DTPublicationPackageRepository', () => {
    async function makeInsightVersion() {
      const repo = new DTPublicationPackageRepository();
      const insight = await repo.createInsightPackage(ctx1, BIZ1, uniqueCode('dt-insight'));
      const version = await repo.createVersion(ctx1, insight.id, BIZ1, 'DT insight summary');
      return { repo, insight, version };
    }

    it('creates an insight package header', async () => {
      const repo = new DTPublicationPackageRepository();
      const insight = await repo.createInsightPackage(ctx1, BIZ1, uniqueCode('dt-insight-h'));
      expect(insight.status).toBe('draft');
      expect(insight.latestVersion).toBe(0);
    });

    it('creates an insight package version and bumps latestVersion', async () => {
      const { version } = await makeInsightVersion();
      expect(version.versionNumber).toBe(1);
    });

    it('creates a publication package targeting simulation', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg, idempotentReplay } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      expect(pkg.targetLayer).toBe('simulation');
      expect(pkg.publicationStatus).toBe('draft');
      expect(idempotentReplay).toBe(false);
    });

    it('rejects an invalid target layer', async () => {
      const { repo, version } = await makeInsightVersion();
      await expect(repo.createPackage(ctx1, BIZ1, version.id, 'ai_decision_intelligence', 'ADI-01', uniqueCode('idem'))).rejects.toBeInstanceOf(ValidationError);
    });

    it('is idempotent on replayed delivery with the same key', async () => {
      const { repo, version } = await makeInsightVersion();
      const key = uniqueCode('idem');
      const first = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', key);
      const second = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', key);
      expect(second.package.id).toBe(first.package.id);
      expect(second.idempotentReplay).toBe(true);
    });

    it('walks the full lifecycle: draft -> ready -> dispatched -> acknowledged', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      const ready = await repo.markReady(ctx1, pkg.id);
      expect(ready.publicationStatus).toBe('ready');
      const dispatched = await repo.dispatch(ctx1, pkg.id);
      expect(dispatched.publicationStatus).toBe('dispatched');
      const acknowledged = await repo.acknowledge(ctx1, pkg.id);
      expect(acknowledged.publicationStatus).toBe('acknowledged');
    });

    it('rejects a forbidden lifecycle transition (draft straight to dispatched)', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await expect(repo.dispatch(ctx1, pkg.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    });

    it('rejects a forbidden lifecycle transition at the database level', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_publication_packages SET publication_status = 'acknowledged' WHERE id = $1`, [pkg.id])).rejects.toThrow(/forbidden transition/);
    });

    it('records a rejection with a reason', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      const rejected = await repo.reject(ctx1, pkg.id, 'schema mismatch');
      expect(rejected.publicationStatus).toBe('rejected');
    });

    it('revokes an acknowledged package', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      await repo.dispatch(ctx1, pkg.id);
      await repo.acknowledge(ctx1, pkg.id);
      const revoked = await repo.revoke(ctx1, pkg.id);
      expect(revoked.publicationStatus).toBe('revoked');
    });

    it('finds a publication package by id', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      const found = await repo.getById(ctx1, pkg.id);
      expect(found.id).toBe(pkg.id);
    });

    it('dt_publication_events are append-only — UPDATE is rejected by the database', async () => {
      const { repo, version } = await makeInsightVersion();
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await repo.markReady(ctx1, pkg.id);
      const events = await adminPool!.query(`SELECT id FROM business_digital_twin.dt_publication_events WHERE dt_publication_package_id = $1 LIMIT 1`, [pkg.id]);
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_publication_events SET detail = '{}'::jsonb WHERE id = $1`, [events.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('dt_insight_package_versions are append-only — UPDATE is rejected by the database', async () => {
      const { version } = await makeInsightVersion();
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_insight_package_versions SET summary = 'changed' WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 13. DTComponentRegistryRepository ───────────────────────────────────────
  describe('DTComponentRegistryRepository', () => {
    it('registers a component in draft status', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp'), 'twin_engine');
      expect(component.status).toBe('draft');
    });

    it('registers a component version and bumps latestVersion', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-v'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, { api: 'v1' });
      expect(version.versionNumber).toBe(1);
    });

    it('activates a component', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-act'), 'twin_engine');
      const activated = await repo.activateVersion(ctx1, component.id, component.id);
      expect(activated.status).toBe('active');
    });

    it('records a deployment and activates it', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-dep'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      expect(deployment.activationState).toBe('active');
    });

    it('records a rollback', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'regression detected');
      const row = await adminPool!.query(`SELECT activation_state FROM business_digital_twin.dt_deployments WHERE id = $1`, [deployment.id]);
      expect(row.rows[0].activation_state).toBe('rolled_back');
    });

    it('gets the active version for a component', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-getact'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await repo.activateVersion(ctx1, component.id, version.id);
      const active = await repo.getActiveVersion(ctx1, component.id);
      expect(active.id).toBe(version.id);
    });

    it('throws NotFoundError for an unknown component', async () => {
      const repo = new DTComponentRegistryRepository();
      await expect(repo.createVersion(ctx1, '00000000-0000-0000-0000-000000000000', BIZ1, {})).rejects.toBeInstanceOf(NotFoundError);
    });

    it('dt_component_registry_versions are append-only — UPDATE is rejected by the database', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-immut'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_component_registry_versions SET capabilities = '{}'::jsonb WHERE id = $1`, [version.id])).rejects.toThrow(/append-only/);
    });

    it('dt_deployment_rollbacks are append-only — UPDATE is rejected by the database', async () => {
      const repo = new DTComponentRegistryRepository();
      const component = await repo.registerComponent(ctx1, BIZ1, uniqueCode('comp-rb-immut'), 'twin_engine');
      const version = await repo.createVersion(ctx1, component.id, BIZ1, {});
      const deployment = await repo.recordDeployment(ctx1, BIZ1, version.id);
      await repo.recordRollback(ctx1, BIZ1, deployment.id, 'x');
      const row = await adminPool!.query(`SELECT id FROM business_digital_twin.dt_deployment_rollbacks WHERE dt_deployment_id = $1`, [deployment.id]);
      await expect(adminPool!.query(`UPDATE business_digital_twin.dt_deployment_rollbacks SET reason = 'y' WHERE id = $1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 14. Uncertainty and confidence (direct SQL — no dedicated repository) ───
  describe('uncertainty and confidence', () => {
    async function makeUncertaintyModel() {
      const model = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_uncertainty_models (tenant_id, workspace_id, business_id, model_code, name)
         VALUES ($1,$2,$3,$4,'Test Model') RETURNING id`,
        [T1, WS1, BIZ1, uniqueCode('unc-model')]
      );
      return model.rows[0].id as string;
    }

    it('creates an uncertainty model', async () => {
      const id = await makeUncertaintyModel();
      expect(id).toBeTruthy();
    });

    it('creates an uncertainty model version', async () => {
      const modelId = await makeUncertaintyModel();
      const version = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_uncertainty_model_versions (tenant_id, workspace_id, business_id, uncertainty_model_id, version_number, specification)
         VALUES ($1,$2,$3,$4,1,'{}'::jsonb) RETURNING id`,
        [T1, WS1, BIZ1, modelId]
      );
      expect(version.rows[0].id).toBeTruthy();
    });

    it('creates an uncertainty assignment with a valid distribution type', async () => {
      const modelId = await makeUncertaintyModel();
      const svRepo = new StateVariableRepository();
      const def = await svRepo.createDefinition(ctx1, BIZ1, uniqueCode('unc-sv'), 'X', 'financial', 'number');
      const assignment = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_uncertainty_assignments (tenant_id, workspace_id, business_id, uncertainty_model_id, state_variable_definition_id, distribution_type, parameters)
         VALUES ($1,$2,$3,$4,$5,'normal','{"mean":0,"sd":1}'::jsonb) RETURNING id`,
        [T1, WS1, BIZ1, modelId, def.id]
      );
      expect(assignment.rows[0].id).toBeTruthy();
    });

    it('rejects an unknown distribution type at the database level', async () => {
      const modelId = await makeUncertaintyModel();
      const svRepo = new StateVariableRepository();
      const def = await svRepo.createDefinition(ctx1, BIZ1, uniqueCode('unc-sv-bad'), 'X', 'financial', 'number');
      await expect(
        adminPool!.query(
          `INSERT INTO business_digital_twin.twin_uncertainty_assignments (tenant_id, workspace_id, business_id, uncertainty_model_id, state_variable_definition_id, distribution_type)
           VALUES ($1,$2,$3,$4,$5,'not_a_distribution')`,
          [T1, WS1, BIZ1, modelId, def.id]
        )
      ).rejects.toThrow();
    });

    it('records a confidence score bounded to [0,1]', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const score = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, confidence, basis)
         VALUES ($1,$2,$3,$4,0.75,'model backtest') RETURNING confidence`,
        [T1, WS1, BIZ1, instance.id]
      );
      expect(parseFloat(String(score.rows[0].confidence))).toBeCloseTo(0.75, 2);
    });

    it('rejects a confidence score outside [0,1] at the database level', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await expect(
        adminPool!.query(
          `INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, confidence, basis)
           VALUES ($1,$2,$3,$4,1.5,'bad')`,
          [T1, WS1, BIZ1, instance.id]
        )
      ).rejects.toThrow();
    });

    it('twin_uncertainty_assignments are append-only — UPDATE is rejected by the database', async () => {
      const modelId = await makeUncertaintyModel();
      const svRepo = new StateVariableRepository();
      const def = await svRepo.createDefinition(ctx1, BIZ1, uniqueCode('unc-sv-immut'), 'X', 'financial', 'number');
      const assignment = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_uncertainty_assignments (tenant_id, workspace_id, business_id, uncertainty_model_id, state_variable_definition_id, distribution_type)
         VALUES ($1,$2,$3,$4,$5,'fixed') RETURNING id`,
        [T1, WS1, BIZ1, modelId, def.id]
      );
      await expect(adminPool!.query(`UPDATE business_digital_twin.twin_uncertainty_assignments SET distribution_type = 'normal' WHERE id = $1`, [assignment.rows[0].id])).rejects.toThrow(/append-only/);
    });

    it('twin_confidence_scores are append-only — UPDATE is rejected by the database', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const score = await adminPool!.query(
        `INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, confidence, basis)
         VALUES ($1,$2,$3,$4,0.5,'x') RETURNING id`,
        [T1, WS1, BIZ1, instance.id]
      );
      await expect(adminPool!.query(`UPDATE business_digital_twin.twin_confidence_scores SET confidence = 0.99 WHERE id = $1`, [score.rows[0].id])).rejects.toThrow(/append-only/);
    });
  });

  // ── 15. Cross-tenant / cross-workspace RLS live rejection ────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('tenant 2 cannot read tenant 1 definitions', async () => {
      const repo = new DigitalTwinDefinitionRepository();
      const def = await repo.createDefinition(ctx1, BIZ1, uniqueCode('iso-def'), 'Iso');
      await expect(repo.createVersion(ctx2, def.id, BIZ1, {})).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot read tenant 1 instances', async () => {
      const { instRepo, instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await expect(instRepo.getById(ctx2, instance.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 sees zero rows in tenant 1 entity graphs', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const repo = new TwinEntityRepository();
      await repo.createEntity(ctx1, BIZ1, instance.id, uniqueCode('iso-ent'), 'customer', 'Iso Corp');
      const graph = await repo.getEntityGraph(ctx2, instance.id);
      expect(graph.entities.length).toBe(0);
    });

    it('tenant 2 cannot acknowledge a tenant 1 publication package', async () => {
      const repo = new DTPublicationPackageRepository();
      const insight = await repo.createInsightPackage(ctx1, BIZ1, uniqueCode('iso-insight'));
      const version = await repo.createVersion(ctx1, insight.id, BIZ1, 'S');
      const { package: pkg } = await repo.createPackage(ctx1, BIZ1, version.id, 'simulation', 'SIM-01', uniqueCode('idem'));
      await expect(repo.markReady(ctx2, pkg.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tenant 2 cannot read tenant 1 state variable values', async () => {
      const svRepo = new StateVariableRepository();
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      const def = await svRepo.createDefinition(ctx1, BIZ1, uniqueCode('iso-sv'), 'X', 'financial', 'number');
      await svRepo.recordValue(ctx1, def.id, BIZ1, instance.id, 1, new Date());
      const list = await svRepo.listValues(ctx2, def.id, instance.id);
      expect(list.length).toBe(0);
    });
  });

  // ── 16. Outbox atomicity — all 16 required dt.* events ───────────────────────
  describe('outbox event functions', () => {
    async function countByType(eventType: string): Promise<number> {
      const result = await adminPool!.query(`SELECT count(*)::int AS n FROM events.outbox_events WHERE event_type = $1`, [eventType]);
      return result.rows[0].n as number;
    }

    it('emit_intake_received inserts a pending outbox event atomically', async () => {
      const before = await countByType('dt.intake.received');
      await adminPool!.query(`SELECT business_digital_twin.emit_intake_received($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.intake.received')).toBe(before + 1);
    });

    it('emit_intake_accepted inserts a pending outbox event', async () => {
      const before = await countByType('dt.intake.accepted');
      await adminPool!.query(`SELECT business_digital_twin.emit_intake_accepted($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.intake.accepted')).toBe(before + 1);
    });

    it('emit_intake_rejected records a reason in the payload', async () => {
      const result = await adminPool!.query(`SELECT business_digital_twin.emit_intake_rejected($1,$2,gen_random_uuid(),'bad schema',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.reason).toBe('bad schema');
    });

    it('emit_definition_published inserts a pending outbox event', async () => {
      const before = await countByType('dt.definition.published');
      await adminPool!.query(`SELECT business_digital_twin.emit_definition_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.definition.published')).toBe(before + 1);
    });

    it('emit_instance_created inserts a pending outbox event', async () => {
      const before = await countByType('dt.instance.created');
      await adminPool!.query(`SELECT business_digital_twin.emit_instance_created($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.instance.created')).toBe(before + 1);
    });

    it('emit_instance_status_changed records the target status in the payload', async () => {
      const result = await adminPool!.query(`SELECT business_digital_twin.emit_instance_status_changed($1,$2,gen_random_uuid(),'active',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.toStatus).toBe('active');
    });

    it('emit_snapshot_created inserts a pending outbox event', async () => {
      const before = await countByType('dt.snapshot.created');
      await adminPool!.query(`SELECT business_digital_twin.emit_snapshot_created($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.snapshot.created')).toBe(before + 1);
    });

    it('emit_snapshot_validated inserts a pending outbox event', async () => {
      const before = await countByType('dt.snapshot.validated');
      await adminPool!.query(`SELECT business_digital_twin.emit_snapshot_validated($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.snapshot.validated')).toBe(before + 1);
    });

    it('emit_snapshot_published inserts a pending outbox event', async () => {
      const before = await countByType('dt.snapshot.published');
      await adminPool!.query(`SELECT business_digital_twin.emit_snapshot_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.snapshot.published')).toBe(before + 1);
    });

    it('emit_calibration_started inserts a pending outbox event', async () => {
      const before = await countByType('dt.calibration.started');
      await adminPool!.query(`SELECT business_digital_twin.emit_calibration_started($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.calibration.started')).toBe(before + 1);
    });

    it('emit_calibration_completed inserts a pending outbox event', async () => {
      const before = await countByType('dt.calibration.completed');
      await adminPool!.query(`SELECT business_digital_twin.emit_calibration_completed($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.calibration.completed')).toBe(before + 1);
    });

    it('emit_calibration_failed records a failure code in the payload', async () => {
      const result = await adminPool!.query(`SELECT business_digital_twin.emit_calibration_failed($1,$2,gen_random_uuid(),'DT_CAL_TIMEOUT',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.failureCode).toBe('DT_CAL_TIMEOUT');
    });

    it('emit_validation_completed records an outcome in the payload', async () => {
      const result = await adminPool!.query(`SELECT business_digital_twin.emit_validation_completed($1,$2,gen_random_uuid(),'passed',gen_random_uuid()) AS event_id`, [T1, WS1]);
      const event = await adminPool!.query(`SELECT payload FROM events.outbox_events WHERE id = $1`, [result.rows[0].event_id]);
      expect(event.rows[0].payload.outcome).toBe('passed');
    });

    it('emit_scenario_baseline_created inserts a pending outbox event', async () => {
      const before = await countByType('dt.scenario_baseline.created');
      await adminPool!.query(`SELECT business_digital_twin.emit_scenario_baseline_created($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.scenario_baseline.created')).toBe(before + 1);
    });

    it('emit_scenario_baseline_published inserts a pending outbox event', async () => {
      const before = await countByType('dt.scenario_baseline.published');
      await adminPool!.query(`SELECT business_digital_twin.emit_scenario_baseline_published($1,$2,gen_random_uuid(),gen_random_uuid())`, [T1, WS1]);
      expect(await countByType('dt.scenario_baseline.published')).toBe(before + 1);
    });

    it('emit_data_published rejects an invalid target layer', async () => {
      await expect(
        adminPool!.query(`SELECT business_digital_twin.emit_data_published($1,$2,gen_random_uuid(),'not_a_real_layer','X',gen_random_uuid())`, [T1, WS1])
      ).rejects.toThrow(/invalid target layer/);
    });

    it('emit_data_published accepts the authorized simulation target layer', async () => {
      const result = await adminPool!.query(
        `SELECT business_digital_twin.emit_data_published($1,$2,gen_random_uuid(),'simulation','SIM-01',gen_random_uuid()) AS event_id`,
        [T1, WS1]
      );
      expect(result.rows[0].event_id).toBeTruthy();
    });
  });

  // ── 17. Transaction rollback behaviour ────────────────────────────────────────
  describe('transaction rollback behaviour', () => {
    it('leaves no partial state variable definition when category validation fails before the insert', async () => {
      const repo = new StateVariableRepository();
      const code = uniqueCode('rollback-sv');
      await expect(repo.createDefinition(ctx1, BIZ1, code, 'X', 'not_a_category', 'number')).rejects.toBeInstanceOf(ValidationError);
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM business_digital_twin.state_variable_definitions WHERE variable_code = $1`, [code]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rolls back an out-of-band insert that violates a database-level bound (defense in depth)', async () => {
      const { instance } = await makeDefinitionAndInstance(ctx1, BIZ1);
      await expect(
        adminPool!.query(
          `INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, confidence, basis)
           VALUES ($1,$2,$3,$4,2.0,'bad')`,
          [T1, WS1, BIZ1, instance.id]
        )
      ).rejects.toThrow();
      const check = await adminPool!.query(`SELECT count(*)::int AS n FROM business_digital_twin.twin_confidence_scores WHERE instance_id = $1`, [instance.id]);
      expect(check.rows[0].n).toBe(0);
    });

    it('rejects a duplicate intake idempotency key with a different BI package as an application-level replay, not a DB error', async () => {
      const repo = new DTIntakeRepository();
      const biPkg1 = await createBiPackage(T1, WS1, BIZ1);
      const biPkg2 = await createBiPackage(T1, WS1, BIZ1);
      const key = uniqueCode('idem-shared');
      const first = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg1, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      const second = await repo.receivePackage(ctx1, { businessId: BIZ1, biPublicationPackageId: biPkg2, intakeCode: uniqueCode('intake'), idempotencyKey: key });
      expect(second.idempotentReplay).toBe(true);
      expect(second.package.id).toBe(first.package.id);
    });
  });
});

describe.skipIf(run)('Stage 2E Business Digital Twin — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
