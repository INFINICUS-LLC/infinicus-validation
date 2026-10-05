import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../infrastructure/database/migrations');

function sql(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf8');
}

describe('BUILD-33 v1.1 migration architecture guardrails', () => {
  const ledger = sql('0171_create_business_event_ledger.sql');
  const scope = sql('0172_harden_eventing_scope.sql');

  describe('0171 canonical event ledger', () => {
    it('persists mandatory Cold-Start evidence classification', () => {
      expect(ledger).toContain('evidence_class    text        NOT NULL');
      for (const value of [
        'ACTUAL',
        'ASSUMPTION_BASED',
        'BENCHMARK_BASED',
        'ESTIMATED',
        'FORECAST',
        'SIMULATION',
      ]) {
        expect(ledger).toContain(`'${value}'`);
      }
    });

    it('requires provenance and binds provenance class to the indexed classification', () => {
      expect(ledger).toContain('provenance        jsonb       NOT NULL');
      expect(ledger).toContain("provenance->>'evidenceClass' = evidence_class");
    });

    it('remains append-only and tenant/workspace scoped', () => {
      expect(ledger).toContain('FORCE ROW LEVEL SECURITY');
      expect(ledger).toContain('forbid_business_event_ledger_mutation');
      expect(ledger).toContain("current_setting('app.tenant_id', true)");
      expect(ledger).toContain("current_setting('app.workspace_id', true)");
    });
  });

  describe('0172 compatibility-preserving event transport scope', () => {
    it('declares all three architecture-approved scope classes', () => {
      expect(scope).toContain('TENANT_WORKSPACE');
      expect(scope).toContain('TENANT_GLOBAL');
      expect(scope).toContain('PLATFORM_GLOBAL');
    });

    it('derives scope rather than trusting writers to self-declare it', () => {
      expect(scope).toContain('GENERATED ALWAYS AS');
      expect(scope).toContain("WHEN tenant_id IS NULL THEN 'PLATFORM_GLOBAL'");
      expect(scope).toContain("WHEN workspace_id IS NULL THEN 'TENANT_GLOBAL'");
      expect(scope).toContain("ELSE 'TENANT_WORKSPACE'");
    });

    it('preserves platform-global rows for privileged relay/system roles', () => {
      expect(scope).toContain('PLATFORM_GLOBAL rows deliberately have no normal-app policy path');
      expect(scope).toContain('BYPASSRLS');
    });

    it('lets tenant-global rows remain tenant-visible without cross-tenant leakage', () => {
      expect(scope).toContain("scope_type = 'TENANT_GLOBAL'");
      expect(scope).toContain("tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid");
    });

    it('requires exact workspace match for tenant-workspace rows', () => {
      expect(scope).toContain("scope_type = 'TENANT_WORKSPACE'");
      expect(scope).toContain("workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid");
    });

    it('uses fail-closed UUID parsing for missing/empty session context', () => {
      expect(scope).toContain("NULLIF(current_setting('app.tenant_id', true), '')::uuid");
      expect(scope).toContain("NULLIF(current_setting('app.workspace_id', true), '')::uuid");
    });

    it('does not delete or rewrite historical event rows', () => {
      expect(scope).not.toMatch(/DELETE\s+FROM\s+events\./i);
      expect(scope).not.toMatch(/TRUNCATE\s+events\./i);
    });
  });
});
