import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-8c08-0000-0000-000000000001';
const WS1 = '32222222-8c08-0000-0000-000000000002';
const UID = '32222222-8c08-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-8 outputs first.
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

describe.runIf(RUN)('R-01B-8 DAL purchase_receipt preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-8 Integration Tenant','r01b8-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-8 Integration Workspace','r01b8-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b8-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-8 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b8-biz')]
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
      name: 'R-01B-8 manual source',
      sourceCode: unique('r01b8-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b8',
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

  const BO = 'business_operations';
  let seq8 = 0;
  interface World { po: string; poLine: string; warehouse: string; itemA: string; itemB: string }
  const world = async (forBusiness: string = businessId): Promise<World> => {
    const sup = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,'R-01B-8 Supplier',$4,'low','active') RETURNING id`,
      [T1, WS1, forBusiness, unique(`r01b8-sup-${++seq8}`)])).rows[0].id;
    const po = (await adminPool.query<{ id: string }>(
      `INSERT INTO ${BO}.purchase_orders (tenant_id, workspace_id, business_id, supplier_id, po_number, currency_code) VALUES ($1,$2,$3,$4,$5,'USD') RETURNING id`,
      [T1, WS1, forBusiness, sup, unique('PO')])).rows[0].id;
    const poLine = (await adminPool.query<{ id: string }>(
      `INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity) VALUES ($1,$2,$3,$4,1,'PO line',100) RETURNING id`,
      [T1, WS1, forBusiness, po])).rows[0].id;
    const warehouse = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`,
      [T1, WS1, forBusiness, unique('WH')])).rows[0].id;
    const item = async () => (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`,
      [T1, WS1, forBusiness, unique('SKU')])).rows[0].id;
    return { po, poLine, warehouse, itemA: await item(), itemB: await item() };
  };
  const receipt = (w: World, data: Record<string, unknown> = {}) => ({
    recordType: 'purchase_receipt',
    data: {
      purchaseOrderId: w.po, warehouseId: w.warehouse, receiptNumber: unique('GRN'), receivedAt: '2026-10-01T09:30:00.250Z',
      lines: [{ inventoryItemId: w.itemA, quantity: 10 }], ...data,
    },
  });
  const header = async (number: string) => (await adminPool.query(
    `SELECT id, tenant_id, workspace_id, business_id, purchase_order_id, warehouse_id, receipt_number, received_at, notes FROM ${BO}.purchase_receipts WHERE business_id=$1 AND receipt_number=$2`, [businessId, number])).rows;
  const lineRows = async (receiptId: string) => (await adminPool.query(
    `SELECT l.line_number, l.purchase_order_line_id, l.inventory_item_id, l.quantity::text AS quantity, l.unit_cost::text AS unit_cost, l.unit_cost_currency,
            m.movement_type, m.reference_type, m.quantity::text AS movement_quantity, m.occurred_at
       FROM ${BO}.purchase_receipt_lines l JOIN ${BO}.inventory_movements m ON m.id = l.inventory_movement_id WHERE l.purchase_receipt_id=$1 ORDER BY l.line_number`, [receiptId])).rows;
  const movementCount = async () => Number((await adminPool.query(`SELECT count(*) AS n FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [T1])).rows[0].n);

  it('hands prepared receipts to BO through the existing ingestion contract: BO accepts them and writes exactly the prepared values, scoped by the authenticated context', async () => {
    const w = await world();
    const number = unique('GRN-A');
    const handoff = await createPublishedHandoff([
      receipt(w, { receiptNumber: ` ${number} `, receivedAt: '2026-10-01T11:30:00.25+02:00', notes: ' dock 3 ',
        lines: [
          { inventoryItemId: w.itemA, quantity: ' 10.50 ', unitCost: '2.50', unitCostCurrency: 'USD' },
          { inventoryItemId: w.itemB, quantity: 4.25 },
        ] }),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.acceptedRecordCount).toBe(1);
    expect(result.results.map((r) => r.commandType)).toEqual(['record_purchase_receipt']);
    const [h] = await header(number);
    expect(h).toMatchObject({ tenant_id: T1, workspace_id: WS1, business_id: businessId, purchase_order_id: w.po, warehouse_id: w.warehouse, notes: 'dock 3' });
    expect(new Date(h.received_at).toISOString()).toBe('2026-10-01T09:30:00.250Z');
    const lines = await lineRows(h.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line_number: 1, purchase_order_line_id: null, inventory_item_id: w.itemA, quantity: '10.5000', unit_cost: '2.5000', unit_cost_currency: 'USD', movement_type: 'receipt', reference_type: 'purchase_receipt', movement_quantity: '10.5000' });
    expect(lines[1]).toMatchObject({ line_number: 2, purchase_order_line_id: null, inventory_item_id: w.itemB, quantity: '4.2500', unit_cost: null, unit_cost_currency: null });
    for (const l of lines) expect(new Date(l.occurred_at).toISOString()).toBe('2026-10-01T09:30:00.250Z');

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('the optional order-line link: BO stores it on the legacy path, the prepared path quarantines the record (frozen Block D guard), and nothing reaches BO', async () => {
    const w = await world();
    const linked = (number: string) => receipt(w, { receiptNumber: number, lines: [{ purchaseOrderLineId: w.poLine, inventoryItemId: w.itemA, quantity: 2 }] });
    const legacyNumber = unique('GRN-LINK');
    await bo.processHandoff(ctx, await createPublishedHandoff([linked(legacyNumber)], 'operations'));
    expect((await lineRows((await header(legacyNumber))[0].id))[0]).toMatchObject({ purchase_order_line_id: w.poLine });

    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-8 link', sourceCode: unique('r01b8-l'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const preparedNumber = unique('GRN-LINKP');
    const intake = await da.submitManualIntake(ctx, { businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE, records: [linked(preparedNumber)] });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await header(preparedNumber)).toEqual([]);
  });

  it('numeric boundaries survive the real numeric(18,4) columns exactly', async () => {
    const w = await world();
    const number = unique('GRN-B');
    await bo.processHandoff(ctx, await createPublishedHandoff([
      receipt(w, { receiptNumber: number, lines: [
        { inventoryItemId: w.itemA, quantity: '0.0001', unitCost: '0.0001', unitCostCurrency: 'KWD' },
        { inventoryItemId: w.itemB, quantity: '12345678901234.5', unitCost: '99999999999999', unitCostCurrency: 'EUR' },
      ] }),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    const lines = await lineRows((await header(number))[0].id);
    expect(lines.map((l) => [l.quantity, l.unit_cost])).toEqual([['0.0001', '0.0001'], ['12345678901234.5000', '99999999999999.0000']]);
  });

  it('owner ruling evidence: an upper-case UUID is refused by BO on the legacy path (raw) and by the DAL on the prepared path (never case-folded); nothing is written', async () => {
    const w = await world();
    const before = await movementCount();
    const upper = receipt(w, { receiptNumber: unique('GRN-UC'), purchaseOrderId: w.po.toUpperCase() });
    const legacy = await bo.processHandoff(ctx, await createPublishedHandoff([upper], 'operations')).then(() => null, (e: unknown) => e);
    expect(legacy).toBeInstanceOf(OperationalMappingError);
    expect((legacy as Error).message).toMatch(/purchaseOrderId_invalid/);

    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-8 upper', sourceCode: unique('r01b8-u'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, { businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE, records: [upper] });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await movementCount()).toBe(before);
  });

  it('contrast: the legacy path stores the raw, unprepared receipt number (the preparer is what trims it)', async () => {
    const w = await world();
    const padded = ` ${unique('GRN-LEG')} `;
    const legacy = await bo.processHandoff(ctx, await createPublishedHandoff([receipt(w, { receiptNumber: padded })], 'operations')).then(() => null, (e: unknown) => e);
    expect(legacy).toBeInstanceOf(OperationalMappingError); // BO itself requires a trimmed number; the raw record is refused, the prepared one is trimmed first
    const number = unique('GRN-TRIM');
    await bo.processHandoff(ctx, await createPublishedHandoff([receipt(w, { receiptNumber: ` ${number} ` })], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(await header(number)).toHaveLength(1);
  });

  it('malformed receipts are refused by the DAL before any handoff, and a quarantined run cannot be published or write', async () => {
    const w = await world();
    const before = await movementCount();
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-8 quarantine', sourceCode: unique('r01b8-q'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const good = unique('GRN-Q');
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [receipt(w, { receiptNumber: good }), receipt(w, { lines: [] }), receipt(w, { lines: [{ inventoryItemId: w.itemA, quantity: '1.00001' }] }), receipt(w, { receivedAt: '2026-10-01' })],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(await header(good)).toEqual([]);
    expect(await movementCount()).toBe(before);
  });

  it('BO stays the authority on existence, scope and time: an unknown order, a foreign-business warehouse and a future instant are all refused by BO, atomically', async () => {
    const w = await world();
    const before = await movementCount();
    const okNumber = unique('GRN-OK');
    const missing = '12345678-1234-4234-8234-123456789abc';
    for (const bad of [
      receipt(w, { receiptNumber: unique('GRN-NOPO'), purchaseOrderId: missing }),
      receipt(w, { receiptNumber: unique('GRN-FUT'), receivedAt: '2999-01-01T00:00:00Z' }),
    ]) {
      const handoff = await createPublishedHandoff([receipt(w, { receiptNumber: okNumber }), bad], OPERATIONS_PREPARED_SUBMISSION_TYPE);
      await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
      expect(await header(okNumber)).toEqual([]); // the good receipt was rolled back with the bad one
      expect(await movementCount()).toBe(before);
    }
  });

  it('business isolation: an order, warehouse or item of another business of the same tenant is refused by BO', async () => {
    const other = (await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'R-01B-8 other business',$3,'active') RETURNING id`,
      [T1, WS1, unique('r01b8-other')])).rows[0].id;
    try {
      const foreign = await world(other);
      const number = unique('GRN-FOREIGN');
      const handoff = await createPublishedHandoff([receipt(foreign, { receiptNumber: number })], OPERATIONS_PREPARED_SUBMISSION_TYPE);
      await expect(bo.processHandoff(ctx, handoff)).rejects.toBeInstanceOf(OperationalMappingError);
      expect(await header(number)).toEqual([]);
    } finally {
      await deleteMovementsForTenants(adminPool, [T1]);
      await adminPool.query(`DELETE FROM ${BO}.purchase_order_line_items WHERE business_id = $1`, [other]);
      await adminPool.query(`DELETE FROM ${BO}.purchase_orders WHERE business_id = $1`, [other]);
      for (const t of ['inventory_items', 'warehouses', 'suppliers']) await adminPool.query(`DELETE FROM platform.${t} WHERE business_id = $1`, [other]);
      await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [other]);
    }
  });

  it('identity stays with BO (no DAL duplicate rule): an identical receipt in a later package is a no-op replay, a different one with the same number is refused', async () => {
    const w = await world();
    const number = unique('GRN-REPLAY');
    const original = receipt(w, { receiptNumber: number });
    await bo.processHandoff(ctx, await createPublishedHandoff([original], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    const before = await movementCount();
    const replay = await bo.processHandoff(ctx, await createPublishedHandoff([original], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(replay.acceptedRecordCount).toBe(1);
    expect(await header(number)).toHaveLength(1);
    expect(await movementCount()).toBe(before); // nothing was written twice

    const conflicting = receipt(w, { receiptNumber: number, lines: [{ inventoryItemId: w.itemA, quantity: 11 }] });
    const refused = await bo.processHandoff(ctx, await createPublishedHandoff([conflicting], OPERATIONS_PREPARED_SUBMISSION_TYPE)).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(OperationalMappingError);
    expect((refused as Error).message).toMatch(/already exists with different content/);
    expect(await movementCount()).toBe(before);
  });
});
