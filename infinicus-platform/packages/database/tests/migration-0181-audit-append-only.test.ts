/**
 * Block A - static guardrails for migration 0181 (no database required).
 * The behavioural proof is audit-events-append-only.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0181_audit_events_append_only.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0181 - audit.audit_events append-only (static)', () => {
  it('is the next contiguous migration and the only one using 0181', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0181'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0180_create_bo_authorized_action_intake.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE per row and TRUNCATE per statement on audit.audit_events', () => {
    expect(code).toMatch(/CREATE TRIGGER forbid_mutation_audit_events\s+BEFORE UPDATE OR DELETE ON audit\.audit_events\s+FOR EACH ROW EXECUTE FUNCTION audit\.forbid_mutation\(\)/);
    expect(code).toMatch(/CREATE TRIGGER forbid_truncate_audit_events\s+BEFORE TRUNCATE ON audit\.audit_events\s+FOR EACH STATEMENT EXECUTE FUNCTION audit\.forbid_mutation\(\)/);
  });

  it('uses the repository forbid_mutation convention (the tenant-erasure script discovers append-only tables by this name) and always raises', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION audit\.forbid_mutation\(\)/);
    expect(code).toMatch(/RAISE EXCEPTION 'audit\.%: append-only table - % is not permitted', TG_TABLE_NAME, TG_OP/);
    expect(code).not.toMatch(/\bIF\s+(?!EXISTS)|\bRETURN\s+(?!TRIGGER)|\bELSE\b|\bCASE\b/);
  });

  it('is idempotent: every trigger is dropped if it exists before it is created', () => {
    expect(code).toContain('DROP TRIGGER IF EXISTS forbid_mutation_audit_events ON audit.audit_events;');
    expect(code).toContain('DROP TRIGGER IF EXISTS forbid_truncate_audit_events ON audit.audit_events;');
    expect(code.indexOf('DROP TRIGGER IF EXISTS forbid_mutation_audit_events')).toBeLessThan(code.indexOf('CREATE TRIGGER forbid_mutation_audit_events'));
    expect(code.indexOf('DROP TRIGGER IF EXISTS forbid_truncate_audit_events')).toBeLessThan(code.indexOf('CREATE TRIGGER forbid_truncate_audit_events'));
  });

  it('changes nothing else: no DDL on other tables, no data movement, no backfill, no RLS or column change, no disabled trigger', () => {
    expect(code).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP TABLE|CREATE POLICY|DROP POLICY|ENABLE ROW|DISABLE|CREATE INDEX|DROP INDEX|ADD COLUMN|DROP COLUMN/i);
    expect(code).not.toMatch(/INSERT INTO (?!_migrations)|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b/m);
    const qualified = new Set([...code.matchAll(/\b([a-z_]+)\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...qualified]).toEqual(['audit']);
    expect(code).not.toMatch(/approval_authority_scopes|approval_audit_events|access_events|entity_versions/);
  });

  it('contains no GRANT or role statements (role provisioning is environment-specific)', () => {
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|SECURITY DEFINER/i);
  });
});
