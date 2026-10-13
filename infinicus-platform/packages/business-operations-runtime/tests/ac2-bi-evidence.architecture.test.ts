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

const BI = 'packages/workflow/src/InventoryBiEvidenceService.ts';
const FACTS = 'packages/business-operations-runtime/src/inventory-policy/InventoryEvidenceFactsService.ts';
const COMPOSITION = 'apps/api/src/inventoryBiEvidenceComposition.ts';
const ROUTE = 'apps/api/src/routes/inventoryBiEvidence.ts';

describe('AC-2 Block 5: BI evidence boundaries', () => {
  it('the BI service imports only the database package and node:crypto: no Business Operations, ADI, ABA or event code', () => {
    const code = read(BI);
    expect(code.length).toBeGreaterThan(0);
    expect(importsOf(code).sort()).toEqual(['@infinicus/database', 'node:crypto']);
    expect(code).not.toMatch(/@infinicus\/business-operations-runtime|OperationalCommandExecutor|InventoryReorderPolicyService|AbaAuthoringService|AuthorizedActionPackage|DecisionRecommendationRepository|ExecutionEvidence/);
  });

  it('BI writes only BI tables, through BI repositories: no SQL, no operational table, no other layer\'s schema', () => {
    const code = read(BI);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE|client\.query|\.query\()/i);
    expect(code).not.toMatch(/business_operations|platform\.|approved_business_action|ai_decision_intelligence|data_acquisition|inventory_balances|inventory_movements|configure_inventory|apply_inventory|declared|unit_?cost/i);
    for (const repo of ['InsightPackageRepository', 'MetricCalculationRepository', 'MetricDefinitionRepository']) expect(code).toContain(repo);
  });

  it('the BO side of the port is READ-ONLY: no write, no event, no audit, and no BI, ADI, ABA or workflow import', () => {
    const code = read(FACTS);
    expect(code.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(code).not.toMatch(/recordAll|\.record\(|emit|outbox|audit|@infinicus\/workflow|business_intelligence|ai_decision_intelligence|approved_business_action/i);
    expect(importsOf(code).sort()).toEqual(['./InventoryPolicyEvaluationService.js', './decimal.js', './evaluate.js', './ruleSet.js', '@infinicus/database']);
  });

  it('BI and Business Operations are joined only at the API composition root', () => {
    const joiners = production.filter((f) => /InventoryEvidenceFactsService/.test(f.code) && !f.rel.startsWith('packages/business-operations-runtime/')).map((f) => f.rel);
    expect(joiners).toEqual([COMPOSITION]);
    expect(filesMatching(/InventoryBiEvidenceService/).filter((r) => !r.startsWith('packages/workflow/') && r !== COMPOSITION && r !== ROUTE && r !== 'apps/api/src/app.ts')).toEqual([]);
    expect(importsOf(read(COMPOSITION)).sort()).toEqual(['@infinicus/business-operations-runtime', '@infinicus/workflow']);
  });

  it('the HTTP surface is one bi:write, idempotent POST that calls only the BI service', () => {
    const route = read(ROUTE);
    expect(route).toMatch(/INVENTORY_BI_EVIDENCE_PERMISSION = 'bi:write'/);
    expect(route).toMatch(/app\.requireActiveSubscription\(\), app\.requireIdempotencyKey/);
    expect(route.match(/server\.(post|get|put|patch|delete)\(/g)).toEqual(['server.post(']);
    expect(route).not.toMatch(/@infinicus\/business-operations-runtime|INSERT|UPDATE\s+\w/i);
  });

  it('no other layer reads or writes the BI evidence tables on the first action\'s behalf except BI itself and the existing BI repositories', () => {
    const writers = filesMatching(/INSERT\s+INTO\s+business_intelligence\.(metric_calculated_values|insight_package_versions)/i);
    expect(writers.every((r) => r.startsWith('packages/database/src/repositories/bi/'))).toBe(true);
  });
});
