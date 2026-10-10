/**
 * P0-5 Block 3a - static guardrails for migration 0176 (no database required).
 * The behavioural proof is p0-5-block3-aap-persistence.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0176_create_authorized_action_packages.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const TABLES = [
  'authorized_action_packages',
  'authorized_action_package_versions',
  'authorized_action_package_lifecycle_events',
];

describe('migration 0176 - AuthorizedActionPackage persistence (static)', () => {
  it('is the next contiguous migration and the only one using 0176', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0176'))).toEqual([FILE]);
    expect(files[files.length - 1] >= FILE).toBe(true);
    expect(files).toContain('0175_add_aba_review_version_snapshot.sql');
  });

  it('self-registers with the repository convention', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
  });

  it('runs in one transaction', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly the three package tables in the ABA schema', () => {
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
  });

  it('carries no mutable status column and no EXECUTED / EXECUTABLE state', () => {
    const header = sql.slice(sql.indexOf('authorized_action_packages ('), sql.indexOf('authorized_action_package_versions ('));
    expect(header).not.toMatch(/\bstatus\b\s+text/);
    expect(sql).toContain("state IN ('ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'CONSUMED')");
    expect(sql).not.toMatch(/'EXECUTED'|'EXECUTABLE'/);
  });

  it('keeps document checks null-safe so a missing field can never pass', () => {
    const identity = sql.slice(sql.indexOf('document_identity CHECK'), sql.indexOf('document_supersedes CHECK'));
    expect(identity).toContain('IS NOT DISTINCT FROM');
    expect(identity).not.toMatch(/#>> '\{[^}]+\}'\)?\s+= /);
  });

  it('stays inside Block 3a: no BO table, no event emission, no data, no grants, no earlier migration touched', () => {
    expect(sql).not.toMatch(/business_operations\./);
    expect(sql).not.toMatch(/events\.(outbox|business_event_ledger)/);
    // The only rows the migration may write: its own lifecycle facts (inside a trigger function) and its registry entry.
    expect(sql).not.toMatch(/^\s*(INSERT INTO (?!_migrations|approved_business_action\.authorized_action_package_lifecycle_events)|UPDATE |DELETE FROM )/m);
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/ALTER TABLE\s+approved_business_action\.(?!authorized_action_package|%I)/);
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE/);
  });

  it('is safe to re-run (idempotent DDL)', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql.match(/CREATE TRIGGER/g)?.length).toBeGreaterThan(0);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
