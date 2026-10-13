/**
 * Data-capture Block C - architecture guard (no database required).
 * Explicit currency on cost-bearing movements: BO stays the single operational writer, the DAL writes no BO table, ABA is untouched,
 * and no default currency is substituted anywhere on the cost or purchase-order write paths.
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
    if (isTest(rel)) continue;
    production.push({ rel, code: readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n') });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const EXECUTOR = 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts';
const MAPPERS = 'packages/business-operations-runtime/src/intake/defaultMappers.ts';
const PO_REPO = 'packages/database/src/repositories/bo/PurchaseOrderRepository.ts';

describe('data-capture Block C architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(EXECUTOR).length).toBeGreaterThan(500);
  });

  it('the BO command executor is the ONLY writer of inventory_movements (and so of unit_cost and its currency)', () => {
    const writers = production.filter((f) => /INTO\s+business_operations\.inventory_movements/.test(f.code)).map((f) => f.rel);
    expect(writers).toEqual([EXECUTOR]);
    const costColumn = production.filter((f) => /unit_cost/.test(f.code)).map((f) => f.rel).sort();
    // B2b: the READ-ONLY policy facts repository selects unit_cost (never writes it; the INTO check above is the writer proof).
    expect(costColumn).toEqual([EXECUTOR, 'packages/database/src/repositories/bo/InventoryPolicyFactsRepository.ts'].sort());
  });

  it('the executor stores the supplied currency verbatim and never defaults it', () => {
    const code = read(EXECUTOR);
    expect(code).toContain('unit_cost_currency');
    expect(code).toMatch(/p\.unitCostCurrency \?\? null/);
    expect(code).not.toMatch(/unitCostCurrency\s*\?\?\s*'|toUpperCase|toLowerCase/);
  });

  it('no default currency on the cost or purchase-order write paths: no USD literal, no tenant/business default', () => {
    for (const rel of [EXECUTOR, MAPPERS, PO_REPO]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/'USD'|"USD"/);
      expect(code, rel).not.toMatch(/default_currency|defaultCurrency/);
      expect(code, rel).not.toMatch(/currency\w*\s*\?\?\s*['"]/i);
    }
  });

  it('the mapper never normalises a currency (no trimming or case folding)', () => {
    const code = read(MAPPERS);
    const fn = code.slice(code.indexOf('function currencyCode'), code.indexOf('const FACT_TYPES'));
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).not.toMatch(/toUpperCase|toLowerCase|trim\(/);
  });

  it('the DAL writes no BO table and imports no BO code', () => {
    const dal = production.filter((f) => f.rel.startsWith('packages/data-acquisition-runtime/src/') || f.rel.startsWith('layers/data-acquisition/'));
    expect(dal.length).toBeGreaterThan(5);
    expect(dal.filter((f) => /business_operations\.|inventory_movements|business-operations-runtime/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('ABA, the workflow package and the B2 evaluation record do not touch movement cost or currency', () => {
    const aba = production.filter((f) => f.rel.startsWith('packages/workflow/src/') || f.rel.startsWith('packages/database/src/repositories/approved_action/') || f.rel.startsWith('packages/handoff-contracts/src/'));
    expect(aba.length).toBeGreaterThan(20);
    expect(aba.filter((f) => /unit_cost|unitCost|inventory_movements/.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(production.filter((f) => /unit_cost_currency|unitCostCurrency/.test(f.code)).map((f) => f.rel).sort()).toEqual([EXECUTOR, MAPPERS, 'packages/business-operations-runtime/src/types.ts', 'packages/business-operations-runtime/src/inventory-policy/evaluate.ts', 'packages/database/src/repositories/bo/InventoryPolicyFactsRepository.ts', 'packages/business-operations-runtime/src/procurement/purchaseReceipt.ts', 'packages/business-operations-runtime/src/inventory-policy/InventoryEvidenceFactsService.ts'].sort()); // B2b adds two READERS (evaluator, facts repository); AC-2 Block 5 adds a third read-only BO reader (the evidence-facts service); Block A adds the receipt rule set (the same cost/currency pairing)
  });

  it('introduces no Block D structure, no evaluator, no transport and no execution capability (Blocks A, B, C and E are the authorized data-capture blocks)', () => {
    // Data-capture Block E (O-10) is authorized: exactly the BO executor and the BO command types may carry the configure command / state; nothing else.
    expect(production.filter((f) => /record_purchase_receipt|purchase_receipt_lines|reorder_policy_state|configure_inventory_reorder_policy/.test(f.code)).map((f) => f.rel).sort()).toEqual(['apps/api/src/schemas/businessOperations.ts', 'packages/business-operations-runtime/src/OperationalCommandExecutor.ts', 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts', 'packages/business-operations-runtime/src/intake/defaultMappers.ts', 'packages/business-operations-runtime/src/inventory/InventoryReorderPolicyService.ts', 'packages/business-operations-runtime/src/types.ts']); // Data-capture Block A (0197) adds the receipt command: types, mapper, executor and the intake response schema
    expect(read(EXECUTOR)).not.toMatch(/ExecutionEvidence|ACTION_AUTHORIZED|AuthorizedActionPackage/);
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
  });
});
