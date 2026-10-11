/**
 * Data-capture Block B - static guardrails for migration 0187 (no database required).
 * The behavioural proof is inventory-unit-cost-positive.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0187_require_positive_inventory_unit_cost.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0187 - positive unit cost when present (static)', () => {
  it('is the next contiguous migration after 0186 and the only one using 0187', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0187'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0186_force_rls_inventory_movements.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('adds exactly the positive-cost check: NULL or strictly greater than zero and not NaN, NOT VALID (history is not validated)', () => {
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    expect(code).toContain('ADD CONSTRAINT inventory_movements_unit_cost_positive');
    expect(code).toContain("CHECK (unit_cost IS NULL OR (unit_cost > 0 AND unit_cost <> 'NaN'::numeric)) NOT VALID;");
    expect(code).not.toMatch(/unit_cost\s*>=\s*0/);
  });

  it('never validates, backfills, repairs or deletes history, and touches no other structure', () => {
    expect(code).not.toMatch(/VALIDATE CONSTRAINT/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
    expect(code).not.toMatch(/'USD'|'EUR'|unit_cost_currency/);
    expect(code).not.toMatch(/CREATE TABLE|CREATE TRIGGER|DROP TRIGGER|CREATE POLICY|ALTER POLICY|ROW LEVEL SECURITY|ADD COLUMN|DROP COLUMN|CREATE INDEX|DROP CONSTRAINT/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|SECURITY DEFINER|session_replication_role|DISABLE TRIGGER/i);
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it('is idempotent: the constraint is created only if the catalogue does not already hold it', () => {
    expect(code).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    expect(code).toContain("conname = 'inventory_movements_unit_cost_positive'");
  });
});
