/**
 * Migration 0212 (V-18) - static guardrails, no database required. Behavioural proof: tenancy-files-child-rls.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0212_enable_rls_membership_roles_and_file_children.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const POLICIES: Array<[string, string, string, string]> = [
  ['tenancy.membership_roles', 'membership_roles_isolation', 'tenancy.memberships', 'membership_id'],
  ['files.file_versions', 'file_versions_isolation', 'files.file_objects', 'file_object_id'],
  ['files.file_links', 'file_links_isolation', 'files.file_objects', 'file_object_id'],
];
const GRANT_SCRIPT = readFileSync(resolve(DIR, '../scripts/grant-app-role.sh'), 'utf8');

describe('migration 0212 - membership_roles and file children RLS (static)', () => {
  it('is the only migration numbered 0212, directly follows 0211, and self-registers in one transaction', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0212'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0211_enable_rls_da_child_tables.sql') + 1);
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('enables RLS and adds exactly one parent-derived policy per table', () => {
    for (const [table, policy, parent, column] of POLICIES) {
      expect(code, table).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(code, table).toContain(`CREATE POLICY ${policy} ON ${table}`);
      expect(code, table).toMatch(new RegExp(`USING \\(EXISTS \\(SELECT 1 FROM ${parent.replace('.', '\\.')} \\w+ WHERE \\w+\\.id = ${column}\\)\\);`));
    }
    expect(code.match(/CREATE POLICY/g)).toHaveLength(POLICIES.length);
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(POLICIES.length);
  });

  it('does NOT force RLS (owner, SECURITY DEFINER authority function and admin tooling keep their access) and changes nothing else', () => {
    expect(code).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/ADD COLUMN|DROP COLUMN|ADD CONSTRAINT|DROP CONSTRAINT|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP INDEX|CREATE TABLE|DROP TABLE/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|BYPASSRLS|SECURITY DEFINER|OWNER TO|session_replication_role|DISABLE ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it('documents a rollback for every table', () => {
    for (const [table, policy] of POLICIES) {
      expect(sql).toContain(`--   DROP POLICY IF EXISTS ${policy} ON ${table};`);
      expect(sql).toContain(`--   ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }
  });
});

describe('grant-app-role.sh - erasure audit trail is service-only', () => {
  it('withholds every privilege on platform.data_deletion_events from the application role, guarded by to_regclass', () => {
    expect(GRANT_SCRIPT).toContain("to_regclass('platform.data_deletion_events') IS NOT NULL");
    expect(GRANT_SCRIPT).toContain("REVOKE ALL PRIVILEGES ON platform.data_deletion_events FROM %I");
  });
  it('runs the revoke after the blanket grants, inside the hardening block', () => {
    expect(GRANT_SCRIPT.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES')).toBeGreaterThan(-1);
    expect(GRANT_SCRIPT.indexOf('REVOKE ALL PRIVILEGES ON platform.data_deletion_events')).toBeGreaterThan(GRANT_SCRIPT.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'));
  });
});
