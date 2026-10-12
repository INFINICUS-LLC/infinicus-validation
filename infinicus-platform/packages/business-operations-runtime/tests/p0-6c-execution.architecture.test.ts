/**
 * P0-6c architecture guard (no database): the BO execution engine is the only consumer of authorized claims, the single writer of the
 * balance stays the BO executor, authority is requested only under lock and has no hidden age default, and nothing is wired or enabled yet.
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
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const raw = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8');
const sql = (rel: string): string => raw(rel).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const DIR = 'packages/business-operations-runtime/src/authorized-action-execution/';
const SERVICE = `${DIR}AuthorizedActionExecutionService.ts`;
const ADAPTER = `${DIR}InventoryReorderPolicyExecutionAdapter.ts`;
const REPO = 'packages/database/src/repositories/bo/AuthorizedActionExecutionRepository.ts';
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';

describe('P0-6c architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [SERVICE, ADAPTER, REPO, EXECUTOR]) expect(read(rel).length, rel).toBeGreaterThan(500);
  });

  it('the execution tables are written only by the execution repository (INSERT only, never UPDATE/DELETE)', () => {
    const writers = production.filter((f) => /INSERT\s+INTO\s+\$\{S\}\.authorized_action_execution|INSERT\s+INTO\s+business_operations\.authorized_action_execution/i.test(f.code)).map((f) => f.rel);
    expect(writers).toEqual([REPO]);
    expect(production.filter((f) => /(UPDATE|DELETE\s+FROM)\s+(\$\{S\}|business_operations)\.authorized_action_execution/i.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('the engine is the only caller of the execution repository writes', () => {
    const callers = production.filter((f) => /\.(insertExecution|insertAttempt)\(/.test(f.code)).map((f) => f.rel);
    expect(callers).toEqual([SERVICE]);
  });

  it('the single writer of reorder_point / reorder_quantity remains the BO executor (the engine and adapter write no balance SQL)', () => {
    expect(production.filter((f) => /SET\s+reorder_point\s*=/i.test(f.code)).map((f) => f.rel)).toEqual([EXECUTOR]);
    for (const rel of [SERVICE, ADAPTER, REPO]) {
      expect(read(rel), rel).not.toMatch(/UPDATE\s+business_operations|INSERT\s+INTO\s+business_operations\.inventory|inventory_movements|app\.bo_reorder_policy_writer/i);
    }
    expect(read(ADAPTER)).toContain('configureInventoryReorderPolicy');
  });

  it('authority is requested only AFTER the target balance is locked, and the answer is judged against the database clock', () => {
    const code = read(SERVICE);
    const lock = code.indexOf('this.adapter.lockTarget(');
    const ask = code.indexOf('this.deps.statusProvider.getStatus(');
    const clock = code.indexOf('await repo.databaseNow(client)', ask);
    expect(lock).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(lock);
    expect(clock).toBeGreaterThan(ask);
    expect(read(ADAPTER)).toMatch(/FOR UPDATE/);
    expect(code).toContain('validateForExecutionAfterClaim');
    expect(code).not.toMatch(/validateForExecution\(/);
  });

  it('the status age is a required argument: no default, no magic number in the engine (ruling O-2 is supplied by the composition root)', () => {
    const code = read(SERVICE);
    expect(code).toMatch(/executionStatusMaxAgeMs must be a non-negative number/);
    expect(code).not.toMatch(/executionStatusMaxAgeMs\s*\?\?|\b5000\b|5_000\b/);
    expect(read(`${DIR}constants.ts`)).not.toMatch(/executionStatusMaxAgeMs\s*=|STATUS_MAX_AGE/);
  });

  it('the owner-ruled retry policy values are the named constants (O-3): 3 attempts, 1s/5s/15s, 60s recovery', () => {
    const c = read(`${DIR}constants.ts`);
    expect(c).toMatch(/EXECUTION_MAX_ATTEMPTS = 3;/);
    expect(c).toMatch(/Object\.freeze\(\[1_000, 5_000, 15_000\]\)/);
    expect(c).toMatch(/EXECUTION_CLAIM_RECOVERY_MS = 60_000;/);
  });

  it('BO imports ABA only through shared port types: no workflow package, no ABA table or repository', () => {
    for (const rel of [SERVICE, ADAPTER, `${DIR}executionEvidence.ts`, `${DIR}preconditions.ts`, `${DIR}constants.ts`]) {
      expect(read(rel), rel).not.toMatch(/@infinicus\/workflow|approved_business_action|AuthorizedActionPackageRepository|Aba[A-Z]\w+(Provider|Source|Recorder)/);
    }
  });

  it('the engine is unwired and enables nothing: no app, worker or consumer references it; the production registry is empty; no event is emitted', () => {
    const users = production.filter((f) => /AuthorizedActionExecutionService|InventoryReorderPolicyExecutionAdapter/.test(f.code)).map((f) => f.rel).sort();
    expect(users).toEqual([ADAPTER, SERVICE, 'packages/business-operations-runtime/src/index.ts'].sort());
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\[\]\)/);
    for (const rel of [SERVICE, ADAPTER, REPO]) expect(read(rel), rel).not.toMatch(/OutboxRepository|enqueue|operations\.action\.executed|ACTION_EXECUTED|execution_capability_activations/);
    expect(production.filter((f) => f.rel.startsWith('packages/handoff-contracts/') && /\bExecutionEvidence\b|execution-evidence\/1/.test(f.code))).toEqual([]);
  });

  it('migrations 0191 and 0192 are contiguous after 0190 and carry no data change, backfill or role statement', () => {
    const files = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_/.test(f)).sort();
    const at = files.indexOf('0190_add_outbox_claimed_at.sql');
    expect(files.slice(at + 1, at + 3)).toEqual(['0191_create_bo_authorized_action_executions.sql', '0192_guard_inventory_reorder_fields.sql']);
    for (const f of files.slice(at + 1, at + 3)) {
      const body = sql(`infrastructure/database/migrations/${f}`);
      expect(body, f).not.toMatch(/\bGRANT\b|CREATE ROLE|\bDROP TABLE\b|\bTRUNCATE\s+(TABLE\s+)?business_operations\.(inventory|authorized)|\bDELETE\s+FROM\b/i);
      expect(body, f).toMatch(/_migrations/);
    }
    const m3 = sql('infrastructure/database/migrations/0192_guard_inventory_reorder_fields.sql');
    expect(m3).toMatch(/CHECK \(reorder_point >= 0 AND reorder_quantity >= 0\) NOT VALID/);
    expect(m3).not.toMatch(/\bVALIDATE CONSTRAINT\b|\bUPDATE\s+business_operations/i);
    const m1 = sql('infrastructure/database/migrations/0191_create_bo_authorized_action_executions.sql');
    expect(m1).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(m1).toMatch(/forbid_mutation_/);
    expect(m1).not.toMatch(/\bINSERT INTO business_operations|\bUPDATE\s+business_operations/i);
  });

  it('legacy ABA blocks 17/19/20/21 stay unimported', () => {
    expect(production.filter((f) => !f.rel.startsWith('layers/approved-business-action/') && /approved-business-action\/blocks/.test(f.code))).toEqual([]);
  });
});
