/**
 * OFF-1 step 2 - static guardrails for migration 0210 (no database required).
 * The behavioural proof is offline-sales-schema.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0210_create_offline_sales.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const header = sql.split('\n').filter((line) => line.trim().startsWith('--')).join('\n');
const table = (() => {
  const m = code.match(/CREATE TABLE IF NOT EXISTS business_operations\.offline_sales \(([\s\S]*?)\n\);/);
  return m ? m[1] : '';
})();

describe('migration 0210 - offline_sales (static)', () => {
  it('is the only migration numbered 0210, directly follows 0209 (no gap: migration-stage2a), and records why it took 0210', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0210'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0209_create_print_jobs.sql') + 1);
    expect(header).toMatch(/requires migration numbers with NO gaps/);
    expect(header).toMatch(/Kitchen routing takes the\s+-- next free number|Kitchen routing takes the next free number/);
  });

  it('self-registers with the repository convention and runs in exactly one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('is additive: it creates and adds, and never drops, deletes, truncates, rewrites or backfills', () => {
    expect(code).not.toMatch(/\bDROP\b|^\s*DELETE\s+FROM\b|^\s*TRUNCATE\b|^\s*UPDATE\s+\S+\s+SET\b|ALTER COLUMN|RENAME|VALIDATE|DISABLE TRIGGER|session_replication_role/im);
    expect(code).not.toMatch(/INSERT INTO (?!_migrations)/);
    const alters = code.match(/ALTER TABLE [^\n]+/g) ?? [];
    expect(alters.filter((a) => !/ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/.test(a))).toEqual([
      'ALTER TABLE platform.orders',
    ]);
    expect(code).toMatch(/ALTER TABLE platform\.orders\s+ADD COLUMN IF NOT EXISTS client_sale_id uuid;/);
  });

  it('contains no GRANT, REVOKE or role statement (the application role is granted by grant-app-role.sh)', () => {
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE ROLE|ALTER ROLE|ALTER DEFAULT PRIVILEGES|SECURITY DEFINER/i);
  });

  it('is idempotent: every object is guarded', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS orders_business_client_sale_unique/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS business_operations\.offline_sales/);
    for (const idx of ['idx_offline_sales_tenant', 'idx_offline_sales_workspace', 'idx_offline_sales_business', 'idx_offline_sales_review', 'idx_offline_sales_order']) {
      expect(code).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}\\b`));
    }
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION business_operations\.check_offline_sale_consistency\(\)/);
    const guards = code.match(/IF NOT EXISTS \(SELECT 1 FROM pg_(policies|trigger)/g) ?? [];
    expect(guards).toHaveLength(4); // one policy and three triggers
  });

  it('the one order change is a nullable column plus a PARTIAL unique index per business', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS orders_business_client_sale_unique\s+ON platform\.orders \(business_id, client_sale_id\)\s+WHERE client_sale_id IS NOT NULL;/);
    expect(code).not.toMatch(/ADD COLUMN IF NOT EXISTS client_sale_id uuid\s+NOT NULL/i);
  });

  it('enables AND forces row-level security with the standard fail-closed tenant + workspace policy', () => {
    expect(code).toContain('ALTER TABLE business_operations.offline_sales ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('ALTER TABLE business_operations.offline_sales FORCE ROW LEVEL SECURITY;');
    expect(code).toMatch(/CREATE POLICY offline_sales_isolation ON business_operations\.offline_sales\s+USING \(\s+tenant_id\s+= current_setting\('app\.tenant_id',\s+true\)::uuid\s+AND workspace_id = current_setting\('app\.workspace_id', true\)::uuid\s+\);/);
  });

  it('is append-only through the EXISTING forbid_mutation() and does not redefine it', () => {
    expect(code).toMatch(/CREATE TRIGGER forbid_mutation_offline_sales\s+BEFORE UPDATE OR DELETE ON business_operations\.offline_sales\s+FOR EACH ROW EXECUTE FUNCTION business_operations\.forbid_mutation\(\);/);
    expect(code).toMatch(/CREATE TRIGGER forbid_truncate_offline_sales\s+BEFORE TRUNCATE ON business_operations\.offline_sales\s+FOR EACH STATEMENT EXECUTE FUNCTION business_operations\.forbid_mutation\(\);/);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION business_operations\.forbid_mutation\(/);
  });

  it('every tenant-owned foreign key to orders or register sessions is composite on business_id, so a row cannot cross businesses', () => {
    expect(table).toMatch(/FOREIGN KEY \(register_session_id, business_id\) REFERENCES business_operations\.register_sessions \(id, business_id\)/);
    expect(table).toMatch(/FOREIGN KEY \(order_id, business_id\) REFERENCES platform\.orders \(id, business_id\)/);
    expect(table).toMatch(/business_id\s+uuid\s+NOT NULL REFERENCES platform\.businesses\(id\)\s+ON DELETE RESTRICT/);
    expect(table).not.toMatch(/ON DELETE CASCADE|ON DELETE SET NULL/);
  });

  it('keeps the invariants as named constraints', () => {
    for (const name of [
      'offline_sales_business_client_sale_unique', 'offline_sales_session_same_business_fk', 'offline_sales_order_same_business_fk',
      'offline_sales_review_reason_iff_review', 'offline_sales_order_iff_accepted', 'offline_sales_accepted_has_verified_session',
      'offline_sales_difference_is_server_minus_device', 'offline_sales_accepted_has_server_total', 'offline_sales_exact_accept_has_no_difference',
    ]) expect(table).toContain(`CONSTRAINT ${name}`);
    expect(table).toMatch(/outcome\s+text\s+NOT NULL CHECK \(outcome IN \('accepted','accepted_with_difference','needs_review'\)\)/);
  });

  it('money is integer minor units: no numeric, decimal, real or floating-point column in the table', () => {
    expect(table).not.toMatch(/\b(numeric|decimal|real|double precision|float|money)\b/i);
    for (const col of ['device_total_minor', 'server_total_minor', 'difference_minor']) expect(table).toMatch(new RegExp(`${col}\\s+bigint`));
  });

  it('stores no card, customer or free-text content: the table has no such column', () => {
    const columns = (table.match(/^\s{2}([a-z_]+)\s+(?:uuid|text|timestamptz|integer|bigint|jsonb)\b/gm) ?? []).map((l) => l.trim().split(/\s+/)[0]);
    expect(columns.length).toBeGreaterThanOrEqual(20);
    for (const c of columns) expect(c).not.toMatch(/card|pan\b|token|customer|phone|email|name$|note|address|secret|password/);
    expect(table).toMatch(/device_id\s+text\s+NOT NULL CHECK \(char_length\(device_id\) >= 1 AND char_length\(device_id\) <= 64 AND device_id ~ '\^\[A-Za-z0-9\._:-\]\+\$'\)/);
  });

  it('writes no CHECK that uses BETWEEN inside an AND (a dump and restore re-parses that shape and the restore proof would see a new difference)', () => {
    expect(code).not.toMatch(/\bBETWEEN\b/i);
  });

  it('the consistency guard is a plain trigger function: not SECURITY DEFINER, no role or setting test, fixed error class', () => {
    const fn = (code.match(/CREATE OR REPLACE FUNCTION business_operations\.check_offline_sale_consistency\(\)[\s\S]*?\$\$;/) ?? [''])[0];
    expect(fn.length).toBeGreaterThan(300);
    expect(fn).not.toMatch(/SECURITY DEFINER|current_user|session_user|current_setting|pg_has_role|set_config/i);
    expect((fn.match(/RAISE EXCEPTION/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((fn.match(/integrity_constraint_violation/g) ?? []).length).toBe((fn.match(/RAISE EXCEPTION/g) ?? []).length);
    expect(code).toMatch(/CREATE TRIGGER check_offline_sale_consistency_trg\s+BEFORE INSERT ON business_operations\.offline_sales\s+FOR EACH ROW EXECUTE FUNCTION business_operations\.check_offline_sale_consistency\(\);/);
  });

  it('documents a rollback that drops exactly the objects it created, in dependency order', () => {
    const rollback = header.split('\n').filter((l) => /^--\s{3}(DROP|ALTER|DELETE)/.test(l)).map((l) => l.replace(/^--\s+/, '').replace(/\s+--.*$/, ''));
    expect(rollback).toEqual([
      'DROP TABLE business_operations.offline_sales;',
      'DROP FUNCTION business_operations.check_offline_sale_consistency();',
      'DROP INDEX platform.orders_business_client_sale_unique;',
      'ALTER TABLE platform.orders DROP COLUMN client_sale_id;',
      "DELETE FROM _migrations WHERE filename = '0210_create_offline_sales.sql';",
    ]);
  });
});
