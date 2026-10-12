/**
 * P0-6a architecture guard (no database): the ABA ports are UNWIRED, BO depends on port types only, ABA never executes or writes BO state,
 * the issuer and the provider share one authority rule, and the package/ledger/registry surfaces are untouched.
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
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const PORTS = 'packages/workflow/src/abaExecutionPorts.ts';
const AUTH = 'packages/workflow/src/executionAuthority.ts';
const POLICY = 'packages/workflow/src/packageIssuancePolicy.ts';
const CLASSES = /\b(AbaPackageStatusProvider|AbaAuthorizedActionPackageSource|AbaPackageConsumptionRecorder)\b/;

describe('P0-6a architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(read(PORTS).length).toBeGreaterThan(1000);
    expect(read(AUTH).length).toBeGreaterThan(500);
  });

  it('the ABA port implementations are wired only in composition roots: the event worker (P0-6b) and, for the status provider alone, the API operator recovery root (P0-6h)', () => {
    const users = production.filter((f) => CLASSES.test(f.code)).map((f) => f.rel).sort();
    // P0-6b wires them in exactly one place: the event worker's composition root. No app, route or BO code names them.
    expect(users).toEqual(['apps/api/src/claimRecoveryComposition.ts', 'packages/event-worker/src/compose.ts', 'packages/workflow/src/abaExecutionPorts.ts', 'packages/workflow/src/index.ts']);
    const importers = production.filter((f) => !f.rel.startsWith('packages/workflow/') && !f.rel.startsWith('packages/event-worker/') && /AbaPackageStatusProvider|AbaPackageConsumptionRecorder|AbaAuthorizedActionPackageSource/.test(f.code));
    // P0-6h: the interim operator recovery control joins ONLY the status provider to the engine, in the API composition root (no route, no BO code).
    expect(importers.map((f) => f.rel)).toEqual(['apps/api/src/claimRecoveryComposition.ts']);
    expect(importers[0].code).not.toMatch(/AbaPackageConsumptionRecorder|AbaAuthorizedActionPackageSource/);
  });

  it('Business Operations imports only shared port types: no workflow package, no ABA repository, no ABA table', () => {
    const bo = production.filter((f) => f.rel.startsWith('packages/business-operations-runtime/src/'));
    expect(bo.length).toBeGreaterThan(20);
    expect(bo.filter((f) => /@infinicus\/workflow|approved_business_action|AuthorizedActionPackageRepository|Aba[A-Z]\w+(Provider|Source|Recorder)/.test(f.code))).toEqual([]);
  });

  it('the ABA ports write no BO state, execute nothing and emit no event', () => {
    const code = read(PORTS) + read(AUTH);
    expect(code).not.toMatch(/business_operations\.|OperationalCommandExecutor|inventory_balances|inventory_movements|emit_|outbox|event_ledger|businessEvents/i);
    expect(code).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it('the only ABA write the ports perform is the CONSUMED mirror, through the repository (never raw SQL in the ports file)', () => {
    expect(read(PORTS)).toContain('recordConsumed(');
    expect(read(PORTS)).not.toMatch(/\.query\(/);
    const repo = read('packages/database/src/repositories/approved_action/AuthorizedActionPackageRepository.ts');
    const consumedInserts = repo.match(/'CONSUMED'/g) ?? [];
    expect(consumedInserts.length).toBeGreaterThan(0);
    expect(repo).not.toMatch(/UPDATE\s+\$\{(EVENTS|VERSIONS|HEADERS)\}|DELETE\s+FROM\s+\$\{(EVENTS|VERSIONS|HEADERS)\}/);
  });

  it('one authority rule: the issuer policy and the provider both use executionAuthority.ts and neither re-implements it', () => {
    expect(read(POLICY)).toContain('evaluateApproverAuthority');
    expect(read(POLICY)).toContain('policyCoversActionType');
    expect(read(PORTS)).toContain('evaluateExecutionAuthority');
    expect(read(PORTS)).toContain('policyCoversActionType');
    expect(read(PORTS)).not.toMatch(/provenance|versionAtDecision|\.action === 'revoke'/);
    expect(read(POLICY)).not.toMatch(/\.action === 'grant'|\.action === 'revoke'|provenance\.filter/);
  });

  it('the provider never trusts a caller: it is built with an explicit ABA actor and answers only for the exact scope and digest', () => {
    const code = read(PORTS);
    expect(code).toContain('requireActor');
    expect(code).toContain('inScope(');
    expect(code).toMatch(/record\.digest === digest/);
  });

  it('ABA names no activation or execution event; the capability registry is BO-owned (exactly the P0-6e entry) (P0-6b adds only the authorized notification)', () => {
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES[^=]*=\s*Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
    // P0-6d added the BO -> OM executed event; Approved Business Action must still never see it.
    expect(production.filter((f) => (f.rel.startsWith('packages/workflow/') || f.rel.startsWith('layers/approved-business-action/')) && /operations\.action\.executed|ACTION_EXECUTED/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('legacy ABA blocks 17/19/20/21 stay unimported', () => {
    expect(production.filter((f) => !f.rel.startsWith('layers/approved-business-action/') && /approved-business-action\/blocks/.test(f.code))).toEqual([]);
  });

  it('the additive contract fields are in the shared contract and consumed by the validator', () => {
    const types = read('packages/handoff-contracts/src/authorized-action-package/types.ts');
    const validator = read('packages/handoff-contracts/src/authorized-action-package/validator.ts');
    expect(types).toMatch(/consumptionReceiptId\?:\s*string \| null/);
    expect(validator).toContain('export function validateForExecutionAfterClaim');
    expect(validator).toMatch(/status\.consumptionReceiptId !== claimReceiptId/);
  });
});
