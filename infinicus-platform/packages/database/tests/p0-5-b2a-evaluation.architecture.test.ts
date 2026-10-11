/**
 * Block B2a - architecture guard for the BO inventory policy evaluation record (no database required).
 * It is BO-owned storage of results: no ABA, no workflow, no evaluator, no route, no events, no inventory mutation, no execution.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const PLATFORM = resolve(__dirname, '../../..');
const REPO = 'packages/database/src/repositories/bo/InventoryPolicyEvaluationRepository.ts';
const source = readFileSync(resolve(PLATFORM, REPO), 'utf8');
const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)tests?\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);

describe('InventoryPolicyEvaluationRepository architecture', () => {
  it('imports only the tenant client and the BO errors', () => {
    expect([...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()).toEqual(['../../client.js', '../../client.js', './errors.js']);
  });

  it('touches only its own BO table: no ABA, simulation, ADI, inventory, event or outbox table', () => {
    const tables = new Set([...code.matchAll(/business_operations\.(\w+)/g)].map((m) => m[1]));
    expect([...tables]).toEqual(['inventory_policy_evaluations']);
    expect(code).not.toMatch(/approved_business_action|simulation\.|ai_decision_intelligence|inventory_balances|inventory_movements|business_events|outbox|business_event_ledger|CanonicalEventPublisher/i);
  });

  it('never updates, deletes or truncates, evaluates nothing and executes nothing', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b/);
    expect(code).not.toMatch(/OperationalCommandExecutor|ExecutionEvidence|reorder_point|reorder_quantity|capacity|threshold|daysOfCover|maxOrderValue/i);
  });

  it('every query runs inside a tenant transaction (RLS-confined) and only the four documented methods exist', () => {
    expect(code).not.toMatch(/getPool\(|\bpool\.query\(|(?<![.\w])query\(/);
    const methods = [...code.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]).sort();
    expect(methods).toEqual(['findForSubject', 'getById', 'listForBusiness', 'record']);
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBe(methods.length);
  });

  it('is not wired anywhere: no route, service, layer, runtime, workflow or ABA code references the repository or the table yet', () => {
    const users: string[] = [];
    for (const root of ['apps', 'packages', 'layers']) {
      for (const file of walk(join(PLATFORM, root))) {
        const rel = relative(PLATFORM, file).split('\\').join('/');
        if (isTest(rel) || rel === REPO || rel === 'packages/database/src/repositories/bo/index.ts' || rel === 'packages/database/src/index.ts') continue;
        if (/InventoryPolicyEvaluationRepository|inventory_policy_evaluations|InventoryPolicyEvaluation\b/.test(readFileSync(file, 'utf8'))) users.push(rel);
      }
    }
    expect(users).toEqual([]);
  });

  it('the shared subject-digest helper lives in the contract package, not in the repository', () => {
    expect(code).not.toMatch(/createHash|sha256\(|canonicalize/);
  });
});
