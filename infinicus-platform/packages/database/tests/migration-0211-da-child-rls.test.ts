/**
 * Migration 0211 (V-18) - static guardrails, no database required. Behavioural proof: da-child-rls.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0211_enable_rls_da_child_tables.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const TABLES = ['publication_deliveries', 'api_collection_runs', 'database_collection_runs', 'duplicate_group_members', 'entity_match_candidates', 'transformation_records'];

describe('migration 0211 - Data Acquisition child-table RLS (static)', () => {
  it('is the only migration numbered 0211 and self-registers in one transaction', () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith('0211'))).toEqual([FILE]);
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('enables, forces and adds exactly one parent-derived policy for each of the six tables', () => {
    for (const t of TABLES) {
      expect(code, t).toContain(`ALTER TABLE data_acquisition.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(code, t).toContain(`ALTER TABLE data_acquisition.${t} FORCE ROW LEVEL SECURITY;`);
      expect(code, t).toMatch(new RegExp(`CREATE POLICY ${t}_isolation ON data_acquisition\\.${t}\\s+USING \\(EXISTS \\(SELECT 1 FROM data_acquisition\\.\\w+ \\w+ WHERE \\w+\\.id = \\w+\\)\\);`));
    }
    expect(code.match(/CREATE POLICY/g)).toHaveLength(TABLES.length);
    expect(code.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(TABLES.length);
  });

  it('is idempotent (policies are dropped before they are created)', () => {
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(TABLES.length);
  });

  it('changes no column, constraint, trigger, index, grant, role or data and never bypasses RLS', () => {
    expect(code).not.toMatch(/ADD COLUMN|DROP COLUMN|ADD CONSTRAINT|DROP CONSTRAINT|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP INDEX|CREATE TABLE|DROP TABLE/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|BYPASSRLS|SECURITY DEFINER|OWNER TO|session_replication_role|DISABLE ROW LEVEL SECURITY|NO FORCE/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it('documents a rollback for every table', () => {
    for (const t of TABLES) expect(sql).toContain(`--   DROP POLICY IF EXISTS ${t}_isolation ON data_acquisition.${t};`);
  });
});
