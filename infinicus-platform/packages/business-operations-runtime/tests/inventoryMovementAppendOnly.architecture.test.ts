/**
 * Data-capture follow-up (migration 0184) - architecture guard (no database required).
 * inventory_movements is append-only: no production code updates, deletes or truncates it, no production code can suspend the
 * database guard, and the privileged test cleanup helper is never reachable from production.
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
    else if (/\.(ts|tsx|js|mjs|sh)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const strip = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
const tests: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers', 'infrastructure']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    (isTest(rel) ? tests : production).push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const MUTATE = /(UPDATE\s+(ONLY\s+)?(business_operations\.)?inventory_movements\b|DELETE\s+FROM\s+(ONLY\s+)?(business_operations\.)?inventory_movements\b|TRUNCATE\s+(TABLE\s+)?(ONLY\s+)?(business_operations\.)?inventory_movements\b)/i;

describe('inventory_movements append-only architecture (0184)', () => {
  it('scans the real tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(tests.length).toBeGreaterThan(100);
  });

  it('no production code updates, deletes or truncates inventory_movements, in any SQL spelling', () => {
    expect(production.filter((f) => MUTATE.test(f.code)).map((f) => f.rel)).toEqual([]);
    // dynamic table names built from parts are not used for this table anywhere in production
    expect(production.filter((f) => /['"`]inventory_/.test(f.code) && /['"`]_?movements['"`]/.test(f.code) && !f.rel.endsWith('.sql')).map((f) => f.rel)).toEqual([]);
  });

  it('the BO command executor appends only (INSERT) and exposes no update/delete/repair method', () => {
    const exec = production.find((f) => f.rel === EXECUTOR)!.code;
    expect(exec).toMatch(/INSERT INTO business_operations\.inventory_movements/);
    expect(exec).not.toMatch(/inventory_movements[^`]*\b(SET|RETURNING\s+\*\s+FOR UPDATE)\b/i);
    expect(exec).not.toMatch(/\b(update|delete|repair|rewrite|backfill|truncate)Movement/i);
  });

  it('no repository or service exposes a movement mutation method', () => {
    const names = production.filter((f) => f.rel.startsWith('packages/') && /\.ts$/.test(f.rel))
      .filter((f) => /\b(update|delete|remove|purge|repair|rewrite|backfill|truncate)\w*Movements?\b|\bMovements?(Update|Delete|Remove|Purge|Repair)\w*\b/i.test(f.code)).map((f) => f.rel);
    expect(names).toEqual([]);
  });

  it('production code cannot suspend the guard: no replica switch, trigger DDL or table-level privilege change', () => {
    const offenders = production.filter((f) => !f.rel.endsWith('.sql')
      && /session_replication_role|DISABLE\s+TRIGGER|DROP\s+TRIGGER[^;]*inventory_movements|ALTER\s+TABLE[^;]*inventory_movements/i.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the only code using the privileged replica switch is test infrastructure (fixtures and the movement cleanup helpers)', () => {
    const users = tests.filter((f) => /session_replication_role/.test(f.code)).map((f) => f.rel);
    expect(users.length).toBeGreaterThan(0);
    for (const rel of users) expect(isTest(rel)).toBe(true);
    const cleanup = tests.filter((f) => !f.rel.endsWith('inventoryMovementAppendOnly.architecture.test.ts') && /export async function deleteMovementsForTenants/.test(f.code)).map((f) => f.rel).sort();
    expect(cleanup).toEqual([
      'packages/business-operations-runtime/tests/helpers/movementCleanup.ts',
      'packages/database/tests/helpers/movementCleanup.ts',
    ]);
  });

  it('no production file imports a test helper', () => {
    expect(production.filter((f) => /from\s+['"][^'"]*(tests?|helpers)\/[^'"]*movementCleanup/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('tests that delete movements go through the approved helper, not a raw DELETE', () => {
    const raw = tests.filter((f) => MUTATE.test(f.code) && !f.rel.endsWith('movementCleanup.ts')
      && !/inventory-movements-append-only\.integration\.test\.ts$/.test(f.rel)
      && !/inventoryMovementAppendOnly\.architecture\.test\.ts$/.test(f.rel)).map((f) => f.rel);
    expect(raw).toEqual([]);
  });
});
