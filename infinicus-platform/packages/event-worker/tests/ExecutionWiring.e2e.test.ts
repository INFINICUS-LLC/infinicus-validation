/**
 * P0-6e - end-to-end proof of the controlled execution wiring with REAL components on real PostgreSQL:
 *
 *   authorized notification -> worker -> BO consumer -> BO intake receipt -> single-use claim -> (ABA mirror) -> governed gate
 *   -> BO execution engine (fresh authority under the target lock) -> reorder mutation -> sealed execution-evidence/1 + same-transaction outbox
 *   event -> operations.action.executed@1 delivery -> OM EXECUTION_VERIFIED -> OUTCOME_PENDING.
 *
 * The three ABA-owned ports (status provider, package source, consumption recorder) are SCRIPTED here: the package is built by the BO
 * execution-world fixture (real BO evaluation evidence), not issued through ABA's authoring chain. Everything else is the production
 * composition: the worker, dispatcher, outbox, ledger, subscriptions, inbox, BO consumer, intake, engine, governed gate, activation record and
 * service, OM consumer and verification table. Activation, subscriptions and audit rows are written only in the scratch test database.
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventSubscriptionRepository, OutboxRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { ACTION_AUTHORIZED_CONSUMER, buildActionAuthorizedEvent, executionPipelineSubscriptions } from '@infinicus/event-contracts';
import { learningEligibility } from '@infinicus/handoff-contracts';
import type { AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import { ExecutionActivationService, explicitCapabilities } from '@infinicus/business-operations-runtime';
import { actionAuthorizedPayloadFor } from '@infinicus/workflow';
import { ScriptedProvider, buildPackage, makeExecWorld, type ExecWorld } from '../../business-operations-runtime/tests/helpers/executionWorld.js';
import { fixtureSetReorder } from '../../business-operations-runtime/tests/helpers/reorderFixture.js';
import { seedAdminUser } from '../../business-operations-runtime/tests/helpers/activationAdmin.js';
import { answerFor } from '../../business-operations-runtime/tests/helpers/intakeFixture.js';
import { deleteMovementsForTenants } from '../../business-operations-runtime/tests/helpers/movementCleanup.js';
import { buildEventWorker } from '../src/index.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const ACTOR = randomUUID();
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
const BO = 'business_operations';
const MAX_AGE = 5000;

describe.runIf(run)('P0-6e: controlled execution wiring (real components, scripted ABA ports)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const outbox = new OutboxRepository();
  const subscriptions = new EventSubscriptionRepository();
  const activation = new ExecutionActivationService();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  interface Scenario {
    ew: ExecWorld; pkg: AuthorizedActionPackageV1; ctx: TenantContext; businessId: string; provider: ScriptedProvider; mirrors: any[];
    revoked: boolean; stale: boolean; sourceAvailable: boolean;
  }
  /** A claimable MODIFIED approval (baseline 100/200 -> final 150/250), announced, with scripted ABA ports. Nothing is activated yet. */
  async function scenario(): Promise<Scenario> {
    const ew = await makeExecWorld(admin, tenantIds, {});
    const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
    const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: await seedAdminUser(admin, ew.w.tenantId, ew.w.workspaceId) };
    const s = { ew, pkg, ctx, businessId: ew.ctx.businessId, mirrors: [], revoked: false, stale: false, sourceAvailable: true } as Scenario;
    // ABA's answer: CURRENT until revoked. The revocation (or staleness) applies only AFTER BO holds the claim, i.e. at the final check.
    s.provider = new ScriptedProvider(async () => {
      const claimed = Number((await admin.query(`SELECT count(*) n FROM ${BO}.authorized_action_claims WHERE package_id=$1`, [pkg.identity.packageId])).rows[0].n) > 0;
      if (!claimed) return answerFor(pkg);
      if (s.revoked) return answerFor(pkg, { authority: { state: 'REVOKED' } });
      if (s.stale) return answerFor(pkg, { status: { verifiedAt: new Date(Date.now() - MAX_AGE - 3000).toISOString() }, authority: { verifiedAt: new Date(Date.now() - MAX_AGE - 3000).toISOString() } });
      return answerFor(pkg);
    });
    await outbox.enqueueIfAbsent(ctx, {
      event: buildActionAuthorizedEvent({ payload: actionAuthorizedPayloadFor(pkg), correlationId: randomUUID(), causationId: null, recordedAt: new Date().toISOString() }),
      headers: { consumers: [ACTION_AUTHORIZED_CONSUMER] },
    });
    return s;
  }
  const enable = (s: Scenario, state: 'ENABLED' | 'DISABLED' = 'ENABLED') =>
    activation.setActivation(s.ctx, 'bo:admin', { businessId: s.businessId, actionType: ACTION, state, reason: 'e2e', correlationId: randomUUID() });
  const subscribeOnly = async (s: Scenario) => { for (const spec of executionPipelineSubscriptions(s.ctx.workspaceId)) await subscriptions.ensure(s.ctx, spec); };

  const worker = (s: Scenario, over: { clock?: () => Date; capabilities?: ReturnType<typeof explicitCapabilities>; killSwitch?: boolean } = {}) => buildEventWorker({
    config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: MAX_AGE, executionStatusMaxAgeMs: MAX_AGE, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: { discover: async () => [{ tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId }] },
    ports: {
      statusProvider: s.provider,
      source: { get: async () => (s.sourceAvailable ? { document: s.pkg as any, digest: s.pkg.integrity.digest } : null) },
      recorder: { recordConsumed: async (r) => { s.mirrors.push(r); return { outcome: 'RECORDED', recordedAt: new Date().toISOString() } as never; } },
    },
    killSwitchEngaged: () => over.killSwitch === true,
    ...(over.clock ? { clock: over.clock } : {}), ...(over.capabilities ? { capabilities: over.capabilities } : {}),
  });
  /** Runs passes until a pass finds nothing to claim (bounded). */
  async function drain(w: ReturnType<typeof worker>, max = 6): Promise<void> {
    for (let i = 0; i < max; i += 1) { const r = await w.runOnce(); if (r.claimed === 0) return; }
  }

  const t = (s: Scenario) => s.ctx.tenantId;
  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const executions = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [t(s)]);
  const attempts = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_execution_attempts WHERE tenant_id=$1 ORDER BY attempt_number`, [t(s)]);
  const claims = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [t(s)]);
  const receipts = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_receipts WHERE tenant_id=$1`, [t(s)]);
  const balance = async (s: Scenario) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version, reorder_policy_state state, reorder_policy_configured_source source FROM ${BO}.inventory_balances WHERE id=$1`, [s.ew.balanceId]))[0];
  const verifications = (s: Scenario) => q('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [t(s)]);
  const dead = (s: Scenario) => q('SELECT * FROM events.dead_letter_events WHERE tenant_id=$1', [t(s)]);
  /**
   * Where the pipeline stopped, for the failure message of an "expected one execution" assertion (CI-STAB-04). Without it a missing execution
   * reads only "expected [] to have a length of 1": the attempt rows and the claim/outbox/dead-letter state say whether BO retried an operational
   * error, the worker never reached the event, or the event was dead-lettered. Computed only when the count is wrong, so a passing run issues no extra query.
   */
  const pipelineState = async (s: Scenario) => {
    const att = await attempts(s);
    const outbox = await q(`SELECT event_type, status, attempt_count FROM events.outbox_events WHERE tenant_id=$1 ORDER BY created_at`, [t(s)]);
    const letters = await dead(s);
    return `executions missing | claims=${(await claims(s)).length} attempts=${JSON.stringify(att.map((a) => ({ n: a.attempt_number, outcome: a.outcome, reason: a.reason_code, detail: String(a.detail ?? '').slice(0, 160) })))} outbox=${JSON.stringify(outbox)} deadLetters=${letters.length}`;
  };
  const executedEvents = (s: Scenario) => q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(s)]);
  const untouched = async (s: Scenario) => expect(await balance(s)).toMatchObject({ rp: 100, rq: 200, version: 1, state: 'UNSET' });

  it('HAPPY PATH: activation allowed -> receipt -> claim -> fresh CURRENT status -> mutation -> sealed evidence -> same-transaction event -> delivery -> OM EXECUTION_VERIFIED / OUTCOME_PENDING', async () => {
    const s = await scenario();
    const enabled = await enable(s);
    expect(enabled).toMatchObject({ changed: true, activation: { version: 1, state: 'ENABLED', permissionCode: 'bo:admin' } });
    await untouched(s);

    await drain(worker(s));

    expect(await receipts(s)).toHaveLength(1);
    const claim = await claims(s);
    expect(claim).toHaveLength(1);
    expect(s.mirrors).toHaveLength(1); // ABA is told the claim; BO's claim stays canonical
    const ex = await executions(s);
    expect(ex, ex.length === 1 ? undefined : await pipelineState(s)).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: claim[0].id });
    expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2, state: 'CONFIGURED', source: 'AUTHORIZED_ACTION_PACKAGE' });
    expect(ex[0].evidence.contractVersion).toBe('execution-evidence/1');
    expect(ex[0].evidence_digest).toBe(ex[0].evidence.integrity.digest);

    const events = await executedEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'published', aggregate_id: ex[0].id });
    expect(events[0].payload).toMatchObject({ executionId: ex[0].id, evidenceDigest: ex[0].evidence_digest, outcome: 'SUCCEEDED', mutationResult: 'APPLIED' });

    const v = await verifications(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ execution_id: ex[0].id, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING', evidence_digest: ex[0].evidence_digest });
    // Continuous Learning receives no eligibility from a pending outcome
    expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false);
    expect(await dead(s)).toHaveLength(0);
    // the activation was audited atomically with the change
    expect(await q(`SELECT metadata FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.execution_activation.enabled'`, [t(s)])).toHaveLength(1);
  });

  it('enabling provisions the three delivery subscriptions idempotently, version-pinned and scope-correct', async () => {
    const s = await scenario();
    await enable(s);
    await enable(s); // repeating the state changes nothing
    await activation.setActivation(s.ctx, 'bo:admin', { businessId: s.businessId, actionType: ACTION, state: 'DISABLED', reason: 'pause', correlationId: randomUUID() });
    await enable(s);
    const subs = await q('SELECT subscriber_name, event_pattern, destination_ref, supported_versions, retry_policy FROM events.event_subscriptions WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY subscriber_name', [s.ctx.tenantId, s.ctx.workspaceId]);
    expect(subs.map((r) => [r.subscriber_name, r.event_pattern, r.destination_ref, r.supported_versions])).toEqual([
      [`bo.authorized_action_intake@${s.ctx.workspaceId}`, 'control_loop.action.authorized', 'bo.authorized_action_intake', ['1']],
      [`bo.authorized_action_recovery@${s.ctx.workspaceId}`, 'operations.authorized_action.recovery_due', 'bo.authorized_action_recovery', ['1']],
      [`om.execution_verification@${s.ctx.workspaceId}`, 'operations.action.executed', 'om.execution_verification', ['1']],
    ]);
    expect(subs[0].retry_policy).toMatchObject({ maxAttempts: 3, backoffSeconds: [1, 5, 15] });
    // versions chain 1..3 (ENABLED, DISABLED, ENABLED); the second ENABLED while enabled added nothing
    expect((await q(`SELECT version, state FROM ${BO}.execution_capability_activations WHERE business_id=$1 ORDER BY version`, [s.businessId])).map((r) => `${r.version}:${r.state}`)).toEqual(['1:ENABLED', '2:DISABLED', '3:ENABLED']);
  });

  describe('closed gate: no mutation, no claim', () => {
    it('no activation record (default CLOSED): the notification is dead-lettered CAPABILITY_DISABLED, nothing is received, claimed or executed', async () => {
      const s = await scenario();
      await subscribeOnly(s); // delivery exists, activation does not
      await drain(worker(s));
      const letters = await dead(s);
      expect(letters).toHaveLength(1);
      expect(String(letters[0].failure_reason)).toContain('CAPABILITY_DISABLED');
      expect(await receipts(s)).toHaveLength(0);
      expect(await claims(s)).toHaveLength(0);
      expect(await executions(s)).toHaveLength(0);
      expect(s.provider.calls).toBe(0);
      await untouched(s);
    });

    it('activation DISABLED after having been ENABLED is closed again', async () => {
      const s = await scenario();
      await enable(s);
      await enable(s, 'DISABLED');
      await drain(worker(s));
      expect(await claims(s)).toHaveLength(0);
      expect(await executions(s)).toHaveLength(0);
      await untouched(s);
    });

    it('the global kill switch removes capability even when the business is ENABLED', async () => {
      const s = await scenario();
      await enable(s);
      await drain(worker(s, { killSwitch: true }));
      expect(await claims(s)).toHaveLength(0);
      expect(await executions(s)).toHaveLength(0);
      await untouched(s);
    });

    it('an action type the registry does not support is never executed, even when the business is ENABLED', async () => {
      const s = await scenario();
      await enable(s);
      await drain(worker(s, { capabilities: explicitCapabilities([]) }));
      expect(await claims(s)).toHaveLength(0);
      expect(await executions(s)).toHaveLength(0);
      await untouched(s);
    });

    it('activation belongs to ONE business: enabling a sibling business in the same workspace opens nothing here', async () => {
      const s = await scenario();
      await subscribeOnly(s);
      await expect(activation.setActivation(s.ctx, 'bo:admin', { businessId: randomUUID(), actionType: ACTION, state: 'ENABLED', reason: 'x', correlationId: randomUUID() })).rejects.toThrow();
      await drain(worker(s));
      expect(await claims(s)).toHaveLength(0);
      await untouched(s);
    });
  });

  describe('fresh ABA authority at the moment of execution', () => {
    it('authority REVOKED after the claim: terminal REFUSED(AUTHORITY_REVOKED), nothing mutated, OM records the refusal as INCONCLUSIVE (never positive)', async () => {
      const s = await scenario();
      await enable(s);
      s.revoked = true;
      await drain(worker(s));
      const ex = await executions(s);
      expect(ex, ex.length === 1 ? undefined : await pipelineState(s)).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'AUTHORITY_REVOKED', mutation_result: 'NOT_APPLICABLE' });
      await untouched(s);
      const v = await verifications(s);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ execution_outcome: 'REFUSED', outcome_state: 'OUTCOME_INCONCLUSIVE', execution_state: 'EXECUTION_VERIFIED' });
      expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false);
    });

    it('a STALE authority answer is never trusted: nothing mutates, the delivery is retried, and persistent staleness ends in a terminal REFUSED(RETRIES_EXHAUSTED) after the 3 ruled attempts', async () => {
      const s = await scenario();
      await enable(s);
      s.stale = true;
      let offset = 0;
      const clock = () => new Date(Date.now() + offset);
      for (let i = 0; i < 5; i += 1) { await worker(s, { clock }).runOnce(); offset += 60_000; }
      expect((await attempts(s)).map((a) => a.attempt_number)).toEqual([1, 2]); // the third attempt is the terminal outcome
      const ex = await executions(s);
      expect(ex, ex.length === 1 ? undefined : await pipelineState(s)).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'RETRIES_EXHAUSTED', mutation_result: 'NOT_APPLICABLE', attempt_count: 3 });
      await untouched(s);
      const v = await verifications(s);
      expect(v[0]).toMatchObject({ execution_outcome: 'REFUSED', outcome_state: 'OUTCOME_INCONCLUSIVE' });
    });

    it('a transient condition that clears is retried through the outbox and then executes once (attempts are bounded and ordered)', async () => {
      const s = await scenario();
      await enable(s);
      s.stale = true;
      let offset = 0;
      const clock = () => new Date(Date.now() + offset);
      await worker(s, { clock }).runOnce(); // attempt 1: stale -> no decision, nothing mutated
      await untouched(s);
      expect(await executions(s)).toHaveLength(0);
      s.stale = false;
      offset += 60_000;
      await worker(s, { clock }).runOnce(); // redelivery: fresh answer -> executes
      offset += 60_000;
      await drain(worker(s, { clock }));
      const ex = await executions(s);
      expect(ex, ex.length === 1 ? undefined : await pipelineState(s)).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', attempt_count: 2 });
      expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2 });
    });

    it('a baseline that changed after authorization is never overwritten: REFUSED(BASELINE_CHANGED)', async () => {
      const s = await scenario();
      await enable(s);
      await fixtureSetReorder(admin, s.ew.balanceId, 'reorder_point = 120');
      await drain(worker(s));
      expect((await executions(s))[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'BASELINE_CHANGED' });
      expect(await balance(s)).toMatchObject({ rp: 120, rq: 200 }); // the newer value survives
    });

    it('the status provider is asked at the claim AND again at execution (the claim does not stand in for current authority)', async () => {
      const s = await scenario();
      await enable(s);
      await drain(worker(s));
      expect(s.provider.calls).toBeGreaterThanOrEqual(2);
    });
  });

  describe('exactly once', () => {
    it('duplicate delivery (the notification re-armed after completion) executes nothing twice and verifies once', async () => {
      const s = await scenario();
      await enable(s);
      await drain(worker(s));
      await admin.query(`UPDATE events.outbox_events SET status='pending', available_at=now(), claimed_at=NULL, published_at=NULL WHERE tenant_id=$1 AND event_type='control_loop.action.authorized'`, [t(s)]);
      await drain(worker(s));
      expect(await executions(s)).toHaveLength(1);
      expect(await claims(s)).toHaveLength(1);
      expect((await balance(s)).version).toBe(2);
      expect(await verifications(s)).toHaveLength(1);
    });

    it('concurrent triggers (two workers racing for the same notification) execute at most once', async () => {
      const s = await scenario();
      await enable(s);
      await Promise.all([worker(s).runOnce(), worker(s).runOnce(), worker(s).runOnce()]);
      await drain(worker(s));
      expect(await executions(s)).toHaveLength(1);
      expect(await claims(s)).toHaveLength(1);
      expect((await balance(s)).version).toBe(2);
      expect(await executedEvents(s)).toHaveLength(1);
    });

    it('replaying the executed event produces one OM verification and leaves BO truth untouched', async () => {
      const s = await scenario();
      await enable(s);
      await drain(worker(s));
      const before = (await executions(s))[0];
      await admin.query(`UPDATE events.outbox_events SET status='pending', available_at=now(), claimed_at=NULL, published_at=NULL WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(s)]);
      await drain(worker(s));
      expect(await verifications(s)).toHaveLength(1);
      expect((await executions(s))[0]).toEqual(before);
    });
  });

  describe('OM is downstream only', () => {
    it('an OM that cannot record its verification leaves BO execution truth, evidence and balance exactly as committed', async () => {
      const s = await scenario();
      await enable(s);
      // OM's table refuses writes for THIS tenant only (a per-tenant trigger, removed afterwards), so the subscription stays valid and the gate open.
      const fn = `p06e_fail_${s.ctx.tenantId.replace(/-/g, '')}`;
      await admin.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${s.ctx.tenantId}' THEN RAISE EXCEPTION 'om unavailable'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON outcome_monitoring.action_execution_verifications FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
      try {
        await drain(worker(s));
      } finally {
        await admin.query(`DROP TRIGGER ${fn} ON outcome_monitoring.action_execution_verifications`);
        await admin.query(`DROP FUNCTION public.${fn}()`);
      }
      const ex = await executions(s);
      expect(ex, ex.length === 1 ? undefined : await pipelineState(s)).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED' });
      expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2 });
      expect(await verifications(s)).toHaveLength(0);
      expect(ex[0].evidence_digest).toBe(ex[0].evidence.integrity.digest);
    });
  });
});
