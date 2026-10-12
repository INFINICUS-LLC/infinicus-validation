/**
 * P0-6d architecture guard (no database): BO -> DATA -> OM -> CL.
 * BO is the only author of execution evidence and its only publisher; OM is the only consumer and writes only its own table; no Continuous
 * Learning code can see a BO execution, an event or an unverified verification; learning eligibility has one definition and fails closed.
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
const sql = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const OM_RT = 'packages/outcome-monitoring-runtime/src/';
const OM_REPO = 'packages/database/src/repositories/om/ActionExecutionVerificationRepository.ts';
const BO_EXEC = 'packages/business-operations-runtime/src/authorized-action-execution/';
const M0193 = 'infrastructure/database/migrations/0193_align_execution_mutation_result_vocabulary.sql';
const M0194 = 'infrastructure/database/migrations/0194_create_om_action_execution_verifications.sql';

describe('P0-6d architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    expect(under(OM_RT).length).toBeGreaterThanOrEqual(5);
    for (const rel of [OM_REPO, `${BO_EXEC}ExecutionEventPublisher.ts`, `${BO_EXEC}BoExecutionEvidenceReader.ts`]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('OM runtime depends only on shared contracts and the database package: no BO, ABA, DAL or workflow package, no BO table', () => {
    for (const f of under(OM_RT)) {
      const imports = [...f.code.matchAll(/from '(@infinicus\/[^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(['@infinicus/database', '@infinicus/event-contracts', '@infinicus/handoff-contracts'], `${f.rel} imports ${i}`).toContain(i);
      expect(f.code, f.rel).not.toMatch(/business_operations\.|approved_business_action\.|continuous_learning\./);
    }
    const repo = read(OM_REPO);
    expect(repo).not.toMatch(/business_operations|approved_business_action|continuous_learning/);
    expect(repo).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/i); // append-only: the repository has no mutation of a verification
  });

  it('OM never reads a BO table: execution evidence reaches it only through the shared read port', () => {
    const svc = read(`${OM_RT}ExecutionVerificationService.ts`);
    expect(svc).toMatch(/ExecutionEvidenceReader/);
    expect(svc).not.toMatch(/AuthorizedActionExecutionRepository|BoExecutionEvidenceReader|OutboxRepository|enqueue/);
    // the BO side of the port is read-only
    expect(read(`${BO_EXEC}BoExecutionEvidenceReader.ts`)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|recordAudit|enqueue|\.publish\(/);
  });

  it('BO is the only producer of operations.action.executed@1 and OM the only consumer', () => {
    const emitters = production.filter((f) => /buildActionExecutedEvent\(|actionExecutedEventId\(/.test(f.code) && !f.rel.startsWith('packages/event-contracts/')).map((f) => f.rel).sort();
    expect(emitters).toEqual([`${BO_EXEC}ExecutionEventPublisher.ts`]);
    const consumers = production.filter((f) => /ACTION_EXECUTED_CONSUMER|ActionExecutedConsumer/.test(f.code) && !f.rel.startsWith('packages/event-contracts/')).map((f) => f.rel).sort();
    expect(consumers).toEqual([`${BO_EXEC}ExecutionEventPublisher.ts`, `${BO_EXEC}eventContract.ts`, `${OM_RT}ActionExecutedConsumer.ts`, `${OM_RT}index.ts`, 'packages/event-worker/src/compose.ts'].sort());
  });

  it('the event is published only on the engine\'s own transaction client, in the terminal step', () => {
    const svc = read(`${BO_EXEC}AuthorizedActionExecutionService.ts`);
    expect(svc.match(/this\.publisher\.publish\(/g)).toHaveLength(1);
    expect(svc).not.toMatch(/OutboxRepository|enqueue\(/);
    expect(read(`${BO_EXEC}ExecutionEventPublisher.ts`)).toMatch(/enqueueIfAbsentOnClient\(client,/);
    expect(read(`${BO_EXEC}ExecutionEventPublisher.ts`)).not.toMatch(/withTenantTransaction|withTransaction|\.enqueue\(/); // never its own transaction
  });

  it('BO code never names an outcome state, an OM table or Continuous Learning', () => {
    for (const f of under(BO_EXEC)) {
      expect(f.code, f.rel).not.toMatch(/OUTCOME_(PENDING|OBSERVED|VERIFIED|INCONCLUSIVE|FAILED)|outcome_monitoring|action_execution_verifications|continuous_learning|learningEligibility/);
    }
  });

  it('no Continuous Learning code (repositories or layer) can see executions, the executed event or OM verifications', () => {
    const cl = [...under('packages/database/src/repositories/cl/'), ...under('layers/continuous-learning/')];
    expect(cl.length).toBeGreaterThan(3);
    for (const f of cl) {
      expect(f.code, f.rel).not.toMatch(/authorized_action_executions|execution-evidence|ExecutionEvidence|operations\.action\.executed|ACTION_EXECUTED|action_execution_verifications|ActionExecutionVerification|business_operations\./);
    }
  });

  it('learning eligibility has a single definition and no production caller yet (nothing learns from execution)', () => {
    const defs = production.filter((f) => /function learningEligibility\b/.test(f.code)).map((f) => f.rel);
    expect(defs).toEqual(['packages/handoff-contracts/src/execution-evidence/states.ts']);
    const users = production.filter((f) => /learningEligibility\(/.test(f.code) && f.rel !== defs[0]).map((f) => f.rel);
    expect(users).toEqual([]);
    expect(read(defs[0])).toMatch(/executionState !== 'EXECUTION_VERIFIED'[\s\S]*outcomeState !== 'OUTCOME_VERIFIED'[\s\S]*'SUCCEEDED'[\s\S]*'APPLIED'/);
  });

  it('only PENDING / INCONCLUSIVE are assignable by code and by the database', () => {
    expect(read('packages/handoff-contracts/src/execution-evidence/states.ts')).toMatch(/INITIAL_OUTCOME_STATES = \['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE'\]/);
    const m = sql(M0194);
    expect(m).toMatch(/outcome_state\s+IN\s*\(\s*'OUTCOME_PENDING'\s*,\s*'OUTCOME_INCONCLUSIVE'\s*\)/);
    expect(m).toMatch(/execution_state\s*=\s*'EXECUTION_VERIFIED'/);
    for (const rel of under(OM_RT).map((f) => f.rel)) expect(read(rel), rel).not.toMatch(/'OUTCOME_(OBSERVED|VERIFIED|FAILED)'/);
  });

  it('migrations 0193 and 0194 are idempotent, self-registered, and grant or alter no role', () => {
    for (const [rel, name] of [[M0193, '0193_align_execution_mutation_result_vocabulary.sql'], [M0194, '0194_create_om_action_execution_verifications.sql']] as const) {
      const m = sql(rel);
      expect(m, rel).toContain(`INSERT INTO _migrations (filename) VALUES ('${name}')`);
      expect(m, rel).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
      expect(m, rel).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE\s+ROLE|ALTER\s+ROLE/i);
    }
    expect(sql(M0194)).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('nothing is activated by default: the registry is exactly the P0-6e entry and no worker/gate default is opened', () => {
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
    expect(read('packages/event-worker/src/compose.ts')).toMatch(/options\.gate \?\? new GovernedExecutionGate\(/);
    const wiring = production.filter((f) => /AuthorizedActionExecutionService/.test(f.code)).map((f) => f.rel).sort();
    // P0-6e wiring: the engine's only other references are the BO notification consumer (the one trigger) and the worker composition root.
    expect(wiring).toEqual([`${BO_EXEC}AuthorizedActionExecutionService.ts`, 'packages/business-operations-runtime/src/index.ts', 'packages/business-operations-runtime/src/authorized-action/AuthorizedActionNotificationConsumer.ts', 'packages/event-worker/src/compose.ts',
      // P0-6g / P0-6h (owner-approved): the claim recovery consumer (driven only by the claim's own durable signal), the interim operator control and its API composition root.
      'packages/business-operations-runtime/src/authorized-action/ClaimRecoveryConsumer.ts', 'packages/business-operations-runtime/src/authorized-action/ClaimRecoveryOperatorService.ts', 'apps/api/src/claimRecoveryComposition.ts'].sort());
  });
});
