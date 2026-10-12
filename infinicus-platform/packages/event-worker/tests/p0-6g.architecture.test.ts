/**
 * P0-6g architecture guard (no database): stranded-claim recovery is a durable internal signal for an EXISTING claim, nothing more.
 *
 *   No global scanner and no new cross-tenant read or grant | one executor (the engine) | a recovery signal can create no claim | a terminal claim is
 *   never re-driven | no second retry policy, timer or queue | activation requires the recovery subscription | the signal is internal to BO.
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
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();

const BO = 'packages/business-operations-runtime/src/';
const SCHEDULER = `${BO}authorized-action/ClaimRecoveryScheduler.ts`;
const CONSUMER = `${BO}authorized-action/ClaimRecoveryConsumer.ts`;
const OPERATOR = `${BO}authorized-action/ClaimRecoveryOperatorService.ts`;
const INTAKE = `${BO}authorized-action/AuthorizedActionIntakeService.ts`;
const INTAKE_REPO = 'packages/database/src/repositories/bo/AuthorizedActionIntakeRepository.ts';
const ENGINE = `${BO}authorized-action-execution/AuthorizedActionExecutionService.ts`;
const CONTRACT = 'packages/event-contracts/src/authorized-action-recovery.ts';
const SUBS = 'packages/event-contracts/src/execution-pipeline-subscriptions.ts';
const COMPOSE = 'packages/event-worker/src/compose.ts';
const DISCOVERY = 'packages/event-worker/src/ScopeDiscovery.ts';
const RECOVERY_FILES = [SCHEDULER, CONSUMER, CONTRACT];

describe('P0-6g architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [SCHEDULER, CONSUMER, INTAKE, INTAKE_REPO, ENGINE, CONTRACT, SUBS, COMPOSE, DISCOVERY]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('NO global scanner and NO new cross-tenant read: discovery is still the one outbox-only scope reader, the engine runDue/claimsAwaitingExecution have no caller, and no migration was added', () => {
    expect(filesMatching(/implements ScopeDiscovery/)).toEqual([DISCOVERY]);
    expect(read(DISCOVERY)).toMatch(/FROM events\.outbox_events/);
    expect(read(DISCOVERY)).not.toMatch(/authorized_action_claims|authorized_action_executions|business_operations\./);
    expect(filesMatching(/\.runDue\(/)).toEqual([OPERATOR]); // only the interim operator control (P0-6h); no scanner and no worker caller
    expect(filesMatching(/\.claimsAwaitingExecution\(/)).toEqual([ENGINE]); // only the engine's own (unreferenced) runDue
    for (const rel of RECOVERY_FILES) expect(read(rel), rel).not.toMatch(/FROM business_operations\.|SELECT[^;]*authorized_action_claims|GRANT |CREATE POLICY|SECURITY DEFINER|pg_advisory/i);
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(migrations[migrations.length - 1]).toMatch(/^0195_/); // P0-6g adds the signal to the EXISTING outbox: no schema, role or grant change
  });

  it('ONE executor: no second engine, no direct inventory write, and the recovery files never touch an inventory or execution table', () => {
    expect(filesMatching(/new AuthorizedActionExecutionService\(/).sort()).toEqual(['apps/api/src/claimRecoveryComposition.ts', COMPOSE].sort());
    expect(filesMatching(/\.executeClaim\(/).filter((rel) => rel !== ENGINE).sort()).toEqual([`${BO}authorized-action/AuthorizedActionNotificationConsumer.ts`, CONSUMER].sort());
    for (const rel of [SCHEDULER, CONSUMER]) {
      expect(read(rel), rel).not.toMatch(/inventory_|InventoryReorderPolicyExecutionAdapter|OperationalCommandExecutor|authorized_action_executions|insertExecution|sealExecutionEvidence|UPDATE |DELETE FROM/);
    }
    expect(read(CONSUMER)).toMatch(/this\.deps\.executor\.executeClaim\(/);
  });

  it('a recovery signal can NEVER create a claim: neither recovery file can intake, receive or insert one, and only the intake repository writes a claim', () => {
    for (const rel of [SCHEDULER, CONSUMER, CONTRACT]) {
      expect(read(rel), rel).not.toMatch(/AuthorizedActionIntakeService|AuthorizedActionIntakeRepository|\.intake\(|receiveAndClaim|INSERT INTO|AuthorizedActionPackageSource|AuthoritativePackageStatusProvider|PackageConsumptionRecorder/);
    }
    expect(filesMatching(/INSERT INTO \$\{S\}\.authorized_action_claims|INSERT INTO business_operations\.authorized_action_claims/)).toEqual([INTAKE_REPO]);
    expect(filesMatching(/receiveAndClaim\(/).filter((rel) => rel.startsWith('packages/business-operations-runtime/src/') || rel.startsWith('apps/') || rel.startsWith('packages/event-worker/'))).toEqual([INTAKE]);
    // the intake repository stays free of any event machinery: it only offers the generic in-transaction hook
    expect(read(INTAKE_REPO)).not.toMatch(/outbox|OutboxRepository|business_event|EventLedger|CanonicalEventPublisher/i);
  });

  it('the signal is written ONLY with the claim: the scheduler runs inside the claim hook, on the claim client, and is wired nowhere else', () => {
    expect(read(INTAKE_REPO)).toMatch(/if \(request\.onClaimed\) await request\.onClaimed\(client,/);
    expect(read(INTAKE)).toMatch(/onClaimed: async \(client, claim\) => \{\s*await this\.recovery\.schedule\(client, ctx,/);
    expect(filesMatching(/\.schedule\(/).filter((rel) => rel.startsWith('packages/') || rel.startsWith('apps/')).sort()).toEqual([INTAKE]);
    expect(read(SCHEDULER)).toMatch(/enqueueIfAbsentOnClient\(client, ctx,/);
    expect(read(SCHEDULER)).not.toMatch(/\.enqueue\(|withTenantTransaction/); // never its own transaction: it commits or rolls back with the claim
    expect(filesMatching(/new OutboxClaimRecoveryScheduler\(/)).toEqual([INTAKE]);
  });

  it('a TERMINAL claim is never re-driven: the consumer returns on a terminal outcome BEFORE the gate, the inbox and the engine; the engine replays a stored outcome', () => {
    const c = read(CONSUMER);
    const terminal = c.indexOf('claim.terminalOutcome !== null');
    expect(terminal).toBeGreaterThan(-1);
    expect(terminal).toBeLessThan(c.indexOf('this.deps.gate.isEnabled('));
    expect(terminal).toBeLessThan(c.indexOf('this.inbox.beginProcessing('));
    expect(terminal).toBeLessThan(c.indexOf('executor.executeClaim('));
    expect(c.slice(terminal, terminal + 120)).toMatch(/return;/);
    expect(read(ENGINE)).toMatch(/if \(existing\) return \{ state: 'TERMINAL', execution: existing, replayed: true \}/);
  });

  it('the consumer resolves the claim in its OWN scope and refuses a mismatching, foreign or missing claim non-retryably; a closed or throwing gate recovers nothing', () => {
    const c = read(CONSUMER);
    expect(c).toMatch(/event\.tenantId !== ctx\.tenantId \|\| event\.workspaceId !== ctx\.workspaceId/);
    expect(c).toMatch(/this\.claims\.getClaimState\(ctx, payload\.claimId\)/);
    for (const code of ['SCOPE_MISMATCH', 'CLAIM_NOT_FOUND', 'CLAIM_MISMATCH', 'CAPABILITY_DISABLED', 'PAYLOAD_INVALID']) expect(c).toMatch(new RegExp(`DeliveryError\\('${code}'[^)]*false\\)`));
    expect(c).toMatch(/\.then\(\(v\) => v === true, \(\) => false\)/);
  });

  it('NO second retry policy, timer or queue: recovery files hold no attempt/backoff constants, timers or literal thresholds; the due time is the ruled EXECUTION_CLAIM_RECOVERY_MS', () => {
    for (const rel of RECOVERY_FILES) {
      expect(read(rel), rel).not.toMatch(/maxAttempts|backoff|setTimeout|setInterval|node-cron|bullmq|amqplib|agenda|\b60_?000\b|EXECUTION_MAX_ATTEMPTS|EXECUTION_BACKOFF_MS/);
    }
    expect(read(SCHEDULER)).toMatch(/recoveryMs: number = EXECUTION_CLAIM_RECOVERY_MS/);
    expect(read(BO + 'authorized-action-execution/constants.ts')).toMatch(/EXECUTION_CLAIM_RECOVERY_MS = 60_000;/);
    // the redelivery policy is the SAME ruled one the other two subscriptions carry
    expect(read(SUBS)).toMatch(/destinationReference: AUTHORIZED_ACTION_RECOVERY_CONSUMER, supportedVersions: \[AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION\], retryPolicy,/);
  });

  it('activation is never ENABLED without the recovery subscription: it is part of the one list activation provisions and the gate verifies', () => {
    expect(read(SUBS)).toMatch(/subscriberName: `\$\{AUTHORIZED_ACTION_RECOVERY_CONSUMER\}@\$\{workspaceId\}`/);
    expect(read(`${BO}execution-activation/ExecutionActivationService.ts`)).toMatch(/executionPipelineSubscriptions\(ctx\.workspaceId\)/);
    expect(read(`${BO}execution-activation/GovernedExecutionGate.ts`)).toMatch(/executionPipelineSubscriptions\(scope\.workspaceId\)/);
  });

  it('the signal is INTERNAL to BO and delivered by the existing worker: single BO consumer, owner domain operations, registered and swept by the worker composition root only', () => {
    expect(read(CONTRACT)).toMatch(/supportedConsumers: Object\.freeze\(\[AUTHORIZED_ACTION_RECOVERY_CONSUMER\]\)/);
    expect(read(CONTRACT)).toMatch(/ownerDomain: 'operations' as const/);
    expect(read(COMPOSE)).toMatch(/registerAuthorizedActionRecoveryContract\(registry\)/);
    expect(read(COMPOSE)).toMatch(/const eventTypes = \[ACTION_AUTHORIZED_EVENT_TYPE, ACTION_EXECUTED_EVENT_TYPE, AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE\]/);
    expect(filesMatching(/AUTHORIZED_ACTION_RECOVERY_CONSUMER|ClaimRecoveryConsumer/).filter((rel) => rel.startsWith('packages/outcome-monitoring-runtime/') || rel.startsWith('layers/') || rel.startsWith('apps/') || rel.startsWith('packages/workflow/'))).toEqual([]);
  });

  it('the recovery payload is reference-only: no package body, authority, parameters or state can ride along (closed validator)', () => {
    const c = read(CONTRACT);
    expect(c).toMatch(/exactKeys\(value, \['claimId', 'packageId', 'packageVersion', 'digest', 'scope', 'actionType', 'claimedAt', 'dueAt'\]\)/);
    expect(c).not.toMatch(/parameters|reorderPoint|reorderQuantity|approver|authority:|document:/);
  });
});
