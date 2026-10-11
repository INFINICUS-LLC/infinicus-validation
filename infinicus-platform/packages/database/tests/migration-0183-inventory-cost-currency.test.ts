/**
 * Data-capture Block C - static guardrails for migration 0183 (no database required).
 * The behavioural proof is inventory-cost-currency.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0183_add_explicit_currency_to_inventory_costs.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0183 - explicit currency on inventory costs (static)', () => {
  it('is the next contiguous migration and the only one using 0183', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0183'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0182_create_bo_inventory_policy_evaluations.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('adds one nullable currency column to inventory_movements with no default', () => {
    expect(code).toMatch(/ALTER TABLE business_operations\.inventory_movements\s+ADD COLUMN IF NOT EXISTS unit_cost_currency text;/);
    expect(code).not.toMatch(/unit_cost_currency\s+text\s+(NOT NULL|DEFAULT)/i);
  });

  it('enforces a three-uppercase-letter format and the cost/currency presence invariant', () => {
    expect(code).toContain("CHECK (unit_cost_currency IS NULL OR unit_cost_currency ~ '^[A-Z]{3}$')");
    expect(code).toContain('CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID');
  });

  it('never validates, backfills or rewrites history and never assumes a currency', () => {
    expect(code).not.toMatch(/VALIDATE CONSTRAINT/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code).not.toMatch(/'USD'|'EUR'|'GBP'/);
    expect(code).not.toMatch(/unit_cost\s*>\s*0/);
  });

  it('removes the silent USD default on purchase orders and keeps the column NOT NULL', () => {
    expect(code).toMatch(/ALTER TABLE business_operations\.purchase_orders\s+ALTER COLUMN currency_code DROP DEFAULT;/);
    expect(code).not.toMatch(/currency_code\s+(DROP NOT NULL|SET DEFAULT)/i);
  });

  it('touches nothing else: no new table, trigger, policy, receipt, linkage or reorder structure, and no GRANT', () => {
    expect(code).not.toMatch(/CREATE TABLE|CREATE TRIGGER|DROP TRIGGER|CREATE POLICY|DROP POLICY|ROW LEVEL SECURITY|CREATE INDEX|purchase_receipt|purchase_order_line_items|reorder|inventory_item_id/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|SECURITY DEFINER/i);
  });

  it('is idempotent: the column is IF NOT EXISTS and each constraint is guarded by a catalogue check', () => {
    expect(code).toContain('ADD COLUMN IF NOT EXISTS');
    expect((code.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/g) ?? []).length).toBe(2);
  });
});
