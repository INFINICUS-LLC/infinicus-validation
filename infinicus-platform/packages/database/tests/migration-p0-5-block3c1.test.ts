/**
 * P0-5 Block 3c-1 - static guardrails for migration 0177 (no database required).
 * The behavioural proof is p0-5-block3c1-capture.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0177_create_authorized_action_capture.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
/** Executable SQL only: header comments legitimately name what the migration leaves alone. */
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const TABLES = ['authorized_action_captures', 'authorized_action_owner_assignments'];

describe('migration 0177 - authorized-action capture and owner assignment (static)', () => {
  it('is the next contiguous migration and the only one using 0177', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0177'))).toEqual([FILE]);
    expect(files).toContain('0176_create_authorized_action_packages.sql');
    expect(files.indexOf(FILE)).toBe(files.indexOf('0176_create_authorized_action_packages.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly the two tables in the ABA schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)\s*\(/g)].map((m) => m[1]);
    expect(created).toEqual(TABLES.map((t) => `approved_business_action.${t}`));
  });

  it('enables and forces tenant + workspace RLS and append-only on both tables', () => {
    for (const t of TABLES) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting(''app.tenant_id'', true)::uuid");
    expect(sql).toContain("current_setting(''app.workspace_id'', true)::uuid");
    expect(sql).toContain('approved_business_action.forbid_mutation()');
  });

  it('references canonical Identity/Tenancy truth for the owner and does not copy it', () => {
    expect(sql).toContain('REFERENCES identity.users(id)');
    expect(sql).toContain('REFERENCES tenancy.memberships(id)');
    expect(sql).toContain("m.status = 'active'");
  });

  it('re-derives the final parameter set from the original and the delta', () => {
    expect(sql).toContain('aap_apply_changes(original, NEW.modification #> \'{value,changes}\') IS DISTINCT FROM NEW.final_parameters');
    for (const operation of ['ADD', 'SET', 'REMOVE']) expect(sql).toContain(`op = '${operation}'`);
  });

  it('never stores UNAVAILABLE and stamps facts with the database clock', () => {
    expect(sql).toMatch(/UNAVAILABLE is never storable/);
    expect(sql).not.toMatch(/state IN \([^)]*UNAVAILABLE/);
    expect(sql.match(/clock_timestamp\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('stays inside Block 3c-1: no package, BO, event, vocabulary, policy, data or grants; no earlier object altered', () => {
    expect(code).not.toMatch(/business_operations\./);
    expect(code).not.toMatch(/events\.(outbox|business_event_ledger)/);
    expect(code).not.toMatch(/authorized_action_package/);
    expect(code).not.toMatch(/(FROM|INTO|UPDATE|ALTER TABLE|REFERENCES)\s+\S*approval_decision_modifications/); // the COMMENT may name it; nothing may read or write it
    expect(code).not.toMatch(/^\s*(INSERT INTO (?!_migrations)|UPDATE |DELETE FROM )/m);
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/ALTER TABLE\s+(?!approved_business_action\.%I)/);
    expect(code).not.toMatch(/DROP TABLE|TRUNCATE/);
  });

  it('is safe to re-run (idempotent DDL)', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE FUNCTION/);
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBeGreaterThanOrEqual(7);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
