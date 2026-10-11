/**
 * Business Administration declared currency - static guardrails for migration 0185 (no database required).
 * The behavioural proof is business-currency-declarations.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0185_create_business_currency_declarations.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0185 - business currency declarations (static)', () => {
  it('is the next contiguous migration after 0184 (the append-only guard it is stacked on) and the only one using 0185', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0185'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0184_inventory_movements_append_only.sql') + 1);
    expect(files.indexOf('0184_inventory_movements_append_only.sql')).toBe(files.indexOf('0183_add_explicit_currency_to_inventory_costs.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates only the declarations table in the platform schema (Business Administration ownership, not business_operations)', () => {
    expect(code.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS platform\.business_currency_declarations/);
    expect(code).not.toMatch(/business_operations\.|approved_business_action\.|data_acquisition\./);
  });

  it('seeds, backfills and promotes nothing: no row statement other than the registration, no read of any default_currency column', () => {
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|^\s*TRUNCATE\b/m);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1); // _migrations only
    expect(code).not.toMatch(/INSERT INTO (?!_migrations)/);
    expect(code).not.toMatch(/default_currency|INSERT\s+INTO[^;]*SELECT|'USD'|'EUR'|'GBP'/i);
    expect(code).not.toMatch(/ALTER TABLE (?!platform\.business_currency_declarations)/);
  });

  it('has no DEFAULT on the declared value, the actor or the provenance, and requires them', () => {
    for (const col of ['declared_currency', 'declared_by_user_id', 'permission_used', 'provenance', 'correlation_id', 'version']) {
      expect(code, col).toMatch(new RegExp(`\\b${col}\\s+\\S+\\s+NOT NULL,`));
      expect(code, col).not.toMatch(new RegExp(`\\b${col}\\s+\\S+\\s+NOT NULL\\s+DEFAULT`));
    }
  });

  it('enforces the canonical currency format and a linear version chain in the database', () => {
    expect(code).toContain("CHECK (declared_currency ~ '^[A-Z]{3}$')");
    expect(code).toContain('UNIQUE (business_id, version)');
    expect(code).toMatch(/chain_shape CHECK \(COALESCE\(/);
    expect(code).toMatch(/prior_declared_currency <> declared_currency/);
    expect(code).toContain('guard_business_currency_declaration_insert');
  });

  it('is append-only (UPDATE/DELETE per row, TRUNCATE per statement) with the forbid_mutation convention', () => {
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON platform\.business_currency_declarations\s+FOR EACH ROW EXECUTE FUNCTION platform\.forbid_mutation\(\);/);
    expect(code).toMatch(/BEFORE TRUNCATE ON platform\.business_currency_declarations\s+FOR EACH STATEMENT EXECUTE FUNCTION platform\.forbid_mutation\(\);/);
  });

  it('forces RLS on tenant + workspace and grants nothing', () => {
    expect(code).toContain('ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('FORCE ROW LEVEL SECURITY');
    expect(code).toMatch(/tenant_id = current_setting\('app\.tenant_id', true\)::uuid AND workspace_id = current_setting\('app\.workspace_id', true\)::uuid/);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|SECURITY DEFINER/i);
  });

  it('is idempotent: IF NOT EXISTS / DROP IF EXISTS before each object', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS');
    expect(code).toContain('CREATE INDEX IF NOT EXISTS');
    expect(code.match(/DROP TRIGGER IF EXISTS/g)).toHaveLength(3);
    expect(code).toContain('DROP POLICY IF EXISTS');
  });
});
