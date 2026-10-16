/**
 * Migration 0200 (F-NA05-3) - static guardrails (no database required). The behavioural proof is
 * apps/api/tests/f-na05-3-om-scope-integrity.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0200_enforce_om_monitored_action_scope_integrity.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0200 - OM monitored-action scope integrity (static)', () => {
  it('is the only 0200 and follows 0199 contiguously', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0200'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0199_create_list_active_memberships.sql') + 1);
  });

  it('self-registers and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('pre-flights existing rows and refuses (counts only) before any DDL', () => {
    expect(code.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1);
    expect(code.indexOf('RAISE EXCEPTION')).toBeLessThan(code.indexOf('ADD CONSTRAINT'));
  });

  it('adds exactly one unique key and two composite foreign keys, each FK NOT VALID then VALIDATEd, ON DELETE RESTRICT', () => {
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(3);
    expect(code.match(/\bUNIQUE \(id, tenant_id, workspace_id, business_id\)/g)).toHaveLength(1);
    expect(code.match(/FOREIGN KEY \(monitored_action_id, tenant_id, workspace_id, business_id\)/g)).toHaveLength(2);
    expect(code.match(/ON DELETE RESTRICT NOT VALID;/g)).toHaveLength(2);
    expect(code.match(/VALIDATE CONSTRAINT/g)).toHaveLength(2);
  });

  it('does not disable RLS or triggers, change policies, grants, roles or data, and keeps the existing foreign keys', () => {
    expect(code).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE|CREATE POLICY|DROP POLICY|ALTER POLICY|DISABLE TRIGGER|DROP TRIGGER|CREATE TRIGGER|session_replication_role/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|BYPASSRLS|SECURITY DEFINER|OWNER TO/i);
    expect(code).not.toMatch(/DROP CONSTRAINT|DROP COLUMN|ADD COLUMN|DROP TABLE|CREATE TABLE|TRUNCATE|\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b/i);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
  });
});
