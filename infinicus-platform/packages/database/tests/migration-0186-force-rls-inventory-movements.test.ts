/**
 * inventory_movements FORCE RLS - static guardrails for migration 0186 (no database required).
 * The behavioural proof is inventory-movements-force-rls.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0186_force_rls_inventory_movements.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0186 - inventory_movements FORCE RLS (static)', () => {
  it('is the next contiguous migration after 0185 and the only one using 0186', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0186'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0185_create_business_currency_declarations.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('contains exactly one schema statement: FORCE ROW LEVEL SECURITY on inventory_movements', () => {
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(code).toMatch(/ALTER TABLE business_operations\.inventory_movements FORCE ROW LEVEL SECURITY;/);
    expect(code).not.toMatch(/NO FORCE|DISABLE ROW LEVEL SECURITY|ENABLE ROW LEVEL SECURITY/i);
  });

  it('changes no policy, trigger, constraint, column, index, grant, role or data', () => {
    expect(code).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY|CREATE TRIGGER|DROP TRIGGER|ADD CONSTRAINT|DROP CONSTRAINT|ADD COLUMN|DROP COLUMN|CREATE INDEX|DROP INDEX|CREATE TABLE/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|BYPASSRLS|SECURITY DEFINER|OWNER TO|session_replication_role/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b|INSERT INTO (?!_migrations)/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
  });
});
