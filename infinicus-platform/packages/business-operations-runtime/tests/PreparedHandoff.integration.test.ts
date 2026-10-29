import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-3a01-0000-0000-000000000001';
const WS1 = '32222222-3a01-0000-0000-000000000002';
const UID = '32222222-3a01-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01A outputs first.
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

describe.runIf(RUN)('R-01A DAL preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01A Integration Tenant','r01a-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01A Integration Workspace','r01a-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01a-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01A Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01a-biz')]
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
      name: 'R-01A manual source',
      sourceCode: unique('r01a-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01a',
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

  const rawItems = [
    { recordType: 'inventory_item', data: { sku: '  R01A-SKU ', name: ' Prepared Widget ', unitOfMeasure: ' each ' } },
    { recordType: 'warehouse', data: { warehouseCode: ' R01A-WH ', name: 'Prepared Main' } },
  ];

  it('hands prepared records to BO through the existing ingestion contract: BO accepts them and is the only writer', async () => {
    const handoff = await createPublishedHandoff(rawItems, OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.idempotentReplay).toBe(false);
    expect(result.acceptedRecordCount).toBe(2);
    expect(result.results.map((r) => r.commandType).sort()).toEqual(['create_inventory_item', 'create_warehouse']);

    const item = await adminPool.query(`SELECT sku, name, unit_of_measure FROM platform.inventory_items WHERE business_id=$1 AND tenant_id=$2`, [businessId, T1]);
    expect(item.rows).toEqual([{ sku: 'R01A-SKU', name: 'Prepared Widget', unit_of_measure: 'each' }]);
    const wh = await adminPool.query(`SELECT warehouse_code, name FROM platform.warehouses WHERE business_id=$1 AND tenant_id=$2`, [businessId, T1]);
    expect(wh.rows).toEqual([{ warehouse_code: 'R01A-WH', name: 'Prepared Main' }]);

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('contrast: the same raw records submitted on the legacy path are rejected by BO (the preparer is what makes them admissible)', async () => {
    const handoff = await createPublishedHandoff(rawItems, 'operations');
    await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
  });

  it('a quarantined (partly rejected) prepared run cannot be published, so nothing reaches BO', async () => {
    const source = await da.registerSource(ctx, {
      businessId, name: 'R-01A bad source', sourceCode: unique('r01a-bad'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active',
    });
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [rawItems[0], { recordType: 'warehouse', data: { warehouseCode: 'W' } }],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
  });
});
