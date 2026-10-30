import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OPERATIONS_PREPARED_SUBMISSION_TYPE } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-4c04-0000-0000-000000000001';
const WS1 = '32222222-4c04-0000-0000-000000000002';
const UID = '32222222-4c04-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-4 outputs first.
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

describe.runIf(RUN)('R-01B-4 DAL operational_fact preparation to BO handoff', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-4 Integration Tenant','r01b4-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-4 Integration Workspace','r01b4-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b4-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-4 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b4-biz')]
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
      name: 'R-01B-4 manual source',
      sourceCode: unique('r01b4-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b4',
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

  const fact = (data: Record<string, unknown> = {}) => ({ recordType: 'operational_fact', data: { eventType: 'sale', ...data } });
  const factRows = async (note: string) => (await adminPool.query(
    `SELECT tenant_id, workspace_id, business_id, event_type, amount::text AS amount, quantity::text AS quantity, category, customer_id, member_id, action, notes
       FROM business_operations.business_events WHERE business_id = $1 AND notes = $2`, [businessId, note])).rows;

  it('hands prepared operational facts to BO through the existing ingestion contract: BO accepts them and writes exactly the prepared values, scoped by the authenticated context', async () => {
    const n1 = unique('fact-A'); const n2 = unique('fact-B');
    const handoff = await createPublishedHandoff([
      fact({ eventType: ' SALE ', amount: ' 1250.50 ', quantity: '3', category: '  retail ', customerId: ' C-001 ', action: ' New ', notes: ` ${n1} ` }),
      fact({ eventType: 'team', memberId: 'm-7', action: 'hire', notes: n2 }),
    ], OPERATIONS_PREPARED_SUBMISSION_TYPE);
    const result = await bo.processHandoff(ctx, handoff);

    expect(result.acceptedRecordCount).toBe(2);
    expect(result.results.map((r) => r.commandType)).toEqual(['record_operational_fact', 'record_operational_fact']);
    expect(await factRows(n1)).toEqual([{
      tenant_id: T1, workspace_id: WS1, business_id: businessId, event_type: 'sale', amount: '1250.5000', quantity: '3.0000',
      category: 'retail', customer_id: 'C-001', member_id: null, action: 'new', notes: n1,
    }]);
    expect((await factRows(n2))[0]).toMatchObject({ event_type: 'team', amount: null, quantity: null, member_id: 'm-7', action: 'hire', tenant_id: T1, business_id: businessId });

    const delivery = await adminPool.query(
      `SELECT delivery_status FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1 AND destination_reference='business_operations'`,
      [handoff.payload.publicationPackageId]);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
  });

  it('amount and quantity survive the real numeric(18,4) columns exactly, including zero, negatives and both ends of the range', async () => {
    const cases: Array<[string | number, string]> = [['99999999999999.9999', '99999999999999.9999'], ['0.0001', '0.0001'], [0, '0.0000'], ['-12.5', '-12.5000'], ['-0.0001', '-0.0001']];
    // 99999999999999.9999 is not an exact double, so the preparer must refuse it; the remaining cases must round-trip.
    const exact = cases.filter(([v]) => v !== '99999999999999.9999');
    const notes = exact.map(() => unique('bnd'));
    const handoff = await createPublishedHandoff(exact.map(([v], i) => fact({ eventType: 'expense', amount: v, quantity: v, notes: notes[i] })), OPERATIONS_PREPARED_SUBMISSION_TYPE);
    await bo.processHandoff(ctx, handoff);
    for (const [i, [, expected]] of exact.entries()) {
      expect(await factRows(notes[i])).toEqual([expect.objectContaining({ amount: expected, quantity: expected })]);
    }
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-4 inexact', sourceCode: unique('r01b4-inx'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, { businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE, records: [fact({ amount: '99999999999999.9999' })] });
    expect(intake.state).toBe('quarantined');
  });

  it('text identifiers are text, not uuids: non-uuid customerId / memberId pass the DAL and BO and are stored verbatim', async () => {
    const note = unique('txt');
    await bo.processHandoff(ctx, await createPublishedHandoff([fact({ eventType: 'customer', customerId: 'CUST-123/é', memberId: 'not-a-uuid', notes: note })], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(await factRows(note)).toEqual([expect.objectContaining({ customer_id: 'CUST-123/é', member_id: 'not-a-uuid' })]);
  });

  it('contrast: the legacy path stores the raw, unprepared values (the preparer is what trims and lower-cases them)', async () => {
    const note = unique('legacy');
    const handoff = await createPublishedHandoff([fact({ category: '  padded  ', notes: note })], 'operations');
    await bo.processHandoff(ctx, handoff);
    expect(await factRows(note)).toEqual([expect.objectContaining({ category: '  padded  ' })]);
  });

  it('malformed facts are refused by the DAL before any handoff, and a quarantined run cannot be published', async () => {
    const before = Number((await adminPool.query(`SELECT count(*) AS n FROM business_operations.business_events WHERE tenant_id=$1`, [T1])).rows[0].n);
    const source = await da.registerSource(ctx, { businessId, name: 'R-01B-4 quarantine', sourceCode: unique('r01b4-q'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    const intake = await da.submitManualIntake(ctx, {
      businessId, dataSourceId: source.id, submissionType: OPERATIONS_PREPARED_SUBMISSION_TYPE,
      records: [fact({ notes: unique('ok') }), fact({ eventType: 'refund' }), fact({ amount: '1.23456' }), fact({ occurredAt: '2026-01-01T00:00:00Z' })],
    });
    expect(intake.state).toBe('quarantined');
    await expect(da.preparePublicationPackage(ctx, businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' })).rejects.toBeDefined();
    expect(Number((await adminPool.query(`SELECT count(*) AS n FROM business_operations.business_events WHERE tenant_id=$1`, [T1])).rows[0].n)).toBe(before);
  });

  it('no identity rule, no duplicate reporting: identical prepared facts are both accepted and both stored (BO is the sole mutation authority)', async () => {
    const note = unique('dup');
    const result = await bo.processHandoff(ctx, await createPublishedHandoff([fact({ amount: 10, notes: note }), fact({ amount: 10, notes: note })], OPERATIONS_PREPARED_SUBMISSION_TYPE));
    expect(result.acceptedRecordCount).toBe(2);
    expect(await factRows(note)).toHaveLength(2);
  });
});
