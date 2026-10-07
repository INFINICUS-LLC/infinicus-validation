/**
 * Integration test harness for @infinicus/data-acquisition-runtime, mirroring
 * packages/database/tests/helpers/integration.ts's pattern for this
 * package's own live-Postgres tests.
 *
 * Requires two environment variables:
 *   DATABASE_URL       — non-superuser (app_test), RLS enforced
 *   ADMIN_DATABASE_URL — BYPASSRLS user (admin_test), for fixtures
 *
 * Guard all integration suites with:
 *   const run = !!process.env.DATABASE_URL;
 *   describe.runIf(run)('...', () => { ... });
 */

import { Pool } from 'pg';
import { createPool, closePool } from '@infinicus/database';

export const T1  = '22222222-3c3c-0000-0000-000000000001';
export const WS1 = '22222222-3c3c-0000-0000-000000000002';
export const UID = '22222222-3c3c-0000-0000-000000000099';

export const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };

let adminPool: Pool | null = null;
let businessId: string | null = null;

export async function setupIntegration(): Promise<{ businessId: string }> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });
  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'DA Runtime Int-Test Tenant','da-runtime-int-t1','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'DA Runtime Int-Test WS','da-runtime-int-ws1','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1]
  );
  const biz = await adminPool.query<{ id: string }>(
    `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status)
     VALUES ($1,$2,'DA Runtime Test Biz',$3,'active')
     RETURNING id`,
    [T1, WS1, uniqueCode('da-runtime-biz')]
  );
  businessId = biz.rows[0].id;
  return { businessId };
}

export async function teardownIntegration(): Promise<void> {
  if (adminPool) {
    const tenantFilter = [T1];
    const clean = async (sql: string, params: unknown[] = [tenantFilter]) => adminPool!.query(sql, params);

    await clean(`DELETE FROM data_acquisition.transformation_records
                 WHERE provenance_record_id IN (
                   SELECT id FROM data_acquisition.provenance_records WHERE tenant_id = ANY($1)
                 )`);
    await clean(`DELETE FROM data_acquisition.provenance_records       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.publication_packages     WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.data_quality_scores      WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.validation_issues
                 WHERE validation_result_id IN (
                   SELECT id FROM data_acquisition.validation_results WHERE tenant_id = ANY($1)
                 )`);
    await clean(`DELETE FROM data_acquisition.validation_results       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.manual_submissions       WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.webhook_receipts         WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.collection_runs          WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.connectors               WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.data_sources             WHERE tenant_id = ANY($1)`);
    if (businessId) {
      await adminPool.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
    }

    await adminPool.end();
    adminPool = null;
    businessId = null;
  }
  await closePool();
}

let seq = 0;
export function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}
