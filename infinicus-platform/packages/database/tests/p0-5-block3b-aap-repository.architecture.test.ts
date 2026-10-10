/**
 * P0-5 Block 3b - architecture guard for the AuthorizedActionPackage repository (no database required).
 * The repository is a storage adapter: it must stay free of issuance decisions, events and Business Operations.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FILE = resolve(__dirname, '../src/repositories/approved_action/AuthorizedActionPackageRepository.ts');
const source = readFileSync(FILE, 'utf8');
const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n');

describe('AuthorizedActionPackageRepository architecture', () => {
  it('imports only the tenant client, shared repository errors and the pg type', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../client.js', '../../client.js', './errors.js', 'pg']);
  });

  it('does not touch Business Operations, the outbox / event ledger, or any other ABA table', () => {
    expect(code).not.toMatch(/business_operations/i);
    expect(code).not.toMatch(/outbox|business_event_ledger|CanonicalEventPublisher/i);
    const tables = new Set([...code.matchAll(/\$\{SCHEMA\}\.(\w+)|approved_business_action\.(\w+)/g)].map((m) => m[1] ?? m[2]));
    expect([...tables].sort()).toEqual([
      'authorized_action_package_lifecycle_events', 'authorized_action_package_versions', 'authorized_action_packages',
    ]);
  });

  it('decides nothing about issuance: no decision, authority or approval-status reads', () => {
    expect(code).not.toMatch(/approval_decisions|approver_assignments|approval_authority_scopes|approval_audit_events/);
  });

  it('never updates or deletes (the tables are append-only)', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/);
  });

  it('every query runs inside a tenant transaction (RLS-confined)', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(|(?<![.\w])query\(/);
    const methods = [...code.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(8);
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBeGreaterThanOrEqual(methods.length);
  });
});
