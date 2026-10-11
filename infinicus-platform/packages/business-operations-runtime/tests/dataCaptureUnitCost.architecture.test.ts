/**
 * Data-capture Block B - architecture guard (no database required).
 * A present unit cost must be positive; the rule is shared by the mapper and the BO executor; the executor stays the only writer;
 * the DAL writes no BO table; no repair, backfill or second cost writer exists.
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
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n') });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const MAPPERS = 'packages/business-operations-runtime/src/intake/defaultMappers.ts';
const RULE = 'packages/business-operations-runtime/src/unitCost.ts';
const migration = readFileSync(join(PLATFORM, 'infrastructure/database/migrations/0187_require_positive_inventory_unit_cost.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('data-capture Block B architecture (positive unit cost)', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(EXECUTOR).length).toBeGreaterThan(500);
    expect(read(RULE).length).toBeGreaterThan(100);
  });

  it('the BO executor remains the ONLY writer of inventory_movements and of unit_cost (no second cost writer)', () => {
    expect(production.filter((f) => /INTO\s+business_operations\.inventory_movements/.test(f.code)).map((f) => f.rel)).toEqual([EXECUTOR]);
    const costUsers = production.filter((f) => /\bunit_cost\b/.test(f.code)).map((f) => f.rel);
    expect(costUsers).toEqual([EXECUTOR]);
  });

  it('the mapper and the executor both apply the one shared positivity rule (they cannot drift) and neither rounds or coerces', () => {
    for (const rel of [MAPPERS, EXECUTOR]) {
      expect(read(rel), rel).toMatch(/unitCostProblem\(/);
      expect(read(rel), rel).not.toMatch(/Math\.(round|abs|max|floor|ceil|trunc)\(\s*(p\.|data\.)?unitCost|toFixed\(|Number\(\s*(p\.|data\.)?unitCost|parseFloat\(\s*(p\.|data\.)?unitCost/);
    }
    const rule = read(RULE);
    expect(rule).toMatch(/value <= 0/);
    expect(rule).toMatch(/Number\.isFinite/);
    expect(rule).not.toMatch(/value < 0\b|>= 0\b/);
  });

  it('no repair, backfill or rewrite of costs exists: no UPDATE of unit_cost, no migration data statement', () => {
    expect(production.filter((f) => /UPDATE\s+\S*inventory_movements|SET\s+unit_cost\b/i.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(migration).not.toMatch(/\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|VALIDATE CONSTRAINT|INSERT INTO (?!_migrations)/);
  });

  it('the DAL (data-acquisition runtime and layer) writes no BO table and no cost', () => {
    for (const f of production.filter((x) => x.rel.startsWith('packages/data-acquisition-runtime/') || x.rel.startsWith('layers/data-acquisition/'))) {
      expect(f.code, f.rel).not.toMatch(/business_operations\.inventory_movements|\bunit_cost\b/);
    }
  });

  it('ABA (workflow) and the declared-currency code neither write nor name the movement cost', () => {
    for (const f of production.filter((x) => x.rel.startsWith('packages/workflow/') || /BusinessDeclaredCurrency/.test(x.code))) {
      expect(f.code, f.rel).not.toMatch(/INTO\s+business_operations\.inventory_movements|\bunit_cost\b/);
    }
  });
});
