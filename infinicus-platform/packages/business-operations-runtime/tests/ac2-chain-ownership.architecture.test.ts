import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { learningEligibility } from '@infinicus/handoff-contracts';

/**
 * AC-2 Block 10 architecture guard (no database): every layer in the first-action evidence chain stays in its lane.
 * DAL -> BO -> BI/BDT -> ADI -> ABA -> BO -> OM -> CL. Scans production source only (tests excluded), comments stripped.
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
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const importsOf = (code: string): string[] => [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
const pkgDeps = (name: string): string[] => Object.keys(JSON.parse(readFileSync(join(PLATFORM, 'packages', name, 'package.json'), 'utf8')).dependencies ?? {});

/** Business Operations truth: its schema, the canonical inventory tables, and the only code that calls its protected functions. */
const BO_TRUTH = /business_operations\.|platform\.(inventory_items|warehouses)\b|@infinicus\/business-operations-runtime|OperationalCommandExecutor|InventoryReorderPolicyService|configure_inventory_reorder_policy|apply_inventory_reorder_policy/;
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+[a-z_."]+\s+SET|DELETE\s+FROM)\b/i;
const BO_RUNTIME = 'packages/business-operations-runtime/src/';

const ABA_FILES = [
  'AbaAuthoringService.ts',
  'AuthorizedActionPackageIssuer.ts',
  'ActionAuthorizedAnnouncer.ts',
  'abaExecutionPorts.ts',
  'executionAuthority.ts',
  'approvalGate.ts',
  'approvalAudit.ts',
  'approvalRiskPolicy.ts',
  'packageIssuancePolicy.ts',
].map((f) => `packages/workflow/src/${f}`);
const ADI_FILES = ['ReorderPolicyRecommendationProducer.ts', 'ProposedActionSource.ts', 'AdiProposalBaselineSource.ts', 'recommendationAuthoring.ts'].map((f) => `packages/workflow/src/${f}`);
const BI_BDT_FILES = ['InventoryBiEvidenceService.ts', 'InventoryItemTwinService.ts', 'inventoryItemTwinState.ts', 'twinEvidence.ts', 'TwinComputationService.ts'].map((f) => `packages/workflow/src/${f}`);

describe('AC-2 Block 10: every layer in the first-action chain stays in its lane', () => {
  it('the scan sees the production tree and every file named by this guard exists', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [...ABA_FILES, ...ADI_FILES, ...BI_BDT_FILES]) expect(read(rel).length, rel).toBeGreaterThan(0);
  });

  it('DAL cannot authorize or execute: it references no ABA, ADI, execution, BO or OM code or table, and imports no downstream package', () => {
    const dal = under('packages/data-acquisition-runtime/src/');
    expect(dal.length).toBeGreaterThan(5);
    for (const f of dal) {
      expect(f.code, f.rel).not.toMatch(BO_TRUTH);
      expect(f.code, f.rel).not.toMatch(/AuthorizedAction|approved_business_action\.|ai_decision_intelligence\.|outcome_monitoring\.|ExecutionEvidence|operations\.action\.executed|ApprovalGate|AbaAuthoring/);
      for (const i of importsOf(f.code)) expect(i, f.rel).not.toMatch(/^@infinicus\/(workflow|outcome-monitoring-runtime|business-operations-runtime|simulation-engine|llm-client)$/);
    }
    expect(pkgDeps('data-acquisition-runtime')).not.toEqual(expect.arrayContaining(['@infinicus/workflow']));
    expect(pkgDeps('data-acquisition-runtime')).not.toEqual(expect.arrayContaining(['@infinicus/business-operations-runtime']));
  });

  it('BI cannot mutate BO: the BI evidence service has no BO table, executor, policy service or raw SQL write, and imports only crypto and the database package', () => {
    const code = read('packages/workflow/src/InventoryBiEvidenceService.ts');
    expect(code).not.toMatch(BO_TRUTH);
    expect(code).not.toMatch(SQL_WRITE);
    expect(importsOf(code).sort()).toEqual(['@infinicus/database', 'node:crypto']);
    // the package that hosts BI/BDT/ADI never depends on the BO runtime: BO facts reach it only through a port joined at the API composition root
    expect(pkgDeps('workflow')).not.toContain('@infinicus/business-operations-runtime');
  });

  it('BDT cannot become a second BO source of truth: the twin derives from BI evidence only, writes no BO or canonical table, and BO never reads the twin', () => {
    for (const rel of ['packages/workflow/src/InventoryItemTwinService.ts', 'packages/workflow/src/inventoryItemTwinState.ts']) {
      const code = read(rel);
      expect(code, rel).not.toMatch(BO_TRUTH);
      expect(code, rel).not.toMatch(SQL_WRITE);
      expect(code, rel).not.toMatch(/inventory_balances|inventory_movements|reorder_policy_state/);
    }
    expect(importsOf(read('packages/workflow/src/InventoryItemTwinService.ts')).sort()).toEqual(['./InventoryBiEvidenceService.js', './inventoryItemTwinState.js', '@infinicus/database', 'node:crypto']);
    for (const f of under(BO_RUNTIME)) expect(f.code, f.rel).not.toMatch(/InventoryItemTwin|inventory-item-twin|inventory_item_state|digital_twin|TwinComputationService/);
  });

  it('ADI cannot write BO: the recommendation sources have no BO table, executor, protected function or SQL write, and the workflow package has no BO dependency', () => {
    for (const rel of ADI_FILES) {
      const code = read(rel);
      expect(code, rel).not.toMatch(BO_TRUTH);
      expect(code, rel).not.toMatch(SQL_WRITE);
    }
    expect(importsOf(read('packages/workflow/src/ReorderPolicyRecommendationProducer.ts')).sort()).toEqual(['./InventoryItemTwinService.js', './recommendationAuthoring.js', '@infinicus/database', '@infinicus/handoff-contracts', 'node:crypto']);
  });

  it('ADI cannot bypass ABA: no ADI source builds a package, imports the issuer or authoring service, or touches an ABA table; only the ABA files use the package repositories', () => {
    for (const rel of ADI_FILES) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/AuthorizedActionPackage(?!V1\b)|AbaAuthoringService|approved_business_action\.|sealPackage|issuePackage|ActionAuthorized/);
    }
    const producer = read('packages/workflow/src/ReorderPolicyRecommendationProducer.ts');
    expect(producer).not.toMatch(/ApprovalGate|approvalGate|ApprovalRepository|ApprovalDecision|approveRecommendation|recordApproval/);
    // only ABA files (and the database package that owns them) reference the package repositories; nothing in a recommendation path does
    const consumers = filesMatching(/AuthorizedActionPackageRepository/).filter((r) => !r.startsWith('packages/database/'));
    expect(consumers).toEqual(['packages/workflow/src/AbaAuthoringService.ts', 'packages/workflow/src/AuthorizedActionPackageIssuer.ts', 'packages/workflow/src/abaExecutionPorts.ts']);
    // capture requires a structured proposal that the ADI source itself validated
    expect(read('packages/workflow/src/ProposedActionSource.ts')).toMatch(/validateProposedActionRecommendation/);
    expect(read('packages/workflow/src/AbaAuthoringService.ts')).toMatch(/ADI_PROPOSAL_REQUIRED/);
  });

  it('ABA cannot execute: the ABA sources import no BO runtime, executor or protected function, and write no BO table; the BO adapter consumes only the sealed package', () => {
    for (const rel of ABA_FILES) {
      const code = read(rel);
      expect(code, rel).not.toMatch(BO_TRUTH);
      expect(code, rel).not.toMatch(/OperationalCommandExecutor|configureInitial|InventoryReorderPolicyExecutionAdapter|execution_evidence|ExecutionEvidence\b.*(insert|record)/i);
    }
    const adapter = read('packages/business-operations-runtime/src/authorized-action-execution/InventoryReorderPolicyExecutionAdapter.ts');
    expect(adapter.length).toBeGreaterThan(0);
    expect(importsOf(adapter).every((i) => !/workflow|AbaAuthoring/.test(i))).toBe(true);
    // the only place the executor is constructed with an execution adapter is on the BO side
    expect(filesMatching(/new InventoryReorderPolicyExecutionAdapter\(/).every((r) => r.startsWith(BO_RUNTIME) || r.startsWith('apps/api/src/') || r.startsWith('packages/event-worker/src/'))).toBe(true);
  });

  it('BO remains the sole operational writer: canonical inventory, balance and protected reorder writes exist only in the BO runtime and its own database repository', () => {
    expect(filesMatching(/INSERT\s+INTO\s+platform\.(inventory_items|warehouses)\b/i)).toEqual([`${BO_RUNTIME}OperationalCommandExecutor.ts`]);
    expect(filesMatching(/INSERT\s+INTO\s+business_operations\.inventory_movements\b/i)).toEqual([`${BO_RUNTIME}OperationalCommandExecutor.ts`]);
    expect(filesMatching(/(INSERT\s+INTO|UPDATE)\s+business_operations\.inventory_balances\b/i)).toEqual([`${BO_RUNTIME}OperationalCommandExecutor.ts`, 'packages/database/src/repositories/bo/InventoryBalanceRepository.ts'].sort());
    const protectedCallers = filesMatching(/configure_inventory_reorder_policy|apply_inventory_reorder_policy/);
    expect(protectedCallers.every((r) => r.startsWith(BO_RUNTIME))).toBe(true);
    expect(protectedCallers.length).toBeGreaterThan(0);
    // no non-BO runtime writes any business_operations table directly (repositories in the database package are BO-owned and listed by the Block 4 guard)
    for (const layer of ['packages/workflow/', 'packages/outcome-monitoring-runtime/', 'packages/data-acquisition-runtime/', 'layers/']) {
      for (const f of under(layer)) expect(f.code, f.rel).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(business_operations|platform\.(inventory_items|warehouses))\b/i);
    }
  });

  it('OM cannot mutate BO: the outcome-monitoring runtime has no BO table, executor, protected function or SQL write, and no BO dependency', () => {
    const om = under('packages/outcome-monitoring-runtime/src/');
    expect(om.length).toBeGreaterThan(3);
    for (const f of om) {
      expect(f.code, f.rel).not.toMatch(BO_TRUTH);
      expect(f.code, f.rel).not.toMatch(SQL_WRITE);
      for (const i of importsOf(f.code)) expect(i, f.rel).toMatch(/^(\.\/|node:crypto$|@infinicus\/(database|event-contracts|handoff-contracts)$)/);
    }
    expect(pkgDeps('outcome-monitoring-runtime').sort()).toEqual(['@infinicus/database', '@infinicus/event-contracts', '@infinicus/handoff-contracts']);
  });

  it('OM import guard accepts Node crypto but still rejects unauthorized runtime packages', () => {
    const allowed = /^(\.\/|node:crypto$|@infinicus\/(database|event-contracts|handoff-contracts)$)/;
    for (const spec of ['node:crypto', './LearningReleaseBoundary.js', '@infinicus/database', '@infinicus/event-contracts', '@infinicus/handoff-contracts']) {
      expect(spec, spec).toMatch(allowed);
    }
    for (const spec of ['node:fs', '@infinicus/workflow', '@infinicus/business-operations-runtime', '@infinicus/database/private']) {
      expect(spec, spec).not.toMatch(allowed);
    }
  });

  it('CL cannot consume OUTCOME_PENDING: the gate refuses every pending or inconclusive outcome, CL code never reads execution verifications, and the table admits only pending or inconclusive', () => {
    const states = ['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE', 'OUTCOME_OBSERVED', 'OUTCOME_FAILED'];
    for (const outcomeState of states) {
      const r = learningEligibility({ executionState: 'EXECUTION_VERIFIED', outcomeState, executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED' } as never);
      expect(r.eligible, outcomeState).toBe(false);
      expect(r.reasons.join(' ').includes(outcomeState), outcomeState).toBe(true);
    }
    expect(learningEligibility({ executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED' } as never).eligible).toBe(true);
    const clCode = [...under('layers/continuous-learning/'), ...under('packages/database/src/repositories/cl/')];
    expect(clCode.length).toBeGreaterThan(5);
    for (const f of clCode) expect(f.code, f.rel).not.toMatch(/action_execution_verifications|ActionExecutionVerification|OUTCOME_PENDING|OUTCOME_INCONCLUSIVE/);
    // the only readers of execution verifications are the OM repositories (verification store; OM-OBS-1 read-only health view) and OM runtime
    expect(filesMatching(/action_execution_verifications/).filter((r) => !r.startsWith('packages/outcome-monitoring-runtime/'))).toEqual([
      'packages/database/src/repositories/om/ActionExecutionVerificationRepository.ts', 'packages/database/src/repositories/om/OutcomeMonitoringHealthRepository.ts',
    ]);
    const migration = readFileSync(join(PLATFORM, 'infrastructure/database/migrations/0194_create_om_action_execution_verifications.sql'), 'utf8');
    expect(migration).toMatch(/outcome_state\s+text\s+NOT NULL\s+CHECK\s*\(\s*outcome_state\s+IN\s*\(\s*'OUTCOME_PENDING'\s*,\s*'OUTCOME_INCONCLUSIVE'\s*\)\s*\)/);
  });
});
