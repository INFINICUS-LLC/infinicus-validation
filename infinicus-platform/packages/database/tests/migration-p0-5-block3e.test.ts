/**
 * P0-5 Block 3e - static guardrails for migration 0180 (no database required).
 * The behavioural proof is business-operations-runtime/tests/AuthorizedActionIntake.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../../../infrastructure/database/migrations');
const FILE = '0180_create_bo_authorized_action_intake.sql';
const sql = readFileSync(resolve(DIR, FILE), 'utf8');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('migration 0180 - BO authorized-action intake (static)', () => {
  it('is the next contiguous migration and the only one using 0180', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0180'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0179_create_authorized_action_boundaries.sql') + 1);
  });

  it('self-registers with the repository convention and runs in one transaction', () => {
    expect(sql).toContain(`INSERT INTO _migrations (filename) VALUES ('${FILE}')`);
    expect(sql).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('creates exactly three BO-owned tables, all in business_operations, and nothing in any ABA schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)\s*\(/g)].map((m) => m[1]);
    expect(created).toEqual([
      'business_operations.authorized_action_receipts', 'business_operations.authorized_action_claims', 'business_operations.authorized_action_intake_attempts',
    ]);
    expect(code).not.toMatch(/approved_business_action/);
  });

  it('has no foreign key into ABA, touches no inventory, event or ABA table, and seeds nothing', () => {
    expect(code).not.toMatch(/REFERENCES\s+approved_business_action/);
    expect(code).not.toMatch(/inventory_balances|inventory_movements|business_events|outbox_events|business_event_ledger/);
    expect(code).not.toMatch(/INSERT INTO (?!_migrations)/);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b/);
  });

  it('enforces single use, one receipt per package version, and a receipt-bound claim', () => {
    expect(sql).toContain('CONSTRAINT authorized_action_claims_single_use UNIQUE (package_id, package_version)');
    expect(sql).toContain('CONSTRAINT authorized_action_receipts_package_key UNIQUE (package_id, package_version)');
    expect(sql).toContain('REFERENCES business_operations.authorized_action_receipts (id, package_id, package_version, tenant_id, workspace_id, business_id)');
    expect(sql).toContain("(package #>> '{consumption,mode}')         IS NOT DISTINCT FROM 'SINGLE_USE'");
  });

  it('keeps the receipt document and its columns in agreement, digest well-formed, and facts stamped by the database clock', () => {
    expect(sql).toContain('authorized_action_receipts_document_identity');
    expect(sql).toContain("digest ~ '^sha256:[0-9a-f]{64}$'");
    expect(sql.match(/date_trunc\('milliseconds', clock_timestamp\(\)\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain('the package has expired');
    expect(sql).toContain('the execution window has not opened');
  });

  it('is append-only (UPDATE, DELETE and TRUNCATE) and RLS-forced on tenant + workspace for every table', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON business_operations.%1$I');
    expect(sql).toContain('BEFORE TRUNCATE ON business_operations.%1$I');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting(''app.tenant_id'', true)::uuid");
    expect(sql).toContain("current_setting(''app.workspace_id'', true)::uuid");
  });

  it('contains no GRANT or role statements (role provisioning is environment-specific)', () => {
    expect(code).not.toMatch(/\bGRANT\b|\bCREATE ROLE\b/i);
  });
});
