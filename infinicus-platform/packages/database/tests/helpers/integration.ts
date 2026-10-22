/**
 * Integration test harness for @infinicus/database repository tests.
 *
 * Requires two environment variables:
 *   DATABASE_URL       — non-superuser (app_test_user), RLS enforced
 *   ADMIN_DATABASE_URL — BYPASSRLS user (infinicus_test_admin), for fixtures
 *
 * Guard all integration suites with:
 *   const run = !!process.env.DATABASE_URL;
 *   describe.runIf(run)('...', () => { ... });
 */

import { Pool } from 'pg';
import { createPool, closePool } from '../../src/client.js';

// Fixed UUIDs so fixtures are deterministic and re-entrant
export const T1  = '11111111-2b2b-0000-0000-000000000001'; // tenant 1
export const WS1 = '11111111-2b2b-0000-0000-000000000002'; // workspace 1
export const T2  = '11111111-2b2b-0000-0000-000000000003'; // tenant 2 (isolation)
export const WS2 = '11111111-2b2b-0000-0000-000000000004'; // workspace 2
export const UID = '11111111-2b2b-0000-0000-000000000099'; // user id

export const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
export const ctx2 = { tenantId: T2, workspaceId: WS2, userId: UID };

let adminPool: Pool | null = null;

/** Set up pools and insert tenant/workspace fixtures. Call in beforeAll. */
export async function setupIntegration(): Promise<void> {
  const appUrl   = process.env.DATABASE_URL!;
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;

  createPool({ connectionString: appUrl });

  adminPool = new Pool({ connectionString: adminUrl });

  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
     VALUES ($1,'Int-Test Tenant 1','int-t1','active','test'),
            ($2,'Int-Test Tenant 2','int-t2','active','test')
     ON CONFLICT (id) DO NOTHING`,
    [T1, T2]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
     VALUES ($1,$2,'Int-Test WS 1','int-ws1','active'),
            ($3,$4,'Int-Test WS 2','int-ws2','active')
     ON CONFLICT (id) DO NOTHING`,
    [WS1, T1, WS2, T2]
  );
}

/** Clean up all DA rows owned by test tenants and close pools. Call in afterAll. */
/**
 * End the pools WITHOUT sweeping the shared fixed tenants. For a suite that runs in parallel with another suite on T1/T2 and cleans up exactly the rows it
 * created: the tenant-wide sweep of teardownIntegration() would delete rows the other suite still depends on, or fail on the foreign keys they hold.
 * (Not an options parameter on teardownIntegration: suites pass it straight to afterAll, and vitest calls hooks with a context argument.)
 */
export async function endIntegration(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
  await closePool();
}

export async function teardownIntegration(): Promise<void> {
  if (adminPool) {
    // Delete in leaf→root order to respect FK constraints.
    // Admin pool has BYPASSRLS so it can see all rows.
    const tenantFilter = [T1, T2];
    // Wrap in outer array so pg sends $1 = array (not $1,$2 = two scalars)
    const clean = async (sql: string) => adminPool!.query(sql, [tenantFilter]);

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
    await clean(`DELETE FROM data_acquisition.api_collection_runs
                 WHERE collection_run_id IN (
                   SELECT id FROM data_acquisition.collection_runs WHERE tenant_id = ANY($1)
                 )`);
    await clean(`DELETE FROM data_acquisition.stream_events            WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.webhook_receipts         WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.collection_runs          WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.connectors               WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.data_sources             WHERE tenant_id = ANY($1)`);

    await adminPool.end();
    adminPool = null;
  }
  await closePool();
}

/** Unique source code per test run to avoid UNIQUE conflicts across re-runs. */
let seq = 0;
export function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}
