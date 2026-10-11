/**
 * P0-5 Block 3c-2 - architecture guard for the registry and policy repositories (no database required).
 * Storage adapters only: no issuance, no package logic, no events, no Business Operations, no route wiring, no vocabulary.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../src');
const DIR = join(SRC, 'repositories/approved_action');
const FILES = ['ActionTypeRegistryRepository.ts', 'AutomationLevelPolicyRepository.ts'];
const strip = (text: string) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

function listTs(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? listTs(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe.each(FILES)('%s architecture', (name) => {
  const source = readFileSync(join(DIR, name), 'utf8');
  const code = strip(source);

  it('imports only the tenant client, shared errors and the governance support module', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports.every((i) => ['../../client.js', './errors.js', './governanceSupport.js'].includes(i))).toBe(true);
  });

  it('touches only its own governance tables', () => {
    const tables = new Set([...code.matchAll(/approved_business_action\.(\w+)/g)].map((m) => m[1]));
    for (const table of tables) {
      expect([
        'action_type_definitions', 'action_type_status_events', 'automation_level_policies',
        'automation_level_policy_versions', 'automation_level_policy_enablement_events',
      ]).toContain(table);
    }
  });

  it('decides nothing about authority, risk, packages or captures, and emits no events or BO writes', () => {
    expect(code).not.toMatch(/approval_decisions|approver_assignments|approval_authority_scopes|approval_audit_events|approved_actions/);
    expect(code).not.toMatch(/authorized_action_|business_operations|outbox|business_event_ledger|CanonicalEventPublisher/i);
  });

  it('never updates or deletes (the tables are append-only)', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/);
  });

  it('runs every query inside a tenant transaction (RLS-confined)', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(/);
    expect(code).toMatch(/withTenantTransaction\(/);
  });

  it('ships no vocabulary or policy: no concrete action-type code or policy code literal is inserted', () => {
    expect(code).not.toMatch(/adjust_price|change_price|send_campaign|restock/i);
    expect(code).not.toMatch(/INSERT INTO [^`]*\(\s*[^)]*\)\s*VALUES\s*\(\s*'/);
  });
});

describe('governance repositories are not wired in yet (storage only)', () => {
  it('no route, service, layer or other repository imports them', () => {
    const importers = [...listTs(SRC), ...listTs(resolve(__dirname, '../../../apps')), ...listTs(resolve(__dirname, '../../../layers'))]
      .filter((file) => !file.includes('node_modules') && !FILES.some((f) => file.endsWith(f)) && !file.endsWith('index.ts'))
      .filter((file) => /ActionTypeRegistryRepository|AutomationLevelPolicyRepository|toActionTypeContract/.test(readFileSync(file, 'utf8')));
    expect(importers).toEqual([]);
  });
});
