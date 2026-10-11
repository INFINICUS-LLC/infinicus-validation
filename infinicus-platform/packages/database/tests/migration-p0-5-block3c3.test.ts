/**
 * P0-5 Block 3c-3 - static guardrails for migration 0179 (no database required).
 * The behavioural proof is p0-5-block3c3-boundaries.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0179_create_authorized_action_boundaries.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
/** Executable SQL only: header comments legitimately name what the migration leaves alone. */
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0179 - authorized-action boundaries (static)', () => {
  it('is the next contiguous migration and the only one using 0179', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0179'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0178_create_action_governance.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly one table, tenant + workspace scoped, RLS forced and append-only', () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)\s*\(/g)].map((m) => m[1]);
    expect(created).toEqual(['approved_business_action.authorized_action_boundaries']);
    expect(sql).toMatch(/tenant_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/workspace_id\s+uuid\s+NOT NULL/);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.tenant_id', true)::uuid");
    expect(sql).toContain("current_setting('app.workspace_id', true)::uuid");
    expect(sql).toContain('approved_business_action.forbid_mutation()');
  });

  it('keeps the six governed fields in the contract shapes and never stores UNAVAILABLE', () => {
    const governed = [...sql.matchAll(/^\s+(execution_window|preconditions|budget|rollback|monitoring|simulation_run)\s+jsonb\s+NOT NULL/gm)].map((m) => m[1]);
    expect(governed).toEqual(['execution_window', 'preconditions', 'budget', 'rollback', 'monitoring', 'simulation_run']);
    for (const op of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'contains']) expect(sql).toContain(`'${op}'`);
    expect(code).not.toMatch(/state IN \([^)]*UNAVAILABLE/);
    expect(sql).toContain("'ACTION_SCHEMA', 'POLICY'");
  });

  it('ties boundaries to the capture and an ACTIVE action type, and gates NOT_APPLICABLE on the action type applicability', () => {
    expect(sql).toContain('REFERENCES approved_business_action.authorized_action_captures(id)');
    expect(sql).toContain('no ACTIVE action type definition');
    expect(sql).toContain("(d.applicability ->> field) IS DISTINCT FROM 'NOT_APPLICABLE_ALLOWED'");
    expect(sql).toContain('NOT_APPLICABLE is not permitted');
  });

  it('validates shapes in both a CHECK and the trigger (defence in depth) and stamps the database clock', () => {
    expect(sql).toContain('CONSTRAINT authorized_action_boundaries_well_formed CHECK');
    expect(sql).toContain('guard_authorized_action_boundaries_insert');
    expect(sql).toMatch(/NEW\.authored_at := date_trunc\('milliseconds', clock_timestamp\(\)\)/);
  });

  it('seeds NO data and stays inside Block 3c-3: no package, BO, event, grants; no earlier object altered', () => {
    const inserts = [...code.matchAll(/^\s*INSERT INTO (\S+)/gm)].map((m) => m[1]);
    expect(inserts).toEqual(['_migrations']);
    expect(code).not.toMatch(/^\s*(UPDATE |DELETE FROM )/m);
    expect(code).not.toMatch(/business_operations\./);
    expect(code).not.toMatch(/events\.(outbox|business_event_ledger)/);
    expect(code).not.toMatch(/authorized_action_package|authorized_action_owner|action_execution_windows|approved_action_steps|approved_action_constraints/);
    expect(code).not.toMatch(/simulation\./);
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/ALTER TABLE\s+(?!approved_business_action\.authorized_action_boundaries)/);
    expect(code).not.toMatch(/DROP TABLE|TRUNCATE/);
  });

  it('is safe to re-run (idempotent DDL)', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE FUNCTION/);
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
