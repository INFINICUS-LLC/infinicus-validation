import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * AC-2 Block 4 architecture guard (no database): Business Operations is the sole writer of canonical operational truth, and Data Acquisition is not an
 * operational source of truth. Scans production source only (tests excluded).
 */
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
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const importsOf = (code: string): string[] => [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const SERVICE = 'packages/business-operations-runtime/src/inventory/InventoryReorderPolicyService.ts';
const ROUTE = 'apps/api/src/routes/inventoryReorderPolicyBaseline.ts';

describe('AC-2 Block 4: BO is the sole operational writer; DAL is not a source of truth', () => {
  it('canonical inventory items and warehouses are inserted only by the BO command executor', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(filesMatching(/INSERT\s+INTO\s+platform\.(inventory_items|warehouses)\b/i)).toEqual([EXECUTOR]);
  });

  it('inventory movements and balances are written only by the BO command executor (the one movement writer) and the governed BO function path', () => {
    expect(filesMatching(/INSERT\s+INTO\s+business_operations\.inventory_movements\b/i)).toEqual([EXECUTOR]);
    // the only other writer is the Business Operations repository inside the database package (BO-owned; not DAL, ADI, ABA or BI)
    expect(filesMatching(/INSERT\s+INTO\s+business_operations\.inventory_balances\b/i)).toEqual([EXECUTOR, 'packages/database/src/repositories/bo/InventoryBalanceRepository.ts'].sort());
  });

  it('Data Acquisition runtime references no Business Operations or canonical inventory table and imports no BO code: it prepares and publishes, nothing more', () => {
    const dal = production.filter((f) => f.rel.startsWith('packages/data-acquisition-runtime/src/'));
    expect(dal.length).toBeGreaterThan(5);
    for (const f of dal) {
      expect(f.code, f.rel).not.toMatch(/business_operations\.|platform\.(inventory_items|warehouses|businesses)\b|@infinicus\/business-operations-runtime|configure_inventory_reorder_policy|apply_inventory_reorder_policy/);
    }
  });

  it('the data-acquisition intake mappers cannot produce the reorder-policy command (D2: DAL never sets operational policy)', () => {
    const mappers = read('packages/business-operations-runtime/src/intake/defaultMappers.ts');
    expect(mappers).not.toMatch(/configure_inventory_reorder_policy|reorder_policy|reorderPoint|reorderQuantity/);
  });

  it('the first-policy route is BO-owned: it imports only BO runtime, the database package and framework code, and calls only configureInitial', () => {
    const code = read(ROUTE);
    expect(code.length).toBeGreaterThan(0);
    expect(importsOf(code).sort()).toEqual(['../schemas/common.js', '@infinicus/business-operations-runtime', '@infinicus/database', 'fastify', 'fastify-type-provider-zod', 'zod'].sort());
    expect(code).toMatch(/INITIAL_REORDER_POLICY_PERMISSION = 'bo:admin'/);
    expect(code).toMatch(/service\.configureInitial\(/);
    expect(code).not.toMatch(/\.configure\(|configureInventoryReorderPolicy|apply_inventory_reorder_policy|INSERT|UPDATE\s+\w/i);
    expect(code.match(/server\.(post|get|put|patch|delete)\(/g)).toEqual(['server.put(']);
  });

  it('the first-policy service forces the UNSET guard and BO_COMMAND source, and the guard lives in the executor under the row lock', () => {
    expect(read(SERVICE)).toMatch(/requireState: 'UNSET'/);
    expect(read(SERVICE)).toMatch(/configurationSource: 'BO_COMMAND'/);
    expect(read(EXECUTOR)).toMatch(/p\.requireState === 'UNSET' && row\.reorder_policy_state !== 'UNSET'/);
    expect(filesMatching(/requireState/).sort()).toEqual([EXECUTOR, SERVICE, 'packages/business-operations-runtime/src/types.ts'].sort());
  });

  it('BI, BDT-facing and ADI code never call the BO baseline service or the executor', () => {
    for (const f of production.filter((x) => /^packages\/(workflow|handoff-contracts)\/|^layers\//.test(x.rel))) {
      expect(f.code, f.rel).not.toMatch(/InventoryReorderPolicyService|OperationalCommandExecutor|configureInitial/);
    }
  });
});
