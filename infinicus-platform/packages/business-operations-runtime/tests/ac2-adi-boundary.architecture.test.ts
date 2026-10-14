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

const PRODUCER = 'packages/workflow/src/ReorderPolicyRecommendationProducer.ts';
const COMPOSITION = 'apps/api/src/reorderPolicyRecommendationComposition.ts';
const ROUTE = 'apps/api/src/routes/reorderPolicyRecommendation.ts';
const CONTRACT = 'packages/handoff-contracts/src/adi-proposed-action.ts';

describe('AC-2 Block 7: the ADI input boundary', () => {
  it('ADI reaches BI and BDT only through ports: no BI or Digital Twin repository, table or SQL in the producer, and no Business Operations import', () => {
    const code = read(PRODUCER);
    expect(code.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/InsightPackageRepository|MetricCalculationRepository|MetricDefinitionRepository|DigitalTwin\w*Repository|business_intelligence|business_digital_twin/);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(code).not.toMatch(/@infinicus\/business-operations-runtime|InventoryBiEvidenceService\b|InventoryItemTwinService\b.*new /);
    expect(code).toMatch(/bi: InventoryBiEvidenceReader/);
    expect(code).toMatch(/twin: GovernedTwinStatePort/);
  });

  it('the evidence gate precedes the derivation and the producer never proceeds without BI and BDT (the ports are required constructor dependencies)', () => {
    const code = read(PRODUCER);
    expect(code.indexOf('BI_EVIDENCE_MISSING')).toBeGreaterThan(-1);
    expect(code.indexOf("none('BI_EVIDENCE_MISSING'")).toBeLessThan(code.indexOf('this.d.deriver.derive('));
    expect(code).toMatch(/Pick<ReorderPolicyRecommendationProducerDependencies, 'deriver' \| 'bi' \| 'twin'>/);
    for (const refusal of ['BI_EVIDENCE_EXPIRED', 'BDT_STATE_MISSING', 'BDT_STATE_EXPIRED', 'BI_BDT_EVIDENCE_MISMATCH', 'BDT_STATE_STALE', 'EVIDENCE_DIGEST_MISMATCH']) expect(code).toContain(refusal);
  });

  it('the proposal cites the BI evidence and the BDT state, and the recommendation is anchored to the twin snapshot for the existing freshness gate', () => {
    const code = read(PRODUCER);
    expect(code).toMatch(/kind: BI_EVIDENCE_REFERENCE_KIND/);
    expect(code).toMatch(/kind: BDT_STATE_REFERENCE_KIND/);
    expect(code).toMatch(/twinSnapshotId: twin\.snapshotId/);
  });

  it('the requirement is enforced where capture is accepted: the structured contract demands the BI and BDT references for this action type (and only the contract names the requirement set)', () => {
    expect(read(CONTRACT)).toMatch(/BI_BDT_EVIDENCE_REQUIRED\.has\(actionTypeKey\(/);
    expect(filesMatching(/BI_BDT_EVIDENCE_REQUIRED/).filter((r) => !r.startsWith('packages/handoff-contracts/'))).toEqual([]);
    expect(read('packages/workflow/src/AbaAuthoringService.ts')).toMatch(/proposalEvidenceProblems\(stored\.proposal\)/);
  });

  it('only the producer writes BI/BDT reference kinds into a proposal; ABA, BO and the BI/BDT services never author them', () => {
    const writers = filesMatching(/kind: (BI_EVIDENCE_REFERENCE_KIND|BDT_STATE_REFERENCE_KIND)/);
    expect(writers).toEqual([PRODUCER]);
  });

  it('the HTTP surface requires the ADI, BO, BI and DT permissions and the composition hands ADI the BI and BDT services', () => {
    const route = read(ROUTE);
    for (const permission of ['REORDER_RECOMMENDATION_PERMISSION', 'REORDER_RECOMMENDATION_BO_PERMISSION', 'REORDER_RECOMMENDATION_BI_PERMISSION', 'REORDER_RECOMMENDATION_DT_PERMISSION']) {
      expect(route).toMatch(new RegExp(`app\\.requirePermission\\(${permission}\\)`));
    }
    expect(route).toMatch(/REORDER_RECOMMENDATION_BI_PERMISSION = 'bi:read'/);
    expect(route).toMatch(/REORDER_RECOMMENDATION_DT_PERMISSION = 'dt:read'/);
    expect(read(COMPOSITION)).toMatch(/new ReorderPolicyRecommendationProducer\(\{ deriver, bi: /);
  });

  it('Business Operations never imports ADI or its producer (the join stays at the composition roots)', () => {
    for (const f of production.filter((x) => x.rel.startsWith('packages/business-operations-runtime/src/'))) {
      expect(f.code, f.rel).not.toMatch(/ReorderPolicyRecommendationProducer|@infinicus\/workflow/);
    }
  });
});
