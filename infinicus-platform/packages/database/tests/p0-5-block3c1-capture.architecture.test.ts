/**
 * P0-5 Block 3c-1 - architecture guard for the capture repository (no database required).
 * It is a storage adapter: no authority / risk / package logic, no events, no Business Operations, no route wiring.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../src');
const FILE = join(SRC, 'repositories/approved_action/AuthorizedActionCaptureRepository.ts');
const source = readFileSync(FILE, 'utf8');
const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

function listTs(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? listTs(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('AuthorizedActionCaptureRepository architecture', () => {
  it('imports only the tenant client, shared repository errors and the pg type', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../client.js', '../../client.js', './errors.js', 'pg']);
  });

  it('touches only the two capture tables', () => {
    const tables = new Set([...code.matchAll(/approved_business_action\.(\w+)/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(['authorized_action_captures', 'authorized_action_owner_assignments']);
  });

  it('decides nothing about authority, risk or packages, and emits no events or BO writes', () => {
    expect(code).not.toMatch(/approval_decisions|approver_assignments|approval_authority_scopes|approval_audit_events|approval_decision_versions/);
    expect(code).not.toMatch(/authorized_action_package|business_operations|outbox|business_event_ledger|CanonicalEventPublisher/i);
  });

  it('never updates or deletes (the tables are append-only)', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/);
  });

  it('every query runs inside a tenant transaction (RLS-confined)', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(|(?<![.\w])query\(/);
    const methods = [...code.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(['recordCapture', 'getCaptureByActionId', 'assignOwner', 'getCurrentOwner', 'getOwnerVersion', 'listOwnerVersions', 'requireCapture']);
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBeGreaterThanOrEqual(methods.length - 1);
  });

  it('is not wired into any route, service or other repository yet (storage only)', () => {
    const importers = [...listTs(SRC), ...listTs(resolve(__dirname, '../../../apps')), ...listTs(resolve(__dirname, '../../../layers'))]
      .filter((file) => !file.includes('node_modules') && !file.endsWith('AuthorizedActionCaptureRepository.ts') && !file.endsWith('index.ts'))
      .filter((file) => /AuthorizedActionCaptureRepository|toAccountableOwnerShape/.test(readFileSync(file, 'utf8')));
    expect(importers).toEqual([]);
  });
});
