import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-3c03-0000-0000-000000000001';
const WS1 = '32222222-3c03-0000-0000-000000000002';
const UID = '32222222-3c03-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-3 outputs first.
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

describe.runIf(RUN)('R-01B-3 DAL purchase_order preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-3 Integration Tenant','r01b3-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-3 Integration Workspace','r01b3-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b3-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-3 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b3-biz')]
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
      name: 'R-01B-3 manual source',
      sourceCode: unique('r01b3-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b3',
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

  let seq3 = 0;
  const SUPPLIER_NAME = 'R-01B-3 Supplier';
  async function newSupplier(forBusiness: string = businessId): Promise<string> {
    return (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,$4,$5,'low','active') RETURNING id`,
      [T1, WS1, forBusiness, SUPPLIER_NAME, unique(`r01b3-sup-${++seq3}`)])).rows[0].id;
  }
  const po = (supplierId: string, data: Record<string, unknown> = {}) => ({ recordType: 'purchase_order', data: { supplierId, poNumber: unique('PO'), currencyCode: 'KWD', ...data } });
  const poRows = async (poNumber: string) => (await adminPool.query(
    `SELECT supplier_id, po_number, currency_code, total_amount::text AS total_amount, expected_date::text AS expected_date, po_status, source_system, notes
       FROM business_operations.purchase_orders WHERE business_id = $1 AND po_number = $2`, [businessId, poNumber])).rows;

  it('hands prepared purchase orders to BO through the existing ingestion contract: BO accepts them and writes exactly the prepared values', async () => {
    const supplierId = await newSupplier();
    const n1 = unique('PO-A'); const n2 = unique('PO-B');
    const handoff = await createPublishedHandoff([
      po(supplierId.toUpperCase(), { poNumber: `  ${n1} `, totalAmount: ' 1250.50 ', expectedDate: '2026-12-31', notes: '  rush ' }),
      po(supplierId, { poNumber: n2 }),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.acceptedRecordCount).toBe(2);
    expect(result.results.map((r) => r.commandType)).toEqual(['create_purchase_order', 'create_purchase_order']);
    expect(await poRows(n1)).toEqual([{
      supplier_id: supplierId, po_number: n1, currency_code: 'KWD', total_amount: '1250.5000', expected_date: '2026-12-31',
      po_status: 'draft', source_system: 'INFINICUS_DA', notes: 'rush',
    }]);
    // nothing was invented by the DAL: the absent total is BO's own default, the absent date stays null
    const bare = (await poRows(n2))[0];
    expect(bare).toMatchObject({ total_amount: '0.0000', expected_date: null, notes: null, po_status: 'draft' });

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('date and amount boundaries survive the real column types (leap day, year 1, year 9999, largest and smallest amounts)', async () => {
    const supplierId = await newSupplier();
    const cases: Array<[string, string, string]> = [
      ['2024-02-29', '99999999999999.9999'.replace('.9999', ''), '99999999999999.0000'],
      ['0001-01-01', '0.0001', '0.0001'],
      ['9999-12-31', '12345678901234.5', '12345678901234.5000'],
    ];
    const handoff = await createPublishedHandoff(cases.map(([date, amount], i) => po(supplierId, { poNumber: `BND-${seq3}-${i}-${Date.now()}`, expectedDate: date, totalAmount: amount })), OPERATIONS_PREPARED_SUBMISSION_TYPE);
    await bo.processHandoff(ctx, handoff);
    const rows = (await adminPool.query(
      `SELECT expected_date::text AS d, total_amount::text AS t FROM business_operations.purchase_orders WHERE business_id=$1 AND po_number LIKE $2 ORDER BY po_number`, [businessId, `BND-${seq3}-%`])).rows;
    expect(rows).toEqual(cases.map(([d, , t]) => ({ d, t })));
  });

  it('contrast: the legacy path stores the raw, unprepared values (the preparer is what trims, canonicalizes and bounds them)', async () => {
    const supplierId = await newSupplier();
    const spaced = `  ${unique('PO-LEGACY')}  `;
    const handoff = await createPublishedHandoff([po(supplierId, { poNumber: spaced })], 'operations');
    await bo.processHandoff(ctx, handoff);
    const stored = (await adminPool.query(`SELECT po_number FROM business_operations.purchase_orders WHERE business_id=$1 AND po_number = $2`, [businessId, spaced])).rows;
    expect(stored).toHaveLength(1); // stored with its padding
  });

  it('F9 evidence: a non-UUID supplier on the legacy path aborts the whole handoff with the raw driver message; the preparation path refuses it earlier, with a stable code', async () => {
    const handoff = await createPublishedHandoff([po('SUP-NOT-A-UUID')], 'operations');
    const error = await bo.processHandoff(ctx, handoff).then(() => null, (e: unknown) => e);
    // BO wraps the driver failure, so it is a controlled error type, but its message is the raw database text and nothing is written
    expect(error).toBeInstanceOf(OperationalMappingError);
    expect((error as Error).message).toMatch(/invalid input syntax for type uuid/);

    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-3 bad supplier', sourceCode: unique('r01b3-bad'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, { businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE, records: [po('SUP-NOT-A-UUID')] });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
  });

  it('BO stays the authority on existence: a well-formed supplier that does not exist passes the DAL and is refused by BO, atomically', async () => {
    const real = await newSupplier();
    const missing = '12345678-1234-4234-8234-123456789abc';
    const okNumber = unique('PO-OK'); const badNumber = unique('PO-MISSING');
    const handoff = await createPublishedHandoff([po(real, { poNumber: okNumber }), po(missing, { poNumber: badNumber })], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
    expect(await poRows(okNumber)).toEqual([]); // the good record was rolled back with the bad one
    expect(await poRows(badNumber)).toEqual([]);
  });

  it('business isolation: a supplier that belongs to another business of the same tenant is refused by BO', async () => {
    const other = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'R-01B-3 other business',$3,'active') RETURNING id`,
      [T1, WS1, unique('r01b3-other')])).rows[0].id;
    try {
      const foreignSupplier = await newSupplier(other);
      const number = unique('PO-FOREIGN');
      const handoff = await createPublishedHandoff([po(foreignSupplier, { poNumber: number })], OPERATIONS_PREPARED_SUBMISSION_TYPE);
      await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
      expect(await poRows(number)).toEqual([]);
    } finally {
      await adminPool.query(`DELETE FROM platform.suppliers WHERE business_id = $1`, [other]);
      await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [other]);
    }
  });

  it('owner-decision evidence: BO refuses a repeated poNumber even when the records are identical (not idempotent, unlike items and warehouses), and rolls everything back', async () => {
    const supplierId = await newSupplier();
    const number = unique('PO-DUP');
    const handoff = await createPublishedHandoff([po(supplierId, { poNumber: number }), po(supplierId, { poNumber: number })], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const error = await bo.processHandoff(ctx, handoff).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(await poRows(number)).toEqual([]);

    const again = unique('PO-REPLAY');
    await bo.processHandoff(ctx, await createPublishedHandoff([po(supplierId, { poNumber: again })], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    const replay = await bo.processHandoff(ctx, await createPublishedHandoff([po(supplierId, { poNumber: again })], OPERATIONS_PREPARED_SUBMISSION_TYPE)).then(() => null, (e: unknown) => e);
    expect(replay).not.toBeNull(); // the same PO in a later package is refused too
    expect(await poRows(again)).toHaveLength(1);
  });

  it('a quarantined purchase-order run cannot be published, so nothing reaches BO', async () => {
    const supplierId = await newSupplier();
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-3 quarantine', sourceCode: unique('r01b3-q'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const number = unique('PO-Q');
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [po(supplierId, { poNumber: number }), po(supplierId, { poNumber: unique('PO-BAD'), totalAmount: '1.23456' })],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await poRows(number)).toEqual([]);
  });
});
