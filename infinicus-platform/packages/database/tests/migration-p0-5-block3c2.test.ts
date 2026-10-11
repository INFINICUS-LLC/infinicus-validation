/**
 * P0-5 Block 3c-2 - static guardrails for migration 0178 (no database required).
 * The behavioural proof is p0-5-block3c2-governance.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0178_create_action_governance.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
/** Executable SQL only: header comments legitimately name what the migration leaves alone. */
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const TABLES = [
  'action_type_definitions', 'action_type_status_events', 'automation_level_policies',
  'automation_level_policy_versions', 'automation_level_policy_enablement_events',
];

describe('migration 0178 - action-type registry and automation-level policy (static)', () => {
  it('is the next contiguous migration and the only one using 0178', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0178'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0177_create_authorized_action_capture.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly the five governance tables in the ABA schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)\s*\(/g)].map((m) => m[1]);
    expect(created).toEqual(TABLES.map((t) => `approved_business_action.${t}`));
  });

  it('enables and forces tenant + workspace RLS and append-only on every table', () => {
    for (const t of TABLES) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting(''app.tenant_id'', true)::uuid");
    expect(sql).toContain("current_setting(''app.workspace_id'', true)::uuid");
    expect(sql).toContain('approved_business_action.forbid_mutation()');
    // every table is tenant and workspace scoped: no platform-global table
    for (const t of TABLES) {
      const body = sql.slice(sql.indexOf(`approved_business_action.${t} (`), sql.indexOf(');', sql.indexOf(`approved_business_action.${t} (`)));
      expect(body).toMatch(/tenant_id\s+uuid\s+NOT NULL/);
      expect(body).toMatch(/workspace_id\s+uuid\s+NOT NULL/);
    }
  });

  it('seeds NO data: nothing is inserted except the migration registry entry', () => {
    expect(code).not.toMatch(/INSERT INTO approved_business_action\.(action_type|automation_level)/);
    const inserts = [...code.matchAll(/^\s*INSERT INTO (\S+)/gm)].map((m) => m[1]);
    expect(inserts).toEqual(['_migrations']);
    expect(code).not.toMatch(/^\s*(UPDATE |DELETE FROM )/m);
  });

  it('recognizes only Levels 2-4 and permits enabling Level 2 only', () => {
    expect(sql).toContain('CHECK (automation_level IN (2, 3, 4))');
    expect(sql).toContain('IF v.automation_level <> 2 THEN');
    expect(sql).toMatch(/only Level 2 can be enabled/);
  });

  it('declares the same parameter types, dimensions and applicability rules as the contract', () => {
    for (const type of ['string', 'integer', 'number', 'decimal_string', 'boolean', 'enum', 'identifier']) expect(sql).toContain(`'${type}'`);
    for (const dim of ['SIMULATION', 'RISK', 'CONSTRAINTS', 'VALIDITY', 'RESOURCE_REQUIREMENTS', 'COST', 'REVERSIBILITY', 'EXPECTED_OUTCOME']) expect(sql).toContain(`'${dim}'`);
    for (const key of ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring', 'validityBound']) expect(sql).toContain(`'${key}'`);
    expect(sql).toContain("'REQUIRED', 'NOT_APPLICABLE_ALLOWED'");
  });

  it('validates a definition both in a CHECK and in a trigger (defence in depth)', () => {
    expect(sql).toContain('CONSTRAINT action_type_definitions_well_formed CHECK');
    expect(sql).toContain('guard_action_type_definition_insert');
  });

  it('stays inside Block 3c-2: no package, capture, BO, event or grants; no earlier object altered', () => {
    expect(code).not.toMatch(/business_operations\./);
    expect(code).not.toMatch(/events\.(outbox|business_event_ledger)/);
    expect(code).not.toMatch(/authorized_action_(package|capture|owner)/);
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/ALTER TABLE\s+(?!approved_business_action\.%I)/);
    expect(code).not.toMatch(/DROP TABLE|TRUNCATE/);
  });

  it('is safe to re-run (idempotent DDL)', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE FUNCTION/);
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
