import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AUDIT-LP-1 (static): the application role keeps INSERT and SELECT on audit.access_events and loses UPDATE, DELETE and TRUNCATE, and the tenant-erasure
 * script removes a tenant's access events over the ADMIN connection with an explicit tenant predicate. Live behaviour is proven in
 * audit-lp-1-access-events-privileges.integration.test.ts and delete-tenant-data.integration.test.ts.
 */
const SCRIPTS = resolve(__dirname, '../../../infrastructure/database/scripts');
const GRANT = readFileSync(resolve(SCRIPTS, 'grant-app-role.sh'), 'utf8');
const ERASE = readFileSync(resolve(SCRIPTS, 'delete-tenant-data.mjs'), 'utf8');
const code = (s: string): string => s.split('\n').filter((l) => !/^\s*(--|\/\/|#)/.test(l)).join('\n');

describe('grant-app-role.sh withholds UPDATE, DELETE and TRUNCATE on audit.access_events', () => {
  it('revokes exactly UPDATE, DELETE, TRUNCATE, guarded by to_regclass, and never INSERT or SELECT', () => {
    expect(code(GRANT)).toContain("IF to_regclass('audit.access_events') IS NOT NULL THEN");
    const m = code(GRANT).match(/REVOKE ([A-Z, ]+) ON audit\.access_events FROM %I/);
    expect(m?.[1]).toBe('UPDATE, DELETE, TRUNCATE');
    expect(code(GRANT)).not.toMatch(/REVOKE[^;]*\b(INSERT|SELECT)\b[^;]*audit\.access_events/);
  });

  it('runs after the blanket grants and inside the hardening block, so a rerun cannot reopen the privilege', () => {
    const grants = GRANT.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES');
    const revoke = GRANT.indexOf('REVOKE UPDATE, DELETE, TRUNCATE ON audit.access_events');
    const hardening = GRANT.indexOf('DO $hardening$');
    expect(grants).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(grants);
    expect(revoke).toBeGreaterThan(hardening);
    expect(GRANT.indexOf('$hardening$;', revoke)).toBeGreaterThan(revoke);
  });
});

describe('delete-tenant-data.mjs erases access events over the admin connection only, always for one tenant', () => {
  it('lists audit.access_events as an admin-erased table', () => {
    expect(code(ERASE)).toMatch(/ADMIN_ERASED_TABLES = new Set\(\['audit\.access_events'\]\)/);
  });

  it('keeps those tables out of the application-role deletion pass', () => {
    expect(code(ERASE)).toContain('const appRoleOrder = deletableOrder.filter((table) => !ADMIN_ERASED_TABLES.has(table));');
    expect(code(ERASE)).toMatch(/for \(const table of appRoleOrder\) \{\s*try \{/);
  });

  it('deletes over ADMIN_DATABASE_URL with an explicit tenant predicate, never a blanket delete and never IS NULL', () => {
    const adminPass = code(ERASE).slice(code(ERASE).indexOf('for (const table of adminErasedOrder)'));
    const block = adminPass.slice(0, adminPass.indexOf("console.log('Tenant-scoped table deletion complete:'"));
    expect(block).toContain("psqlTransaction(ADMIN_DATABASE_URL, [`DELETE FROM ${table} WHERE tenant_id = '${TENANT_ID}';`])");
    expect(block).toContain('if (!tablesWithTenantIdColumn.has(table))');
    expect(block).not.toMatch(/IS NULL/i);
    expect(block).not.toMatch(/psqlTransaction\(DATABASE_URL/);
    expect(block.match(/DELETE FROM/g)).toHaveLength(1);
  });

  it('a failure on an admin-erased table is reported as blocked (so the run reports partial erasure), not swallowed', () => {
    const block = code(ERASE).slice(code(ERASE).indexOf('for (const table of adminErasedOrder)'), code(ERASE).indexOf("console.log('Tenant-scoped table deletion complete:'"));
    expect(block.match(/blockedTables\[table\] = databaseFailureReason\(\)/g)).toHaveLength(2);
  });
});
