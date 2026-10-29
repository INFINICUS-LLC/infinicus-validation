import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService, OperationalRecordPreparer, detectPreparedKeyFindings, hashRecord } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-3b02-0000-0000-000000000001';
const WS1 = '32222222-3b02-0000-0000-000000000002';
const UID = '32222222-3b02-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // R-01B-2 outputs first.
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

describe.runIf(RUN)('R-01B-2 DAL key findings agree with Business Operations', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'R-01B-2 Integration Tenant','r01b2-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'R-01B-2 Integration Workspace','r01b2-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, email, status)
       VALUES ($1,'r01b2-integration@example.test','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'R-01B-2 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('r01b2-biz')]
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
      name: 'R-01B-2 manual source',
      sourceCode: unique('r01b2-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType,
      records: customRecords,
      sourceReference: 'integration://r01b2',
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

  const preparer = new OperationalRecordPreparer();
  let n = 0;
  const item = (sku: string, data: Record<string, unknown> = {}) => ({ recordType: 'inventory_item', data: { sku, name: 'Widget', ...data } });
  const wh = (code: string, data: Record<string, unknown> = {}) => ({ recordType: 'warehouse', data: { warehouseCode: code, name: 'Main', ...data } });

  /** What the DAL says about the batch: the worst group kind, or 'NONE'. */
  function dalVerdict(records: unknown[]): 'NONE' | 'EXACT_DUPLICATE' | 'CONFLICT' {
    const outcomes = preparer.prepareBatch(records);
    expect(outcomes.every((o) => o.prepared), 'fixture records must prepare cleanly').toBe(true);
    const found = detectPreparedKeyFindings(outcomes.map((o) => {
      const raw = records[o.recordIndex] as { data: Record<string, unknown> };
      const key = raw.data[o.prepared!.recordType === 'warehouse' ? 'warehouseCode' : 'sku'];
      return { recordIndex: o.recordIndex, prepared: o.prepared!, rawHash: hashRecord(raw), preparedHash: hashRecord(o.prepared), rawKeyText: typeof key === 'string' ? key : null };
    }));
    if (found.groups.some((g) => g.kind === 'CONFLICT')) return 'CONFLICT';
    return found.groups.length > 0 ? 'EXACT_DUPLICATE' : 'NONE';
  }

  /** What Business Operations does with the same records (already in prepared form), in the same order, through the real intake path. */
  async function boVerdict(records: unknown[]): Promise<'ACCEPTED' | 'REFUSED'> {
    // 'operations' = structural validation only, so BO alone decides; the records are already prepared-shaped.
    const handoff = await createPublishedHandoff(records, 'operations');
    try {
      await bo.processHandoff(ctx, handoff);
      return 'ACCEPTED';
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalMappingError);
      return 'REFUSED';
    }
  }

  const cases: Array<[string, (s: string) => unknown[], 'NONE' | 'EXACT_DUPLICATE' | 'CONFLICT']> = [
    ['identical items', (s) => [item(`I-${s}`), item(`I-${s}`)], 'EXACT_DUPLICATE'],
    ['same sku, different name', (s) => [item(`I-${s}`), item(`I-${s}`, { name: 'Other' })], 'CONFLICT'],
    ['same sku, different explicit unitOfMeasure', (s) => [item(`I-${s}`, { unitOfMeasure: 'each' }), item(`I-${s}`, { unitOfMeasure: 'box' })], 'CONFLICT'],
    ['anchor states no unitOfMeasure, later states a different one', (s) => [item(`I-${s}`), item(`I-${s}`, { unitOfMeasure: 'each' })], 'CONFLICT'],
    ['anchor states one, later states none', (s) => [item(`I-${s}`, { unitOfMeasure: 'each' }), item(`I-${s}`)], 'EXACT_DUPLICATE'],
    ['anchor states none, later states the default "unit"', (s) => [item(`I-${s}`), item(`I-${s}`, { unitOfMeasure: 'unit' })], 'EXACT_DUPLICATE'],
    ['identical warehouses', (s) => [wh(`W-${s}`), wh(`W-${s}`)], 'EXACT_DUPLICATE'],
    ['same warehouseCode, different name', (s) => [wh(`W-${s}`), wh(`W-${s}`, { name: 'Annex' })], 'CONFLICT'],
    ['keys differing only by case are distinct', (s) => [item(`i-${s}`), item(`I-${s}`)], 'NONE'],
    ['conflict in the third occurrence', (s) => [item(`I-${s}`), item(`I-${s}`), item(`I-${s}`, { name: 'Other' })], 'CONFLICT'],
    ['unrelated keys', (s) => [item(`I-${s}`), wh(`W-${s}`)], 'NONE'],
  ];

  it.each(cases)('DAL and BO agree: %s', async (_label, build, expected) => {
    const records = build(String(++n));
    const dal = dalVerdict(records);
    expect(dal).toBe(expected);
    const outcome = await boVerdict(records);
    // CONFLICT <=> BO refuses; everything else (duplicates BO treats as idempotent, distinct keys) <=> BO accepts.
    expect(outcome).toBe(dal === 'CONFLICT' ? 'REFUSED' : 'ACCEPTED');
  });

  it('a BO refusal is atomic: no half-written master data from a conflicting batch', async () => {
    const records = [item('ATOM-1'), item('ATOM-1', { name: 'Other' })];
    expect(await boVerdict(records)).toBe('REFUSED');
    const rows = await adminPool.query(`SELECT count(*)::int AS n FROM platform.inventory_items WHERE business_id=$1 AND sku='ATOM-1'`, [businessId]);
    expect(rows.rows[0].n).toBe(0);
  });
});
