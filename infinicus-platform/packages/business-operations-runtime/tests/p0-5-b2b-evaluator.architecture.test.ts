/**
 * Block B2b - architecture guard for the BO-owned inventory policy evaluator (no database required).
 * Business Operations owns evaluation truth. The evaluator reads BO facts, applies the approved rule set, appends records through the B2a
 * repository and does nothing else: no ABA / workflow dependency, no inventory mutation, no event, no authorization, no issuance, no
 * execution, no ExecutionEvidence, no capability change, no P0-6.
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
const strip = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: strip(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';

const DIR = 'packages/business-operations-runtime/src/inventory-policy/';
const SERVICE = `${DIR}InventoryPolicyEvaluationService.ts`;
const EVALUATE = `${DIR}evaluate.ts`;
const FACTS = 'packages/database/src/repositories/bo/InventoryPolicyFactsRepository.ts';
const EVAL_REPO = 'packages/database/src/repositories/bo/InventoryPolicyEvaluationRepository.ts';
const evaluatorFiles = production.filter((f) => f.rel.startsWith(DIR));
const ROUTE = 'apps/api/src/routes/inventoryPolicyEvaluations.ts';
const pure = [`${DIR}decimal.ts`, `${DIR}ruleSet.ts`, EVALUATE];

describe('B2b evaluator architecture', () => {
  it('scans the real tree (not vacuous) and the evaluator files exist inside Business Operations', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(evaluatorFiles.map((f) => f.rel).sort()).toEqual([`${DIR}BoGovernanceEvidenceVerifier.ts`, `${DIR}InventoryPolicyEvaluationService.ts`, `${DIR}decimal.ts`, `${DIR}evaluate.ts`, `${DIR}index.ts`, `${DIR}ruleSet.ts`,
      // AC-1: the read-only derivation of a rule-compliant candidate for the ADI producer (same evaluator, same facts repository; writes nothing - see ac1-adi-producer.architecture.test.ts)
      `${DIR}derive.ts`, `${DIR}ReorderPolicyDerivationService.ts`, `${DIR}ReorderPolicyBaselineEvidenceRecorder.ts`,
      // AC-2 Block 5: the read-only evidence facts BO exposes to Business Intelligence (writes nothing; see ac2-bi-evidence.architecture.test.ts)
      `${DIR}InventoryEvidenceFactsService.ts`].sort());
    expect(read(FACTS).length).toBeGreaterThan(500);
  });

  it('Business Operations owns the evaluator: it imports no ABA, workflow, API, data-acquisition or layer code', () => {
    for (const f of [...evaluatorFiles, { rel: FACTS, code: read(FACTS) }]) {
      const specs = [...f.code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+'([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('.'));
      for (const spec of specs) expect(['@infinicus/database', '@infinicus/handoff-contracts', 'node:crypto'], `${f.rel} imports ${spec}`).toContain(spec);
      expect(f.code, f.rel).not.toMatch(/@infinicus\/(workflow|onboarding|api|data-acquisition|layer-)|approved_business_action|ApprovedAction|AuthorizedActionPackageRepository|ActionExecutionPlan|packages\/workflow/);
    }
  });

  it('the pure rule engine has no I/O, clock, randomness, environment or database: results depend only on its inputs', () => {
    for (const rel of pure) {
      expect(read(rel), rel).not.toMatch(/\bDate\.now\(|new Date\(|Math\.random|randomUUID|process\.env|withTenantTransaction|\bpg\b|client\.query|fetch\(|require\(|await /);
    }
  });

  it('ABA, workflow, handoff contracts, DAL, apps and layers do not reference the evaluator, its records or its repositories (ABA is not the evaluation source of truth)', () => {
    const users = production.filter((f) => !f.rel.startsWith(DIR) && ![FACTS, EVAL_REPO, 'packages/database/src/index.ts', 'packages/database/src/repositories/bo/index.ts', 'packages/business-operations-runtime/src/index.ts', ROUTE, 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts'].includes(f.rel)
      && /InventoryPolicyEvaluationService|InventoryPolicyEvaluationRepository|InventoryPolicyFactsRepository|inventory_policy_evaluations|evaluateInventoryReorderPolicy/.test(f.code)).map((f) => f.rel);
    expect(users).toEqual([]);
  });

  it('there is exactly one writer of inventory_policy_evaluations (the B2a repository) and one caller of it (the evaluator service)', () => {
    expect(production.filter((f) => /INSERT\s+INTO\s+business_operations\.inventory_policy_evaluations/i.test(f.code)).map((f) => f.rel)).toEqual([EVAL_REPO]);
    expect(production.filter((f) => /\.(record|recordAll)\(/.test(f.code) && /InventoryPolicyEvaluationRepository|evaluations:/.test(f.code)).map((f) => f.rel)).toEqual([SERVICE]);
    expect(read(EVAL_REPO)).not.toMatch(/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b/);
    // the evaluation clock belongs to the database: no evaluated_at value is ever written by application code
    const insertColumns = /INSERT\s+INTO\s+business_operations\.inventory_policy_evaluations\s*\(([^)]*)\)/i.exec(read(EVAL_REPO));
    expect(insertColumns).not.toBeNull();
    expect(insertColumns![1]).not.toMatch(/evaluated_at/);
    expect(read(SERVICE)).not.toMatch(/evaluated_?[aA]t\s*:/);
  });

  it('the facts repository is read-only and touches only the BO facts the rule set names', () => {
    const code = read(FACTS);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
    expect(code).not.toMatch(/OperationalCommandExecutor|emit_outbox_event|business_event|outbox|capacity_units|simulation|approved_business_action|business_currency_declarations|default_currency/i);
    expect(new Set([...code.matchAll(/(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]))).toEqual(new Set(['platform.inventory_items', 'business_operations.inventory_balances', 'business_operations.inventory_movements']));
    expect((code.match(/withTenantTransaction\(/g) ?? []).length).toBe(1);
    expect((code.match(/client\.query</g) ?? []).length).toBe(1);
  });

  it('the evaluator cannot mutate inventory, issue a package, execute, emit an event or produce ExecutionEvidence', () => {
    for (const f of evaluatorFiles) {
      expect(f.code, f.rel).not.toMatch(/OperationalCommandExecutor|executeOn\(|ExecutionEvidence|ACTION_AUTHORIZED|emit_outbox_event|business_event_ledger|outbox_events|CanonicalEventPublisher|sealAuthorizedActionPackage|AuthorizedActionPackageIssuer|\bINSERT\b|\bUPDATE\b|\bDELETE\b|inventory_balances|inventory_movements/);
    }
  });

  it('invents no capacity, FX or Simulation substitute and reads no default currency', () => {
    for (const f of [...evaluatorFiles, { rel: FACTS, code: read(FACTS) }]) {
      expect(f.code, f.rel).not.toMatch(/capacity_units|capacityUnits|exchangeRate|fxRate|convertCurrency|\bsimulation\b|Simulation(?!Not)|default_currency|defaultCurrency|business_profile_extensions|tenancy\.tenants/i);
    }
  });

  it('evaluates only inventory_reorder_policy_update@1, only the four authorized dimensions, and never REVERSIBILITY', () => {
    expect(read(EVALUATE)).toMatch(/code: 'inventory_reorder_policy_update', schemaVersion: '1'/);
    expect(read(EVALUATE)).toMatch(/\['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'\] as const/);
    for (const f of evaluatorFiles) expect(f.code, f.rel).not.toMatch(/REVERSIBILITY/);
  });

  it('the evaluator service accepts no caller-supplied result, time, thresholds or digest (closed request key set)', () => {
    expect(read(SERVICE)).toMatch(/const REQUEST_KEYS = \['businessId', 'actionType', 'target', 'finalParameters', 'ruleSetVersion', 'correlationId'\] as const/);
    expect(read(SERVICE)).toMatch(/computeGovernanceSubjectDigest\(/);
    expect(read(SERVICE)).not.toMatch(/request\.(result|evaluatedAt|thresholds|subjectDigest|findings|inputs)\b/);
  });

  it('the production capability registry is exactly the P0-6e entry and nothing wires the evaluator into intake, routes or execution (P0-6 stays disabled)', () => {
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
    for (const f of production.filter((p) => p.rel.startsWith('packages/business-operations-runtime/src/authorized-action/') || (p.rel.startsWith('apps/api/src/') && p.rel !== ROUTE && p.rel !== 'apps/api/src/app.ts'))) {
      expect(f.code, f.rel).not.toMatch(/InventoryPolicyEvaluationService|inventory-policy\//);
    }
    // Data-capture Block E (O-10) is authorized: exactly the BO executor and the BO command types may carry the configure command / state; nothing else.
    expect(production.filter((f) => /configure_inventory_reorder_policy|reorder_policy_state/.test(f.code)).map((f) => f.rel).sort()).toEqual(['packages/business-operations-runtime/src/OperationalCommandExecutor.ts', 'packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts', 'packages/business-operations-runtime/src/inventory/InventoryReorderPolicyService.ts', 'packages/business-operations-runtime/src/types.ts']  /* AC-2 (D2): the BO first-policy service carries the command literal */);
  });

  it('B2c is wired only at the composition root and the BO route; B2d is not implemented', () => {
    expect(production.filter((f) => /BoGovernanceEvidenceVerifier/.test(f.code)).map((f) => f.rel).sort()).toEqual([
      'apps/api/src/app.ts', `${DIR}BoGovernanceEvidenceVerifier.ts`, `${DIR}index.ts`,
    ].sort());
    expect(production.filter((f) => /InventoryPolicyEvaluationService/.test(f.code) && f.rel.startsWith('apps/')).map((f) => f.rel)).toEqual([ROUTE]);
  });
});
