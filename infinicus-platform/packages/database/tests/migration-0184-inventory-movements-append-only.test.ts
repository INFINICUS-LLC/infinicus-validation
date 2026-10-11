/**
 * Data-capture follow-up - static guardrails for migration 0184 (no database required).
 * The behavioural proof is inventory-movements-append-only.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0184_inventory_movements_append_only.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0184 - inventory_movements append-only (static)', () => {
  it('is the next contiguous migration and the only one using 0184', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0184'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0183_add_explicit_currency_to_inventory_costs.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE per row and TRUNCATE per statement, unconditionally, with the forbid_mutation convention', () => {
    expect(code).toMatch(/CREATE TRIGGER forbid_mutation_inventory_movements\s+BEFORE UPDATE OR DELETE ON business_operations\.inventory_movements\s+FOR EACH ROW EXECUTE FUNCTION business_operations\.forbid_mutation\(\);/);
    expect(code).toMatch(/CREATE TRIGGER forbid_truncate_inventory_movements\s+BEFORE TRUNCATE ON business_operations\.inventory_movements\s+FOR EACH STATEMENT EXECUTE FUNCTION business_operations\.forbid_mutation\(\);/);
    expect(code).toMatch(/RAISE EXCEPTION[^;]+TG_OP[^;]+integrity_constraint_violation/s);
  });

  it('the guard function has no condition, role test or bypass', () => {
    const fn = (code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/) ?? [''])[0];
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).not.toMatch(/\bIF\b|\bCASE\b|current_user|session_user|current_setting|pg_has_role|TG_ARGV|RETURN\s+(NEW|OLD)|SECURITY DEFINER/i);
    expect(fn).toMatch(/RAISE EXCEPTION/);
  });

  it('changes no data and no structure: no row statement, no column, constraint, policy, RLS, index, grant or role change', () => {
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN|\bCONSTRAINT\b|CREATE POLICY|DROP POLICY|ROW LEVEL SECURITY|CREATE INDEX|VALIDATE/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|DISABLE TRIGGER|session_replication_role/i);
    expect(code).not.toMatch(/'USD'|'EUR'|unit_cost/i);
  });

  it('is idempotent: each trigger is dropped if present before it is created', () => {
    expect(code).toContain('DROP TRIGGER IF EXISTS forbid_mutation_inventory_movements ON business_operations.inventory_movements;');
    expect(code).toContain('DROP TRIGGER IF EXISTS forbid_truncate_inventory_movements ON business_operations.inventory_movements;');
  });

  it('re-declares the shared function identically to 0182 (same name, same message), so the two migrations cannot drift', () => {
    const body = (s: string) => (s.match(/CREATE OR REPLACE FUNCTION business_operations\.forbid_mutation\(\)[\s\S]*?\$\$;/) ?? [''])[0].replace(/\s+/g, ' ');
    const prior = readFileSync(resolve(DIR, '0182_create_bo_inventory_policy_evaluations.sql'), 'utf8');
    expect(body(sql)).not.toBe('');
    expect(body(sql)).toBe(body(prior));
  });
});
