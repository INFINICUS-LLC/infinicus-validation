import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-7c07-0000-0000-000000000001';
const WS1 = '32222222-7c07-0000-0000-000000000002';
const UID = '32222222-7c07-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-7 outputs first.
  await adminPool.query(
    `DELETE FROM data_acquisition.publication_deliveries
     WHERE publication_package_id IN (
       SELECT id FROM data_acquisition.publication_packages WHERE tenant_id = ANY($1)
     )`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.bo_handoff_records WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.bo_publication_packages WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.business_events WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await deleteMovementsForTenants(adminPool, tenantIds); // append-only (0184): test-only privileged cleanup
  await adminPool.query(
    `DELETE FROM business_operations.inventory_balances WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.supplier_performance_scores WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.purchase_order_line_items WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.purchase_receipts WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.purchase_orders WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.asset_inspections WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );

  // BUILD-31 source material.
  await adminPool.query(
    `DELETE FROM data_acquisition.transformation_records
     WHERE provenance_record_id IN (
       SELECT id FROM data_acquisition.provenance_records WHERE tenant_id = ANY($1)
     )`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.provenance_records WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.publication_packages WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.data_quality_scores WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.validation_issues
     WHERE validation_result_id IN (
       SELECT id FROM data_acquisition.validation_results WHERE tenant_id = ANY($1)
     )`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.validation_results WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.manual_submissions WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.collection_runs WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.connectors WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM data_acquisition.data_sources WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );

  // Outbox/audit references produced by these operations.
  await adminPool.query(
    `DELETE FROM events.outbox_events WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );

  // Canonical fixtures.
  if (businessId) {
    await adminPool.query(`DELETE FROM business_operations.inventory_balances WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.inventory_items WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.warehouses WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.employees WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.suppliers WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
  }
  await adminPool.query(`DELETE FROM identity.users WHERE id = $1`, [UID]);
  await adminPool.query(`DELETE FROM tenancy.workspaces WHERE id = $1`, [WS1]);
  await adminPool.query(`DELETE FROM tenancy.tenants WHERE id = $1`, [T1]);
}

describe.runIf(RUN)('R-01B-7 DAL supplier_performance preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-7 Integration Tenant','r01b7-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-7 Integration Workspace','r01b7-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b7-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-7 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b7-biz')]
    );
    businessId = biz.rows[0].id;
  });

  afterAll(async () => {
    await cleanTenant();
    await adminPool.end();
    await closePool();
  });

  async function createPublishedHandoff(customRecords: unknown[], submissionType: string): Promise<DALToBOHandoff> {
    const source = await da.registerSource(ctx, {
      businessId,
      name: 'R-01B-7 manual source',
      sourceCode: unique('r01b7-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b7',
      submittedBy: UID,
    });

    expect(intake.state).toBe('validated');

    const prepared = await da.preparePublicationPackage(
      ctx,
      businessId,
      intake.collectionRunId,
      { targetBlock: 'BO-RUNTIME' }
    );
    const published = await da.publishPackage(ctx, businessId, prepared.id);

    return {
      handoffId: unique('handoff'),
      sourceLayer: 'DAL',
      sourceBlock: 'DA-24',
      targetLayer: 'BO',
      targetBlock: 'BO-RUNTIME',
      correlationId: published.correlationId,
      lineage: [],
      status: 'ready',
      createdAt: new Date().toISOString(),
      payload: {
        contractVersion: '1.0.0',
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        businessId,
        publicationPackageId: published.id,
        packageType: published.packageType,
        packageVersion: published.packageVersion,
        targetLayer: 'business_operations',
        targetBlock: published.targetBlock,
        status: 'published',
        publishedAt: published.publishedAt!.toISOString(),
        recordCount: published.recordCount,
        source: {
          sourceSystem: 'INFINICUS_DA',
          dataReference: published.dataReference as Record<string, string | number | boolean | null>,
        },
        schemaReferenceId: published.schemaReferenceId,
        quality: {
          qualityScore: published.qualityScore,
          reliabilityScore: published.reliabilityScore,
        },
        provenanceReferenceIds: published.provenanceReferenceIds as string[],
        consentReferenceIds: [],
        limitations: (published.limitations as unknown[]).map(String),
        warnings: [],
        idempotencyKey: `dal-to-bo:${published.id}:${published.packageVersion}`,
      },
    };
  }

  let seq7 = 0;
  const newSupplier = async (forBusiness: string = businessId): Promise<string> =>
    (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,'R-01B-7 Supplier',$4,'low','active') RETURNING id`,
      [T1, WS1, forBusiness, unique(`r01b7-sup-${++seq7}`)])).rows[0].id;
  const sp = (supplierId: string, data: Record<string, unknown> = {}) => ({
    recordType: 'supplier_performance',
    data: { supplierId, periodStart: '2026-01-01', periodEnd: '2026-03-31', qualityScore: 90, deliveryScore: 80, priceScore: 70, serviceScore: 60, overallScore: 75, ...data },
  });
  const rows = async (supplierId: string) => (await adminPool.query(
    `SELECT tenant_id, workspace_id, business_id, supplier_id, period_start::text AS period_start, period_end::text AS period_end,
            quality_score::text AS quality_score, delivery_score::text AS delivery_score, price_score::text AS price_score,
            service_score::text AS service_score, overall_score::text AS overall_score, notes
       FROM business_operations.supplier_performance_scores WHERE business_id = $1 AND supplier_id = $2 ORDER BY created_at, id`, [businessId, supplierId])).rows;

  it('hands prepared records to BO through the existing ingestion contract: BO accepts them and writes exactly the prepared values, scoped by the authenticated context', async () => {
    const supplierId = await newSupplier();
    const handoff = await createPublishedHandoff([
      sp(supplierId.toUpperCase(), { periodStart: ' 2026-01-01 ', qualityScore: ' 88.50 ', overallScore: '75.25', notes: ' solid ' }),
      sp(supplierId, { periodStart: '2026-04-01', periodEnd: '2026-04-01', qualityScore: 0, deliveryScore: 100 }),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.acceptedRecordCount).toBe(2);
    expect(result.results.map((r) => r.commandType)).toEqual(['record_supplier_performance', 'record_supplier_performance']);
    const stored = await rows(supplierId);
    expect(stored).toContainEqual({
      tenant_id: T1, workspace_id: WS1, business_id: businessId, supplier_id: supplierId, period_start: '2026-01-01', period_end: '2026-03-31',
      quality_score: '88.50', delivery_score: '80.00', price_score: '70.00', service_score: '60.00', overall_score: '75.25', notes: 'solid',
    });
    expect(stored).toContainEqual(expect.objectContaining({ period_start: '2026-04-01', period_end: '2026-04-01', quality_score: '0.00', delivery_score: '100.00', notes: null }));

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('contrast: without the preparer BO silently rounds a third decimal (85.123 -> 85.12) and aborts a reversed period with a raw constraint error; with it, both are refused before handoff', async () => {
    const supplierId = await newSupplier();
    await bo.processHandoff(ctx, await createPublishedHandoff([sp(supplierId, { serviceScore: 85.123 })], 'operations'));
    expect((await rows(supplierId))[0].service_score).toBe('85.12'); // precision lost by the column, not reported by BO

    const reversed = await bo.processHandoff(ctx, await createPublishedHandoff([sp(supplierId, { periodStart: '2026-04-01', periodEnd: '2026-03-31' })], 'operations')).then(() => null, (e: unknown) => e);
    expect(reversed).toBeInstanceOf(OperationalMappingError);
    expect(await rows(supplierId)).toHaveLength(1);

    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-7 contrast', sourceCode: unique('r01b7-c'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [sp(supplierId, { serviceScore: 85.123 }), sp(supplierId, { periodStart: '2026-04-01', periodEnd: '2026-03-31' })],
    });
    expect(intake.state).toBe('quarantined');
    expect(intake.recordsRejected).toBe(2);
  });

  it('malformed records are refused by the DAL before any handoff, and a quarantined run cannot be published or write', async () => {
    const supplierId = await newSupplier();
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-7 quarantine', sourceCode: unique('r01b7-q'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [sp(supplierId), sp('SUP-NOT-A-UUID'), sp(supplierId, { qualityScore: 101 }), sp(supplierId, { periodEnd: '2025-12-31' })],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await rows(supplierId)).toEqual([]);
  });

  it('BO stays the authority on existence: a well-formed supplier that does not exist passes the DAL and is refused by BO, atomically', async () => {
    const real = await newSupplier();
    const missing = '12345678-1234-4234-8234-123456789abc';
    const handoff = await createPublishedHandoff([sp(real), sp(missing)], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
    expect(await rows(real)).toEqual([]); // the good record was rolled back with the bad one
  });

  it('business isolation: a supplier that belongs to another business of the same tenant is refused by BO', async () => {
    const other = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'R-01B-7 other business',$3,'active') RETURNING id`,
      [T1, WS1, unique('r01b7-other')])).rows[0].id;
    try {
      const foreign = await newSupplier(other);
      const handoff = await createPublishedHandoff([sp(foreign)], OPERATIONS_PREPARED_SUBMISSION_TYPE);
      await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
      expect((await adminPool.query(`SELECT 1 FROM business_operations.supplier_performance_scores WHERE supplier_id = $1`, [foreign])).rowCount).toBe(0);
    } finally {
      await adminPool.query(`DELETE FROM platform.suppliers WHERE business_id = $1`, [other]);
      await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [other]);
    }
  });

  it('no identity rule, no duplicate reporting: the same supplier and period twice is accepted and stored twice (BO is the sole mutation authority)', async () => {
    const supplierId = await newSupplier();
    const result = await bo.processHandoff(ctx, await createPublishedHandoff([sp(supplierId), sp(supplierId)], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(result.acceptedRecordCount).toBe(2);
    expect(await rows(supplierId)).toHaveLength(2);
  });
});
