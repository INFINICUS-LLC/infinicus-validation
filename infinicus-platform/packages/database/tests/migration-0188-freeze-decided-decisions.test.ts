/**
 * P0-6.0 - static guardrails for migration 0188 (no database required).
 * The behavioural proof is in aba-repositories.integration.test.ts ("P0-6.0: a decided decision is frozen").
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0188_freeze_decided_approval_decisions.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0188 - decided approval decisions are frozen (static)', () => {
  it('is the next contiguous migration after 0187 and the only one using 0188', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0188'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0187_require_positive_inventory_unit_cost.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('replaces exactly the two immutability guard functions, rejecting EVERY update once the old row is decided', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(code).toContain('approved_business_action.enforce_decision_immutability()');
    expect(code).toContain('approved_business_action.enforce_decision_version_immutability()');
    expect(code.match(/IF OLD\.status IN \('approved','approved_with_modifications','rejected'\) THEN/g)).toHaveLength(2);
    expect(code).not.toMatch(/NEW\.status IS DISTINCT FROM OLD\.status/); // the weaker condition is gone
    expect(code.match(/RAISE EXCEPTION/g)).toHaveLength(2);
    expect(code).toContain('decided decisions are immutable');
  });

  it('is a future-mutation guard only: no data, structure, trigger, policy or privilege is touched', () => {
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE TRIGGER|DROP TRIGGER|DROP FUNCTION|CREATE POLICY|ALTER POLICY|ROW LEVEL SECURITY|ADD COLUMN|DROP COLUMN|CREATE INDEX|GRANT |REVOKE |SECURITY DEFINER|session_replication_role/i);
  });
});
