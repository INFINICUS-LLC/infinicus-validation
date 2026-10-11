/**
 * P0-5 Block 3e - architecture guard for the BO intake repository (no database required).
 * It is BO-owned storage: no ABA table, no inventory, no events, no execution.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FILE = resolve(__dirname, '../src/repositories/bo/AuthorizedActionIntakeRepository.ts');
const source = readFileSync(FILE, 'utf8');
const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('AuthorizedActionIntakeRepository architecture', () => {
  it('imports only the tenant client, the BO errors and the pg type', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../client.js', '../../client.js', './errors.js', 'pg']);
  });

  it('touches only its three BO tables: no ABA, inventory, event or outbox table', () => {
    const tables = new Set([...code.matchAll(/\$\{S\}\.(\w+)/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(['authorized_action_claims', 'authorized_action_intake_attempts', 'authorized_action_receipts']);
    expect(code).not.toMatch(/approved_business_action|inventory_|business_events|outbox|business_event_ledger|EventLedger|CanonicalEventPublisher/i);
  });

  it('never updates or deletes (the tables are append-only) and executes nothing', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b/);
    expect(code).not.toMatch(/OperationalCommandExecutor|executeOn|ExecutionEvidence|reorder_point|reorder_quantity/i);
  });

  it('every query runs inside a tenant transaction (RLS-confined) and is not wired to any route', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(|(?<![.\w])query\(/);
    const methods = [...code.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(['getClaim', 'getReceipt', 'receiveAndClaim', 'recordAttempt']);
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBe(methods.length);
  });

  it('serializes one package version with a transaction-scoped advisory lock and uses the database clock', () => {
    expect(code).toContain('pg_advisory_xact_lock');
    expect(code).toContain('clock_timestamp()');
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)/);
  });
});
