import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  closePool,
  createPool,
  type TenantContext,
} from '@infinicus/database';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { BusinessIntakeRejectedError } from '../src/errors.js';

const RUN = !!process.env.DATABASE_URL;

const T1 = '32222222-3200-0000-0000-000000000001';
const WS1 = '32222222-3200-0000-0000-000000000002';
const UID = '32222222-3200-0000-0000-000000000003';

const ctx: TenantContext = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool;
let businessId: string;
let seq = 0;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function cleanTenant(): Promise<void> {
  const tenantIds = [T1];

  // BUILD-32 outputs first.
  await adminPool.query(
    `DELETE FROM data_acquisition.publication_deliveries
     WHERE publication_package_id IN (
       SELECT id FROM data_acquisition.publication_packages WHERE tenant_id = ANY($1)
     )`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.business_events WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
  await adminPool.query(
    `DELETE FROM business_operations.inventory_movements WHERE tenant_id = ANY($1)`,
    [tenantIds]
  );
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
    await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
  }
  await adminPool.query(`DELETE FROM identity.users WHERE id = $1`, [UID]);
  await adminPool.query(`DELETE FROM tenancy.workspaces WHERE id = $1`, [WS1]);
  await adminPool.query(`DELETE FROM tenancy.tenants WHERE id = $1`, [T1]);
}

describe.runIf(RUN)('BUILD-32 DA to BO vertical integration', () => {
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'BUILD-32 Integration Tenant','build32-int-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'BUILD-32 Integration Workspace','build32-int-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );
    await adminPool.query(
      `INSERT INTO identity.users
         (id, tenant_id, email, display_name, status)
       VALUES ($1,$2,'build32-integration@example.test','BUILD-32 Integration User','active')
       ON CONFLICT (id) DO NOTHING`,
      [UID, T1]
    );
    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'BUILD-32 Integration Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('build32-biz')]
    );
    businessId = biz.rows[0].id;
  });

  afterAll(async () => {
    await cleanTenant();
    await adminPool.end();
    await closePool();
  });

  async function createPublishedHandoff(): Promise<DALToBOHandoff> {
    const source = await da.registerSource(ctx, {
      businessId,
      name: 'BUILD-32 manual source',
      sourceCode: unique('build32-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });

    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType: 'operations',
      records: [
        {
          recordType: 'operational_fact',
          data: {
            eventType: 'sale',
            amount: 125.5,
            quantity: 2,
            category: 'integration-sale',
            notes: 'BUILD-32 DA to BO vertical test',
          },
        },
      ],
      sourceReference: 'integration://build32',
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

  it('consumes a real BUILD-31 publication atomically and records a delivered receipt', async () => {
    const handoff = await createPublishedHandoff();

    const result = await bo.processHandoff(ctx, handoff);

    expect(result.idempotentReplay).toBe(false);
    expect(result.acceptedRecordCount).toBe(1);
    expect(result.commandCount).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].commandType).toBe('record_operational_fact');

    const sale = await adminPool.query<{ amount: string; quantity: string; category: string }>(
      `SELECT amount, quantity, category
       FROM business_operations.business_events
       WHERE tenant_id = $1 AND business_id = $2 AND event_type = 'sale'
       ORDER BY created_at DESC
       LIMIT 1`,
      [T1, businessId]
    );
    expect(sale.rowCount).toBe(1);
    expect(Number(sale.rows[0].amount)).toBeCloseTo(125.5, 2);
    expect(Number(sale.rows[0].quantity)).toBe(2);
    expect(sale.rows[0].category).toBe('integration-sale');

    const delivery = await adminPool.query<{ delivery_status: string; attempt_count: number }>(
      `SELECT delivery_status, attempt_count
       FROM data_acquisition.publication_deliveries
       WHERE publication_package_id = $1
         AND destination_type = 'layer'
         AND destination_reference = 'business_operations'`,
      [handoff.payload.publicationPackageId]
    );
    expect(delivery.rowCount).toBe(1);
    expect(delivery.rows[0].delivery_status).toBe('delivered');
    expect(delivery.rows[0].attempt_count).toBe(1);
  });

  it('treats replay of an already delivered DA package as a no-op', async () => {
    const handoff = await createPublishedHandoff();

    const first = await bo.processHandoff(ctx, handoff);
    const before = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM business_operations.business_events
       WHERE tenant_id = $1 AND business_id = $2 AND correlation_id = $3`,
      [T1, businessId, handoff.correlationId]
    );

    const second = await bo.processHandoff(ctx, handoff);
    const after = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM business_operations.business_events
       WHERE tenant_id = $1 AND business_id = $2 AND correlation_id = $3`,
      [T1, businessId, handoff.correlationId]
    );

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.commandCount).toBe(0);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('rejects a handoff whose active tenant/workspace does not match the payload', async () => {
    const handoff = await createPublishedHandoff();
    const wrongCtx: TenantContext = {
      tenantId: '32222222-3200-0000-0000-000000000099',
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    };

    await expect(bo.processHandoff(wrongCtx, handoff))
      .rejects.toBeInstanceOf(BusinessIntakeRejectedError);
  });
});
