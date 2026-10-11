/**
 * Block B2a - static guardrails for migration 0182 (no database required).
 * The behavioural proof is bo-inventory-policy-evaluations.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0182_create_bo_inventory_policy_evaluations.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0182 - BO inventory policy evaluations (static)', () => {
  it('is the next contiguous migration and the only one using 0182', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0182'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0181_audit_events_append_only.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly one BO-owned table and nothing in any ABA schema', () => {
    expect([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)\s*\(/g)].map((m) => m[1])).toEqual(['business_operations.inventory_policy_evaluations']);
    expect(code).not.toMatch(/approved_business_action/);
    expect(code).not.toMatch(/REFERENCES\s+(approved_business_action|ai_decision|simulation\.)/);
  });

  it('allows exactly the four evaluated dimensions (not SIMULATION, RISK, VALIDITY or REVERSIBILITY) and three distinct results', () => {
    expect(code).toContain("dimension IN ('CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME')");
    expect(code).toContain("result IN ('PASSED', 'FAILED', 'INDETERMINATE')");
    expect(code).not.toMatch(/'REVERSIBILITY'|'SIMULATION'|'RISK'|'VALIDITY'/);
  });

  it('binds the evidence to the exact subject: digest shape, stored subject, and shape checks only', () => {
    expect(code).toContain("subject_digest ~ '^sha256:[0-9a-f]{64}$'");
    expect(code).toContain('inventory_policy_evaluations_subject_shape');
    expect(code).toContain("jsonb_typeof(subject -> 'finalParameters') = 'object'");
    expect(code).toContain("length(btrim(rule_set_version)) > 0");
  });

  it('is rule-free: no threshold, default, capacity, conversion or rule logic in the database', () => {
    expect(code).not.toMatch(/reorder_point|reorder_quantity|quantity_on_hand|capacity|threshold|days_of_cover|max_order_value|unit_cost/i);
    expect(code).not.toMatch(/INSERT INTO (?!_migrations)|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b/m);
  });

  it('stamps evaluated_at from the database clock in milliseconds and checks the target scope', () => {
    expect(code).toContain("NEW.evaluated_at := date_trunc('milliseconds', clock_timestamp())");
    expect(code).toContain('inventory_policy_evaluations_evaluated_ms');
    expect(code).toMatch(/FROM platform\.inventory_items WHERE id = NEW\.inventory_item_id/);
    expect(code).toMatch(/FROM platform\.warehouses WHERE id = NEW\.warehouse_id/);
  });

  it('is append-only for UPDATE, DELETE and TRUNCATE and RLS-forced on tenant + workspace', () => {
    expect(code).toContain('BEFORE UPDATE OR DELETE ON business_operations.inventory_policy_evaluations');
    expect(code).toContain('BEFORE TRUNCATE ON business_operations.inventory_policy_evaluations');
    expect(code).toContain('CREATE OR REPLACE FUNCTION business_operations.forbid_mutation()');
    expect(code).toContain('ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('FORCE ROW LEVEL SECURITY');
    expect(code).toContain("tenant_id = current_setting('app.tenant_id', true)::uuid AND workspace_id = current_setting('app.workspace_id', true)::uuid");
  });

  it('is idempotent: triggers and the policy are dropped if they exist before they are created', () => {
    for (const t of ['guard_inventory_policy_evaluation_insert', 'forbid_mutation_inventory_policy_evaluations', 'forbid_truncate_inventory_policy_evaluations']) {
      expect(code.indexOf(`DROP TRIGGER IF EXISTS ${t}`)).toBeGreaterThan(-1);
      expect(code.indexOf(`DROP TRIGGER IF EXISTS ${t}`)).toBeLessThan(code.indexOf(`CREATE TRIGGER ${t}`));
    }
    expect(code.indexOf('DROP POLICY IF EXISTS inventory_policy_evaluations_isolation')).toBeLessThan(code.indexOf('CREATE POLICY inventory_policy_evaluations_isolation'));
    expect(code).toContain('CREATE TABLE IF NOT EXISTS');
  });

  it('contains no GRANT or role statements and no seeded data', () => {
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|SECURITY DEFINER/i);
  });
});
