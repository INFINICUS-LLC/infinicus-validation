import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * AC-2 Block 5 architecture guard (no database): Business Intelligence owns analytical evidence and nothing else. BI reads Business Operations only through
 * a structural read-only port joined at the API composition root, writes only BI tables through BI repositories, mutates no operational state, and neither
 * decides, authorizes nor executes anything.
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
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();
const importsOf = (code: string): string[] => [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

const TWIN = 'packages/workflow/src/InventoryItemTwinService.ts';
const STATE = 'packages/workflow/src/inventoryItemTwinState.ts';
const COMPOSITION = 'apps/api/src/inventoryItemTwinComposition.ts';
const ROUTE = 'apps/api/src/routes/inventoryItemTwin.ts';

describe('AC-2 Block 6: BDT state boundaries', () => {
  it('the twin service consumes BI evidence only: it imports the database package, the BI service types and the pure state module - never Business Operations', () => {
    const code = read(TWIN);
    expect(code.length).toBeGreaterThan(0);
    expect(importsOf(code).sort()).toEqual(['./InventoryBiEvidenceService.js', './inventoryItemTwinState.js', '@infinicus/database', 'node:crypto']);
    expect(code).not.toMatch(/@infinicus\/business-operations-runtime|OperationalCommandExecutor|InventoryReorderPolicyService|InventoryEvidenceFactsService|AbaAuthoringService|AuthorizedActionPackage|DecisionRecommendationRepository|ExecutionEvidence/);
  });

  it('BDT writes only Digital Twin tables through the existing twin repositories: no SQL, no operational table, no BI table write', () => {
    const code = read(TWIN);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE|client\.query|\.query\()/i);
    expect(code).not.toMatch(/business_operations|platform\.|inventory_balances|inventory_movements|business_intelligence|configure_inventory|apply_inventory|declared|unit_?cost/i);
    for (const repo of ['DigitalTwinDefinitionRepository', 'DigitalTwinInstanceRepository', 'DigitalTwinSnapshotRepository']) expect(code).toContain(repo);
  });

  it('the state derivation is pure: no import, I/O, clock, randomness or database; and the state model carries no raw operational fact field', () => {
    const code = read(STATE);
    expect(code.length).toBeGreaterThan(0);
    expect(importsOf(code)).toEqual([]);
    expect(code).not.toMatch(/Date\.now\(|new Date\(|Math\.random|randomUUID|process\.env|\bawait\b|fetch\(|require\(/);
    expect(code).not.toMatch(/quantityOnHand|unitCost|costCurrency|currency/i);
  });

  it('BDT is joined to BI only through the API composition (the BI composition is the one place BI meets Business Operations)', () => {
    expect(importsOf(read(COMPOSITION)).sort()).toEqual(['./inventoryBiEvidenceComposition.js', '@infinicus/workflow']);
    expect(filesMatching(/InventoryItemTwinService/).filter((r) => !r.startsWith('packages/workflow/') && ![COMPOSITION, ROUTE, 'apps/api/src/app.ts', 'apps/api/src/reorderPolicyRecommendationComposition.ts' /* AC-2 Block 7: ADI is handed the twin read side here; see ac2-adi-boundary.architecture.test.ts */].includes(r))).toEqual([]);
  });

  it('the HTTP surface is one dt:write, idempotent POST that calls only the twin service and reads no Business Operations table', () => {
    const route = read(ROUTE);
    expect(route).toMatch(/INVENTORY_ITEM_TWIN_PERMISSION = 'dt:write'/);
    expect(route).toMatch(/app\.requireActiveSubscription\(\), app\.requireIdempotencyKey/);
    expect(route.match(/server\.(post|get|put|patch|delete)\(/g)).toEqual(['server.post(']);
    expect(route).not.toMatch(/@infinicus\/business-operations-runtime|INSERT|UPDATE\s+\w|business_operations/i);
  });

  it('only Digital Twin repositories write the twin snapshot value and evidence tables on the first action\'s behalf', () => {
    const writers = filesMatching(/INSERT\s+INTO\s+business_digital_twin\.(digital_twin_snapshot_values|digital_twin_snapshot_evidence)/i);
    expect(writers.every((r) => r.startsWith('packages/database/src/repositories/dt/'))).toBe(true);
  });

  it('Business Operations, ADI, ABA and the BO evaluator never read the twin state as an input to a decision on the first action (Block 7 will consume it through ADI only)', () => {
    for (const f of production.filter((x) => x.rel.startsWith('packages/business-operations-runtime/src/'))) {
      expect(f.code, f.rel).not.toMatch(/InventoryItemTwinService|inventory_item_state|inventory-item-twin|digital_twin_snapshot/);
    }
  });
});
