/**
 * Data-capture Block E - architecture guard (no database required).
 * Only the BO executor's configure command writes reorder_policy_state; ABA, DAL, API and the evaluator never do; the migration is
 * additive, backfill-free and guarded; the evaluator semantics are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const migration = readFileSync(join(PLATFORM, 'infrastructure/database/migrations/0189_add_inventory_reorder_policy_state.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('data-capture Block E architecture (reorder policy state)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(production.find((f) => f.rel === EXECUTOR)?.code.length).toBeGreaterThan(500);
  });

  it('only the BO executor writes reorder_policy_state', () => {
    const writers = production.filter((f) => /reorder_policy_state|reorder_policy_configured/.test(f.code)).map((f) => f.rel).sort();
    // P0-6c: the execution adapter READS reorder_policy_state (to lock/judge the target balance); it writes nothing - the executor does.
    expect(writers).toEqual([EXECUTOR, 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts']);
    expect(production.find((f) => f.rel.endsWith('InventoryReorderPolicyExecutionAdapter.ts'))!.code).not.toMatch(/(?<!FOR )\bUPDATE\b|\bINSERT\b|set_config/);
  });

  it('no application code sets any session variable to write the reorder policy: the writer marker lives only inside the governed database function (migration 0196), and the executor calls it', () => {
    expect(production.filter((f) => f.code.includes('app.bo_reorder_policy_writer')).map((f) => f.rel)).toEqual([]);
    expect(production.filter((f) => f.code.includes('apply_inventory_reorder_policy(')).map((f) => f.rel)).toEqual([EXECUTOR]);
  });

  it('the command literal lives only in the executor and the BO types; its service is used by no other layer', () => {
    const literal = production.filter((f) => f.code.includes('configure_inventory_reorder_policy')).map((f) => f.rel).sort();
    expect(literal).toEqual([
      'packages/business-operations-runtime/src/OperationalCommandExecutor.ts',
      'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts', // P0-6c: the authorized path calls the same command
      'packages/business-operations-runtime/src/types.ts',
    ]);
    const outside = production.filter((f) => /ConfigureInventoryReorderPolicyCommand|InventoryReorderPolicyService/.test(f.code)
      && !f.rel.startsWith('packages/business-operations-runtime/src/')).map((f) => f.rel);
    expect(outside).toEqual([]);
  });

  it('intake cannot reach the command: it is outside the OperationalCommand union, the executeOn switch and every mapper', () => {
    const types = production.find((f) => f.rel === 'packages/business-operations-runtime/src/types.ts')!.code;
    const union = types.slice(types.indexOf('export type OperationalCommand ='), types.indexOf('export interface IntakeMappingContext'));
    expect(union).toContain('RecordInventoryMovementCommand');
    expect(union).not.toContain('ConfigureInventoryReorderPolicyCommand');
    const exec = production.find((f) => f.rel === EXECUTOR)!.code;
    expect(exec.slice(exec.indexOf('async executeOn('), exec.indexOf('private async recordInventoryMovement'))).not.toContain('configure');
    expect(production.filter((f) => f.rel.includes('/intake/') && /configure_inventory_reorder_policy|ConfigureInventoryReorderPolicy/.test(f.code))).toEqual([]);
  });

  it('the evaluator and the verifier do not read the new state (semantics unchanged by this block)', () => {
    const evaluator = production.filter((f) => f.rel.startsWith('packages/business-operations-runtime/src/inventory-policy/') || f.rel.endsWith('InventoryPolicyFactsRepository.ts'));
    expect(evaluator.length).toBeGreaterThan(3);
    expect(evaluator.filter((f) => /reorder_policy_state|reorder_policy_configured|reorderPolicyState/.test(f.code))).toEqual([]);
  });

  it('the migration is additive: guarded, constrained, no backfill, no data change, no role statements', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS reorder_policy_state text NOT NULL DEFAULT 'UNSET'/);
    expect(migration).toMatch(/CREATE TRIGGER trg_inventory_balances_reorder_policy_writer\s+BEFORE INSERT OR UPDATE/);
    expect(migration).toMatch(/cannot return to UNSET/);
    expect(migration).toMatch(/_migrations/);
    expect(migration).not.toMatch(/\bUPDATE\s+business_operations/i);
    expect(migration).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bGRANT\b|\bCREATE ROLE\b/i);
    expect(migration).not.toMatch(/\bINSERT INTO business_operations/i);
  });

  it('migration 0189 is contiguous after 0188 and the only new file', () => {
    const files = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_/.test(f)).sort();
    expect(files.indexOf('0189_add_inventory_reorder_policy_state.sql')).toBe(files.indexOf('0188_freeze_decided_approval_decisions.sql') + 1);
  });
});
