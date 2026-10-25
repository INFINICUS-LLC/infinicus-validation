/**
 * Live PostgreSQL 16 test for BUILD-26's right-to-erasure requirement:
 * infrastructure/database/scripts/delete-tenant-data.mjs. Creates a real
 * scratch tenant with cross-schema data, runs the real script (not a
 * reimplementation), and verifies: (a) the tenant's own data is fully
 * gone, (b) a real audit record was written, and — the critical safety
 * property this build's own live testing caught a bug in — (c) every
 * OTHER tenant's data, and every platform-shared row (system roles),
 * survives completely untouched.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const run = !!process.env.DATABASE_URL;

const DELETE_SCRIPT = resolve(__dirname, '../../../infrastructure/database/scripts/delete-tenant-data.mjs');

describe.runIf(run)('delete-tenant-data.mjs — live PostgreSQL', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('deletes a tenant\'s full data footprint while leaving other tenants and shared system roles untouched', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const otherTenantId = randomUUID();
    const otherWorkspaceId = randomUUID();

    // Two tenants: one to delete, one that must survive untouched — the
    // real regression this build's own testing caught (a blanket DELETE
    // relying only on RLS visibility would have deleted every tenant's
    // shared system roles via tenancy.roles' nullable-tenant policy).
    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Delete-Me Tenant',$2,'active','test')`,
      [tenantId, `delete-me-${tenantId}`]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Delete-Me WS',$3,'active')`,
      [workspaceId, tenantId, `delete-me-ws-${tenantId}`]
    );
    await adminPool.query(
      `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status, industry, correlation_id)
       VALUES ($1,$2,$3,'Delete-Me Biz','DEL-BIZ',$4,'tech',gen_random_uuid())`,
      [randomUUID(), tenantId, workspaceId, 'active']
    );

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Survivor Tenant',$2,'active','test')`,
      [otherTenantId, `survivor-${otherTenantId}`]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Survivor WS',$3,'active')`,
      [otherWorkspaceId, otherTenantId, `survivor-ws-${otherTenantId}`]
    );

    const systemRolesBefore = await adminPool.query(`SELECT count(*)::int AS n FROM tenancy.roles WHERE tenant_id IS NULL`);

    const governedTables = [
      'governed_measurement_definitions', 'governed_outcome_verdicts', 'om24_publication_receipts',
    ];
    for (const name of governedTables) {
      const table = `outcome_monitoring.${name}`;
      const state = await adminPool.query(`SELECT count(*)::int AS rows,
        has_table_privilege('app_test_user',$1,'DELETE') AS can_delete,
        (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=$1::regclass) AS forced_rls,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND (tgtype & 8) = 8) AS delete_guards
        FROM ${table} WHERE tenant_id=$2`, [table, tenantId]);
      expect(state.rows[0]).toMatchObject({ rows: 0, can_delete: false, forced_rls: true, delete_guards: 1 });
    }

    const { stdout } = await execFileAsync('node', [DELETE_SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
        TENANT_ID: tenantId,
        DELETED_BY: 'vitest-integration-test',
      },
    });
    expect(stdout).toContain(`Deleted tenant ${tenantId}`);

    const tenantGone = await adminPool.query('SELECT count(*)::int AS n FROM tenancy.tenants WHERE id = $1', [tenantId]);
    const workspaceGone = await adminPool.query('SELECT count(*)::int AS n FROM tenancy.workspaces WHERE tenant_id = $1', [tenantId]);
    const businessGone = await adminPool.query('SELECT count(*)::int AS n FROM platform.businesses WHERE tenant_id = $1', [tenantId]);
    expect(tenantGone.rows[0].n).toBe(0);
    expect(workspaceGone.rows[0].n).toBe(0);
    expect(businessGone.rows[0].n).toBe(0);

    const otherTenantSurvives = await adminPool.query('SELECT count(*)::int AS n FROM tenancy.tenants WHERE id = $1', [otherTenantId]);
    const otherWorkspaceSurvives = await adminPool.query('SELECT count(*)::int AS n FROM tenancy.workspaces WHERE tenant_id = $1', [otherTenantId]);
    expect(otherTenantSurvives.rows[0].n).toBe(1);
    expect(otherWorkspaceSurvives.rows[0].n).toBe(1);

    const systemRolesAfter = await adminPool.query(`SELECT count(*)::int AS n FROM tenancy.roles WHERE tenant_id IS NULL`);
    expect(systemRolesAfter.rows[0].n).toBe(systemRolesBefore.rows[0].n);

    const auditRow = await adminPool.query(
      'SELECT tenant_name, deleted_by, table_row_counts FROM platform.data_deletion_events WHERE tenant_id = $1',
      [tenantId]
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0].tenant_name).toBe('Delete-Me Tenant');
    expect(auditRow.rows[0].deleted_by).toBe('vitest-integration-test');
    for (const name of governedTables) {
      expect(auditRow.rows[0].table_row_counts.retainedRowCounts[`outcome_monitoring.${name}`]).toBe(0);
      expect(auditRow.rows[0].table_row_counts.blockedByRetainedDependents[`outcome_monitoring.${name}`]).toBeUndefined();
    }
    expect(auditRow.rows[0].table_row_counts.remainingRows).toEqual({});
    const password = new URL(process.env.DATABASE_URL!).password;
    if (password) expect(JSON.stringify(auditRow.rows[0].table_row_counts)).not.toContain(password);

    // Cleanup the surviving fixture tenant (not touched by the script under test).
    await adminPool.query('DELETE FROM tenancy.workspaces WHERE tenant_id = $1', [otherTenantId]);
    await adminPool.query('DELETE FROM tenancy.tenants WHERE id = $1', [otherTenantId]);
  }, 120_000);

  it('reports partial erasure when an append-only tenant row remains without an FK', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const survivorId = randomUUID();
    const table = 'business_operations.erasure_retained_fixture';
    await adminPool.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, marker text NOT NULL)`);
    await adminPool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await adminPool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await adminPool.query(`CREATE POLICY erasure_retained_scope ON ${table} USING (tenant_id = current_setting('app.tenant_id',true)::uuid)`);
    await adminPool.query(`CREATE TRIGGER erasure_retained_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation()`);
    try {
      await adminPool.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'Retained test',$2,'active','test'),($3,'Survivor test',$4,'active','test')`,
        [tenantId, `retained-${tenantId}`, survivorId, `survivor-${survivorId}`]);
      await adminPool.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'Retained',$3,'active')`,
        [workspaceId, tenantId, `retained-${workspaceId}`]);
      await adminPool.query(`INSERT INTO ${table} (tenant_id,marker) VALUES ($1,'retained'),($2,'other tenant')`, [tenantId, survivorId]);
      const { stdout } = await execFileAsync('node', [DELETE_SCRIPT], {
        env: { ...process.env, TENANT_ID: tenantId, DELETED_BY: 'vitest-retained-test' },
      });
      expect(stdout).toContain(`Partially erased tenant ${tenantId}`);
      expect(stdout).not.toContain(`Deleted tenant ${tenantId}`);
      expect((await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0].n).toBe(1);
      expect((await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [survivorId])).rows[0].n).toBe(1);
      const audit = await adminPool.query(`SELECT table_row_counts FROM platform.data_deletion_events WHERE tenant_id=$1`, [tenantId]);
      expect(audit.rows[0].table_row_counts.retainedRowCounts[table]).toBe(1);
      expect(audit.rows[0].table_row_counts.remainingRows[table]).toBe(1);
      expect((await adminPool.query(`SELECT count(*)::int AS n FROM tenancy.tenants WHERE id=$1`, [survivorId])).rows[0].n).toBe(1);
    } finally {
      await adminPool.query(`DROP TABLE IF EXISTS ${table}`);
      await adminPool.query(`DELETE FROM tenancy.workspaces WHERE tenant_id=$1`, [survivorId]);
      await adminPool.query(`DELETE FROM tenancy.tenants WHERE id=$1`, [survivorId]);
    }
  }, 120_000);

  it('refuses to run against a BYPASSRLS/superuser DATABASE_URL', async () => {
    await expect(
      execFileAsync('node', [DELETE_SCRIPT], {
        env: {
          ...process.env,
          DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
          ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
          TENANT_ID: randomUUID(),
        },
      })
    ).rejects.toThrow();
  });
});

describe.skipIf(run)('delete-tenant-data.mjs — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
