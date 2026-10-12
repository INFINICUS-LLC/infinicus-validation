/**
 * P0-6f architecture guard (no database): the execution path is closed end to end.
 *
 *   ABA announces authorization only (and is the ONLY announcer) | BO validates, claims and executes (and is the only executor) | DATA is the one
 *   outbox | OM verifies | CL learns nothing.  Activation never exists without valid delivery; no recovery scanner, scheduler or second retry exists.
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
const WF = 'packages/workflow/src/';
const APP = 'apps/api/src/app.ts';
const COMPOSITION = 'apps/api/src/abaPackageAnnouncement.ts';
const ANNOUNCER = `${WF}ActionAuthorizedAnnouncer.ts`;
const ISSUER = `${WF}AuthorizedActionPackageIssuer.ts`;
const SERVICE = `${BO}execution-activation/ExecutionActivationService.ts`;
const GATE = `${BO}execution-activation/GovernedExecutionGate.ts`;
const SUBS = 'packages/database/src/eventing/EventSubscriptionRepository.ts';

describe('P0-6f architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [APP, COMPOSITION, ANNOUNCER, ISSUER, SERVICE, GATE, SUBS]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('PRODUCTION COMPOSITION INCLUDES THE ABA ANNOUNCER: the API root gives the issuer an announcer whose gate is the GOVERNED gate, built per issuing context', () => {
    expect(read(APP)).toMatch(/issuer: buildAbaPackageIssuer\(options\.abaAnnouncement\)/);
    const c = read(COMPOSITION);
    expect(c).toMatch(/new ActionAuthorizedAnnouncer\(\{/);
    expect(c).toMatch(/gate: \(ctx\) => new GovernedExecutionGate\(\{ capabilities, killSwitchEngaged, actorUserId: ctx\.userId \}\)/);
    expect(c).toMatch(/new AuthorizedActionPackageIssuer\(\{ announcer \}\)/);
    expect(c).not.toMatch(/isEnabled: async \(\) => true|DENY_ALL|=> true/); // never a literal open gate
    expect(read(ISSUER)).not.toMatch(/new ActionAuthorizedAnnouncer|GovernedExecutionGate/); // the issuer itself is closed by default (no announcer)
  });

  it('ABA is the ONLY authorization announcer: one construction (the API root), one event builder user, one outbox write, reference-only payload', () => {
    expect(filesMatching(/new ActionAuthorizedAnnouncer\(/)).toEqual([COMPOSITION]);
    expect(filesMatching(/buildActionAuthorizedEvent\(/).filter((rel) => !rel.startsWith('packages/event-contracts/'))).toEqual([ANNOUNCER]);
    expect(read(ANNOUNCER)).toMatch(/enqueueIfAbsent\(/);
    // BO, OM, DAL and the worker never announce authorization
    for (const prefix of [BO, 'packages/outcome-monitoring-runtime/src/', 'packages/event-worker/src/', 'packages/data-acquisition-runtime/src/']) {
      expect(under(prefix).filter((f) => /ActionAuthorizedAnnouncer|buildActionAuthorizedEvent/.test(f.code)).map((f) => f.rel), prefix).toEqual([]);
    }
  });

  it('ABA announces authorization ONLY: ABA code never imports BO, executes, claims, or touches inventory; the announcement carries a reference and uses the one outbox', () => {
    for (const f of [...under(WF), ...under('layers/approved-business-action/')]) {
      expect(f.code, f.rel).not.toMatch(/@infinicus\/business-operations-runtime|AuthorizedActionExecutionService|executeClaim|GovernedExecutionGate|inventory_balances|reorder_point|authorized_action_(claims|receipts|executions)/);
    }
    const a = read(ANNOUNCER);
    expect(a).not.toMatch(/\bparameters\b|finalParameters|reorderPoint/); // the payload is built from named reference fields only
    expect(a).not.toMatch(/new OutboxRepository\(\)\.enqueue\(|INSERT INTO events/); // the existing outbox repository, not a second mechanism
    expect(filesMatching(/CREATE TABLE[^;]*outbox/i)).toEqual([]);
  });

  it('BO validates, claims and executes - and reads no ABA private table: BO code names no ABA schema table, only the shared ports', () => {
    for (const f of under(BO)) expect(f.code, f.rel).not.toMatch(/approved_business_action\.|FROM approved_business_action|AuthorizedActionPackageRepository|AbaPackageStatusProvider/);
    expect(filesMatching(/\.executeClaim\(/).filter((rel) => rel !== `${BO}authorized-action-execution/AuthorizedActionExecutionService.ts`).sort()).toEqual([`${BO}authorized-action/AuthorizedActionNotificationConsumer.ts`, `${BO}authorized-action/ClaimRecoveryConsumer.ts`].sort()); // one executor; the claim recovery consumer (P0-6g) is its only other driver
  });

  it('an announcement is not execution and a subscription is not activation: the gate needs the activation record AND valid subscriptions AND the registry AND no kill switch', () => {
    const g = read(GATE);
    expect(g).toMatch(/activations\.isEnabled\(/);
    expect(g).toMatch(/subscriptions\.verify\(/);
    expect(g).toMatch(/capabilities\.supports\(/);
    expect(g).toMatch(/killSwitchEngaged\(\) !== false\) return false/);
    expect(g).not.toMatch(/return true;/);
    // the subscription repository can never create an activation, and the activation repository never creates a subscription
    expect(read(SUBS)).not.toMatch(/execution_capability_activations/);
    expect(read('packages/database/src/repositories/bo/ExecutionCapabilityActivationRepository.ts')).not.toMatch(/event_subscriptions/);
  });

  it('FAILED SUBSCRIPTION PROVISIONING CANNOT LEAVE EXECUTION OPEN: activation, provisioning and verification share ONE transaction, and every failure propagates (no swallow, no deferred repair)', () => {
    const s = read(SERVICE);
    const tx = s.indexOf('withTenantTransaction(ctx, async (client) =>');
    const record = s.indexOf('this.activations.recordOnClient(client');
    const ensure = s.indexOf('this.subscriptions.ensureOnClient(client');
    const verify = s.indexOf('this.subscriptions.verifyOnClient(client');
    expect(tx).toBeGreaterThan(-1);
    expect([record, ensure, verify].every((i) => i > tx)).toBe(true); // all inside the one transaction callback
    // migration 0196: the audit row is written by the governed database function in the SAME statement path as the row, never by a separate application call
    expect(s).not.toMatch(/recordAudit/);
    expect(readFileSync(join(PLATFORM, 'infrastructure/database/migrations/0196_harden_database_authority_activation_and_reorder.sql'), 'utf8')).toMatch(/INSERT INTO business_operations\.execution_capability_activations[\s\S]*INSERT INTO audit\.audit_events/);
    expect(s.match(/withTenantTransaction\(/g)).toHaveLength(1);              // never a second, separate transaction
    expect(s).toMatch(/verifyOnClient\(client, specs\)\) !== true\) throw new Error\('SUBSCRIPTION_UNVERIFIED'\)/);
    expect(s).not.toMatch(/\.catch\(\(\) => undefined\)|catch \{\s*\}/); // no swallowed failure
    expect(s).not.toMatch(/setImmediate|setTimeout|queueMicrotask|repair|reconcile/i); // nothing is "fixed later"
    // the subscription primitive refuses anything but exactly the pinned ACTIVE subscription
    expect(read(SUBS)).toMatch(/SUBSCRIPTION_INACTIVE/);
    expect(read(SUBS)).toMatch(/SUBSCRIPTION_CONFLICT/);
    expect(read(SUBS)).toMatch(/SUBSCRIPTION_NAME_TAKEN/);
  });

  it('no stranded-claim recovery service was invented: nothing drives runDue, the worker discovers scopes only from outbox rows, no new scheduler, queue, retry policy, outbox or migration', () => {
    expect(filesMatching(/\.runDue\(/)).toEqual([`${BO}authorized-action/ClaimRecoveryOperatorService.ts`]); // only the interim operator control (P0-6h)
    expect(read('packages/event-worker/src/ScopeDiscovery.ts')).toMatch(/FROM events\.outbox_events/);
    expect(read('packages/event-worker/src/ScopeDiscovery.ts')).not.toMatch(/authorized_action_claims|dead_letter/);
    expect(under('packages/event-worker/src/').filter((f) => /authorized_action_claims|claimsAwaitingExecution/.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(filesMatching(/bullmq|amqplib|node-cron|agenda|bee-queue/)).toEqual([]);
    expect(under(BO).filter((f) => /setInterval\(|EXECUTION_(MAX_ATTEMPTS|BACKOFF_MS)\s*=/.test(f.code)).map((f) => f.rel)).toEqual([`${BO}authorized-action-execution/constants.ts`]);
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((n) => n.endsWith('.sql')).sort();
    expect(migrations.slice(migrations.indexOf('0195_create_bo_execution_capability_activations.sql'), migrations.indexOf('0196_harden_database_authority_activation_and_reorder.sql') + 1)).toEqual(['0195_create_bo_execution_capability_activations.sql', '0196_harden_database_authority_activation_and_reorder.sql']); // P0-6f adds no migration; the only later one is the owner-authorized database-authority hardening (0196)
  });

  it('OM cannot write BO and CL learns nothing (unchanged by the announcer wiring)', () => {
    for (const f of under('packages/outcome-monitoring-runtime/src/')) expect(f.code, f.rel).not.toMatch(/business_operations\.|AuthorizedActionExecutionRepository|inventory_balances/);
    expect(filesMatching(/learningEligibility\(/).filter((rel) => rel !== 'packages/handoff-contracts/src/execution-evidence/states.ts')).toEqual([]);
  });

  it('the principal end-to-end proof exists and uses the production composition: no substituted package source, recorder or BO injection', () => {
    const e2e = readFileSync(join(PLATFORM, 'apps/api/tests/p0-6f-execution-path.e2e.test.ts'), 'utf8');
    expect(e2e).toMatch(/buildApp\(/);
    expect(e2e).toMatch(/kit\.authorChain\(\)/);
    expect(e2e).not.toMatch(/source:\s*\{|recorder:\s*\{|buildPackage\(|claimPackage\(|INSERT INTO business_operations\.authorized_action/); // only the status provider is ever wrapped, in one named test
    expect((e2e.match(/statusProvider/g) ?? []).length).toBeGreaterThan(0);
  });
});
