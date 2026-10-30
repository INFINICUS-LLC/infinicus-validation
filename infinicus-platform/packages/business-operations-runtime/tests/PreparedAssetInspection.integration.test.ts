import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-6c06-0000-0000-000000000001';
const WS1 = '32222222-6c06-0000-0000-000000000002';
const UID = '32222222-6c06-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-6 outputs first.
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
    await adminPool.query(`DELETE FROM platform.assets WHERE business_id = $1`, [businessId]);
    await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
  }
  await adminPool.query(`DELETE FROM identity.users WHERE id = $1`, [UID]);
  await adminPool.query(`DELETE FROM tenancy.workspaces WHERE id = $1`, [WS1]);
  await adminPool.query(`DELETE FROM tenancy.tenants WHERE id = $1`, [T1]);
}

describe.runIf(RUN)('R-01B-6 DAL asset_inspection preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-6 Integration Tenant','r01b6-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-6 Integration Workspace','r01b6-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b6-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-6 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b6-biz')]
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
      name: 'R-01B-6 manual source',
      sourceCode: unique('r01b6-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b6',
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

  const newAsset = async (forBusiness: string = businessId): Promise<string> =>
    (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.assets (tenant_id, workspace_id, business_id, asset_code, name, asset_type, condition_status, status) VALUES ($1,$2,$3,$4,'Cold Room','equipment','good','active') RETURNING id`,
      [T1, WS1, forBusiness, unique('ASSET')])).rows[0].id;
  const ai = (assetId: string, data: Record<string, unknown> = {}) => ({ recordType: 'asset_inspection', data: { assetId, conditionRating: 'good', pass: true, ...data } });
  const rows = async (assetId: string) => (await adminPool.query(
    `SELECT tenant_id, workspace_id, business_id, asset_id, inspection_type, condition_rating, pass_fail, findings, actions_required, next_inspection_date::text AS next_inspection_date
       FROM business_operations.asset_inspections WHERE business_id = $1 AND asset_id = $2 ORDER BY created_at, id`, [businessId, assetId])).rows;

  it('hands prepared inspections to BO through the existing ingestion contract: BO accepts them and writes exactly the prepared values, scoped by the authenticated context', async () => {
    const assetId = await newAsset();
    const handoff = await createPublishedHandoff([
      ai(assetId.toUpperCase(), { conditionRating: ' Poor ', inspectionType: 'SAFETY', pass: false, findings: ' crack ', actionsRequired: ' weld ', nextInspectionDate: '2026-12-31' }),
      ai(assetId),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.acceptedRecordCount).toBe(2);
    expect(result.results.map((r) => r.commandType)).toEqual(['record_asset_inspection', 'record_asset_inspection']);
    const stored = await rows(assetId);
    expect(stored).toHaveLength(2);
    expect(stored).toContainEqual({
      tenant_id: T1, workspace_id: WS1, business_id: businessId, asset_id: assetId, inspection_type: 'safety', condition_rating: 'poor', pass_fail: false,
      findings: 'crack', actions_required: 'weld', next_inspection_date: '2026-12-31',
    });
    // nothing was invented by the DAL: the type is BO's own default, the optional values stay null
    expect(stored).toContainEqual(expect.objectContaining({ inspection_type: 'routine', condition_rating: 'good', pass_fail: true, findings: null, actions_required: null, next_inspection_date: null }));

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('date boundaries survive the real date column (leap day, year 1, year 9999)', async () => {
    const assetId = await newAsset();
    const dates = ['2024-02-29', '0001-01-01', '9999-12-31'];
    await bo.processHandoff(ctx, await createPublishedHandoff(dates.map((d) => ai(assetId, { nextInspectionDate: d })), OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect((await rows(assetId)).map((r) => r.next_inspection_date).sort()).toEqual([...dates].sort());
  });

  it('contrast: the legacy path stores the raw, unprepared values', async () => {
    const assetId = await newAsset();
    await bo.processHandoff(ctx, await createPublishedHandoff([ai(assetId, { findings: '  padded  ' })], 'operations'));
    expect(await rows(assetId)).toEqual([expect.objectContaining({ findings: '  padded  ' })]);
  });

  it('malformed inspections are refused by the DAL before any handoff, and a quarantined run cannot be published or write', async () => {
    const assetId = await newAsset();
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-6 quarantine', sourceCode: unique('r01b6-q'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [ai(assetId), ai('ASSET-NOT-A-UUID'), ai(assetId, { pass: 'true' }), ai(assetId, { conditionRating: 'ok' })],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await rows(assetId)).toEqual([]);
  });

  it('BO stays the authority on existence: a well-formed asset that does not exist passes the DAL and is refused by BO, atomically', async () => {
    const real = await newAsset();
    const missing = '12345678-1234-4234-8234-123456789abc';
    const handoff = await createPublishedHandoff([ai(real), ai(missing)], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
    expect(await rows(real)).toEqual([]); // the good record was rolled back with the bad one
  });

  it('business isolation: an asset that belongs to another business of the same tenant is refused by BO', async () => {
    const other = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'R-01B-6 other business',$3,'active') RETURNING id`,
      [T1, WS1, unique('r01b6-other')])).rows[0].id;
    try {
      const foreignAsset = await newAsset(other);
      const handoff = await createPublishedHandoff([ai(foreignAsset)], OPERATIONS_PREPARED_SUBMISSION_TYPE);
      await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
      expect((await adminPool.query(`SELECT 1 FROM business_operations.asset_inspections WHERE asset_id = $1`, [foreignAsset])).rowCount).toBe(0);
    } finally {
      await adminPool.query(`DELETE FROM platform.assets WHERE business_id = $1`, [other]);
      await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [other]);
    }
  });

  it('no identity rule, no duplicate reporting: identical prepared inspections are both accepted and both stored', async () => {
    const assetId = await newAsset();
    const result = await bo.processHandoff(ctx, await createPublishedHandoff([ai(assetId), ai(assetId)], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(result.acceptedRecordCount).toBe(2);
    expect(await rows(assetId)).toHaveLength(2);
  });
});
