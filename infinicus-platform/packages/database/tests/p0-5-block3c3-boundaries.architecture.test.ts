/**
 * P0-5 Block 3c-3 - architecture guard for the boundary repository (no database required).
 * A storage adapter: no issuance, no package logic, no events, no Business Operations, no simulation-layer read, no wiring.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../src');
const NAME = 'AuthorizedActionBoundaryRepository.ts';
const source = readFileSync(join(SRC, 'repositories/approved_action', NAME), 'utf8');
const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

function listTs(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? listTs(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('AuthorizedActionBoundaryRepository architecture', () => {
  it('imports only the tenant client, shared errors and the governance support module (no other repository)', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports.every((i) => ['../../client.js', './errors.js', './governanceSupport.js'].includes(i))).toBe(true);
    expect(source).not.toMatch(/Repository\.js'/);
  });

  it('touches only the boundaries table', () => {
    expect([...new Set([...code.matchAll(/approved_business_action\.(\w+)/g)].map((m) => m[1]))]).toEqual(['authorized_action_boundaries']);
  });

  it('decides nothing about authority, risk, packages or action types, reads no other layer, and emits nothing', () => {
    expect(code).not.toMatch(/approval_decisions|approver_assignments|approval_authority_scopes|approval_audit_events|approved_actions|action_type_|automation_level_/);
    expect(code).not.toMatch(/authorized_action_package|business_operations|simulation\.|outbox|business_event_ledger|CanonicalEventPublisher/i);
  });

  it('never updates or deletes (the table is append-only)', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/);
  });

  it('runs every query inside a tenant transaction (RLS-confined)', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(/);
    const methods = [...code.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(['recordBoundaries', 'getCurrent', 'getVersion', 'listVersions']);
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBe(methods.length);
  });

  it('is not wired into any route, service, layer or other repository yet (storage only)', () => {
    const importers = [...listTs(SRC), ...listTs(resolve(__dirname, '../../../apps')), ...listTs(resolve(__dirname, '../../../layers'))]
      .filter((file) => !file.includes('node_modules') && !file.endsWith(NAME) && !file.endsWith('index.ts'))
      .filter((file) => /AuthorizedActionBoundaryRepository|toPackageBoundaryParts/.test(readFileSync(file, 'utf8')));
    expect(importers).toEqual([]);
  });
});
