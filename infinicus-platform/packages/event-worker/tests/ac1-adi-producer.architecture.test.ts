import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * AC-1 architecture guard (no database): the ADI producer of the first-action recommendation RECOMMENDS and nothing else. It cannot approve, authorize,
 * issue a package, write ABA or BO state, or execute; only ABA finalizes executable parameters; ADI never imports Business Operations (the one join is
 * the API composition root); the derivation is read-only; and exactly one action is supported.
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
const SOURCE = 'packages/workflow/src/ProposedActionSource.ts';
const DERIVE = 'packages/business-operations-runtime/src/inventory-policy/derive.ts';
const DERIVE_SERVICE = 'packages/business-operations-runtime/src/inventory-policy/ReorderPolicyDerivationService.ts';
const COMPOSITION = 'apps/api/src/reorderPolicyRecommendationComposition.ts';
const ROUTE = 'apps/api/src/routes/reorderPolicyRecommendation.ts';
const CONTRACT = 'packages/handoff-contracts/src/adi-proposed-action.ts';

describe('AC-1 ADI producer: ownership and boundaries', () => {
  it('the producer exists in the ADI/workflow package and uses only ADI repositories, the shared contracts and the shared transaction helper', () => {
    const code = read(PRODUCER);
    expect(code.length).toBeGreaterThan(0);
    expect(importsOf(code).sort()).toEqual(['./recommendationAuthoring.js', '@infinicus/database', '@infinicus/handoff-contracts', 'node:crypto']);
    const dbImport = /import\s*\{([^}]+)\}\s*from\s*'@infinicus\/database'/.exec(code)![1].split(',').map((x) => x.replace(/type\s+/, '').trim()).filter(Boolean).sort();
    expect(dbImport).toEqual(['DecisionCaseRepository', 'DecisionQuestionRepository', 'DecisionRecommendationRepository', 'TenantContext', 'withSharedTenantTransaction'].sort());
  });

  it('ADI cannot approve, authorize, issue, write ABA or BO state, or execute: no such identifier, table or SQL appears in the producer or the proposal reader', () => {
    for (const rel of [PRODUCER, SOURCE]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/AuthorizedActionPackageIssuer|ApprovedActionRepository|ApprovalDecisionRepository|AuthorizedActionCaptureRepository|AuthorizedActionBoundaryRepository|AuthorizedActionPackageRepository|AbaAuthoringService|DecisionWorkflowService|submitApprovalDecision|createAction/);
      expect(code, rel).not.toMatch(/approved_business_action|business_operations|inventory_balances|reorder_point|reorder_quantity|inventory_movements/);
      expect(code, rel).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i);
      expect(code, rel).not.toMatch(/OperationalCommandExecutor|InventoryBalanceRepository|AuthorizedActionExecution|runDue|ActionAuthorizedAnnouncer|outbox/);
      expect(code, rel).not.toMatch(/\bfinalParameters\b|\bmodification\b|packageDigest/); // ADI proposes; the final parameter set is ABA's
    }
  });

  it('the workflow (ADI/ABA) package never imports Business Operations; the derivation is joined to the producer only at the API composition root', () => {
    expect(filesMatching(/@infinicus\/business-operations-runtime/).filter((r) => r.startsWith('packages/workflow/'))).toEqual([]);
    const joiners = production.filter((f) => /ReorderPolicyDerivationService/.test(f.code) && !f.rel.startsWith('packages/business-operations-runtime/')).map((f) => f.rel);
    expect(joiners).toEqual([COMPOSITION]);
    const comp = read(COMPOSITION);
    expect(comp).toMatch(/new ReorderPolicyRecommendationProducer\(\{ deriver \}\)/);
    expect(importsOf(comp).sort()).toEqual(['@infinicus/business-operations-runtime', '@infinicus/workflow']);
  });

  it('the derivation and its service are READ-ONLY: no SQL write, no repository write, no event, no audit, no ABA/ADI/workflow import', () => {
    for (const rel of [DERIVE, DERIVE_SERVICE]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE)\b/i);
      expect(code, rel).not.toMatch(/recordAll|\.record\(|InventoryPolicyEvaluationRepository|emit|outbox|Audit|@infinicus\/workflow|approved_business_action|ai_decision_intelligence/);
    }
    expect(importsOf(read(DERIVE_SERVICE)).sort()).toEqual(['./ReorderPolicyDerivationService.js'.replace('ReorderPolicyDerivationService', 'derive'), './InventoryPolicyEvaluationService.js', './evaluate.js', './ruleSet.js', '@infinicus/database'].sort());
    // the loader is the SAME read-only facts repository and the evaluator the BO evaluation service uses: no second copy of the rules
    expect(read(DERIVE)).toMatch(/evaluateInventoryReorderPolicy/);
    expect(read(DERIVE_SERVICE)).toMatch(/InventoryPolicyFactsRepository/);
  });

  it('only ABA finalizes executable parameters: capture requires the proposal to equal ADI\'s recorded proposal and derives the final set itself; the producer never sees it', () => {
    const aba = read('packages/workflow/src/AbaAuthoringService.ts');
    expect(aba).toMatch(/proposalMatchesCapture/);
    expect(aba).toMatch(/PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION/);
    expect(aba).toMatch(/proposedActions: new AdiProposedActionSource\(\)/);
    expect(aba).toMatch(/const finalParameters = modified \? deriveFinalParameters\(/);
    // the ADI check sits BEFORE the transaction that writes the capture
    expect(aba.indexOf('PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION')).toBeLessThan(aba.indexOf('recordCapture(ctx, candidate)'));
  });

  it('the producer supports exactly one governed action and refuses every other', () => {
    const code = read(PRODUCER);
    expect(code).toMatch(/REORDER_ACTION = Object\.freeze\(\{ code: 'inventory_reorder_policy_update', schemaVersion: '1' \}\)/);
    expect(code).toMatch(/UNSUPPORTED_ACTION_TYPE/);
    expect(code.match(/inventory_reorder_policy_update/g)!.length).toBe(1); // one definition, no second action type
    expect(code).toMatch(/REORDER_PRODUCER_RULE_SET_VERSION = 'inventory-reorder-policy\/v1\.0\.0'/);
  });

  it('no LLM or model is involved in the numbers: the producer and derivation import no LLM client and no randomness', () => {
    for (const rel of [PRODUCER, DERIVE, DERIVE_SERVICE]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/llm-client|AnthropicClient|Math\.random|fetch\(|https?:\/\//);
    }
    expect(read(PRODUCER)).toMatch(/randomUUID/); // identifiers only (record codes), never a value
  });

  it('the HTTP surface is one tenant-scoped, adi:write, idempotent POST that imports only the business lookup and the composition', () => {
    const route = read(ROUTE);
    expect(route).toMatch(/requirePermission\(REORDER_RECOMMENDATION_PERMISSION\)/);
    expect(route).toMatch(/REORDER_RECOMMENDATION_PERMISSION = 'adi:write'/);
    expect(route).toMatch(/app\.authenticate, app\.resolveTenantContext/);
    expect(route).toMatch(/app\.requireActiveSubscription\(\), app\.requireIdempotencyKey/);
    expect(route).toMatch(/businesses\.getById\(request\.ctx!, businessId\)/);
    expect(route.match(/server\.(post|get|put|patch|delete)\(/g)).toEqual(['server.post(']);
    expect(importsOf(route).sort()).toEqual(['../reorderPolicyRecommendationComposition.js', '../schemas/common.js', '../schemas/reorderPolicyRecommendation.js', '@infinicus/database', 'fastify', 'fastify-type-provider-zod'].sort());
  });

  it('the structured contract invents no vocabulary and imports no layer: it validates against the canonical action registry only', () => {
    const code = read(CONTRACT);
    expect(importsOf(code).sort()).toEqual(['./authorized-action-package/action-types', './authorized-action-package/canonical-actions', './authorized-action-package/types']);
    expect(code).toMatch(/CANONICAL_ACTION_TYPES\.find/);
    expect(code).not.toMatch(/inventory_reorder_policy_update/); // the action type is read from the canonical registry, never restated
  });

  it('exactly one writer of the structured proposal exists, and it is the producer (no ABA/BO/route code writes the rationale)', () => {
    expect(filesMatching(/PROPOSED_ACTION_RATIONALE_CODE/).filter((r) => !r.includes('handoff-contracts')).sort()).toEqual([PRODUCER, SOURCE].sort());
    expect(filesMatching(/addRationale\([^)]*PROPOSED_ACTION_RATIONALE_CODE/)).toEqual([PRODUCER]);
  });
});
