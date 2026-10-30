/**
 * P0-6g - durable stranded-claim recovery (owner ruling: Alternative C), proven with REAL components on real PostgreSQL.
 *
 * A claim is BO's canonical consumption fact. The outbox delivery that should drive it can exhaust its budget (pre-claim intake retries share it
 * with the engine's post-claim retries) and leave a claim with no terminal execution. Every claim therefore carries one durable internal recovery
 * signal, written in the claim's own transaction and due 60 s later; the EXISTING worker delivers it and BO hands the EXISTING claim to the one
 * engine. These tests prove: the signal is atomic with the claim, due only at the ruled threshold, recovers a really stranded claim exactly once,
 * never re-drives a terminal claim, never skips the final authority/status check or the gate, adds no second retry policy, is idempotent under
 * concurrency, and can never create a claim or cross a tenant.
 *
 * The three ABA-owned ports are SCRIPTED (as in ExecutionWiring.e2e); everything else is the production composition. Requires DATABASE_URL (app
 * role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventSubscriptionRepository, OutboxRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import {
  ACTION_AUTHORIZED_CONSUMER, authorizedActionRecoveryEventId, buildActionAuthorizedEvent, buildAuthorizedActionRecoveryEvent, executionPipelineSubscriptions,
} from '@infinicus/event-contracts';
import type { AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import {
  AuthorizedActionExecutionService, AuthorizedActionIntakeService, ExecutionActivationService, EXECUTION_CLAIM_RECOVERY_MS, explicitCapabilities,
} from '@infinicus/business-operations-runtime';
import { actionAuthorizedPayloadFor } from '@infinicus/workflow';
import { ScriptedProvider, buildPackage, makeExecWorld, type ExecWorld } from '../../business-operations-runtime/tests/helpers/executionWorld.js';
import { seedAdminUser } from '../../business-operations-runtime/tests/helpers/activationAdmin.js';
import { answerFor } from '../../business-operations-runtime/tests/helpers/intakeFixture.js';
import { deleteMovementsForTenants } from '../../business-operations-runtime/tests/helpers/movementCleanup.js';
import { buildEventWorker } from '../src/index.js';
import { assertNoScopeErrors, newScopeErrorLog, recordScopeErrors, type ScopeErrorLog } from './helpers/scopeErrors.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const ACTOR = randomUUID();
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
const BO = 'business_operations';
const MAX_AGE = 5000;
const RECOVERY_TYPE = 'operations.authorized_action.recovery_due';
const CAPS = explicitCapabilities(['inventory_reorder_policy_update@1']);

describe.runIf(run)('P0-6g: durable stranded-claim recovery (real components, scripted ABA ports)', () => {
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
    /** Source (ABA package pull) unavailable: a PRE-claim retryable condition. */
    sourceAvailable: boolean;
    /** Authoritative status unavailable AFTER the claim: a POST-claim retryable condition. */
    statusDown: boolean;
    revoked: boolean;
    /** Scope errors the worker swallowed (CI-STAB-02 R2): any cycle that swallows one fails with its cause. */
    scopeErrors: ScopeErrorLog;
  }
  /** A claimable approval (baseline 100/200 -> 150/250), announced, scripted ABA ports. Nothing is activated yet. */
  async function scenario(announce = true): Promise<Scenario> {
    const ew = await makeExecWorld(admin, tenantIds, {});
    const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
    const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: await seedAdminUser(admin, ew.w.tenantId, ew.w.workspaceId) };
    const s = { ew, pkg, ctx, businessId: ew.ctx.businessId, mirrors: [], sourceAvailable: true, statusDown: false, revoked: false, scopeErrors: newScopeErrorLog() } as Scenario;
    s.provider = new ScriptedProvider(async () => {
      const claimed = Number((await admin.query(`SELECT count(*) n FROM ${BO}.authorized_action_claims WHERE package_id=$1`, [pkg.identity.packageId])).rows[0].n) > 0;
      if (!claimed) return answerFor(pkg);
      if (s.statusDown) return null;
      if (s.revoked) return answerFor(pkg, { authority: { state: 'REVOKED' } });
      return answerFor(pkg);
    });
    if (announce) {
      await outbox.enqueueIfAbsent(ctx, {
        event: buildActionAuthorizedEvent({ payload: actionAuthorizedPayloadFor(pkg), correlationId: randomUUID(), causationId: null, recordedAt: new Date().toISOString() }),
        headers: { consumers: [ACTION_AUTHORIZED_CONSUMER] },
      });
    }
    return s;
  }
  const enable = (s: Scenario, state: 'ENABLED' | 'DISABLED' = 'ENABLED') =>
    activation.setActivation(s.ctx, 'bo:admin', { businessId: s.businessId, actionType: ACTION, state, reason: 'p0-6g', correlationId: randomUUID() });

  const buildWorker = (s: Scenario, clock?: () => Date) => buildEventWorker({
    config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: MAX_AGE, executionStatusMaxAgeMs: MAX_AGE, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: { discover: async () => [{ tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId }] },
    ports: {
      statusProvider: s.provider,
      source: { get: async () => (s.sourceAvailable ? { document: s.pkg as any, digest: s.pkg.integrity.digest } : null) },
      recorder: { recordConsumed: async (r) => { s.mirrors.push(r); return { outcome: 'RECORDED', recordedAt: new Date().toISOString() } as never; } },
    },
    onScopeError: recordScopeErrors(s.scopeErrors),
    ...(clock ? { clock } : {}),
  });
  /** The scenario's worker. Every cycle must finish without swallowing a scope error; otherwise the test fails there, naming the cause. */
  const worker = (s: Scenario, clock?: () => Date) => {
    const w = buildWorker(s, clock);
    return { runOnce: async () => { const summary = await w.runOnce(); assertNoScopeErrors(s.scopeErrors, summary); return summary; } };
  };
  /** A time source `offsetSeconds` ahead of the real clock (the worker's `now` only gates outbox availability). */
  const ahead = (offsetSeconds: number) => () => new Date(Date.now() + offsetSeconds * 1000);

  const t = (s: Scenario) => s.ctx.tenantId;
  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const executions = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [t(s)]);
  const attempts = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_execution_attempts WHERE tenant_id=$1 ORDER BY attempt_number`, [t(s)]);
  const claims = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [t(s)]);
  const receipts = (s: Scenario) => q(`SELECT * FROM ${BO}.authorized_action_receipts WHERE tenant_id=$1`, [t(s)]);
  const dead = (s: Scenario) => q('SELECT * FROM events.dead_letter_events WHERE tenant_id=$1 ORDER BY first_failed_at', [t(s)]);
  const signals = (s: Scenario) => q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type=$2`, [t(s), RECOVERY_TYPE]);
  const executedEvents = (s: Scenario) => q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(s)]);
  const balance = async (s: Scenario) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version FROM ${BO}.inventory_balances WHERE id=$1`, [s.ew.balanceId]))[0];
  const untouched = async (s: Scenario) => expect(await balance(s)).toMatchObject({ rp: 100, rq: 200, version: 1 });
  const applied = async (s: Scenario) => expect(await balance(s)).toMatchObject({ rp: 150, rq: 250, version: 2 });

  /**
   * Reproduces the stranded claim exactly as the P0-6f e2e found it: the delivery budget (3) is spent by two PRE-claim "package not pullable"
   * retries, the third delivery claims and the engine's first attempt cannot decide (status down), so the notification is dead-lettered
   * RETRIES_EXHAUSTED while BO holds the claim with no terminal execution.
   */
  async function strand(s: Scenario): Promise<void> {
    await enable(s);
    s.sourceAvailable = false;
    await worker(s, ahead(0)).runOnce();
    await worker(s, ahead(20)).runOnce();
    s.sourceAvailable = true;
    s.statusDown = true;
    await worker(s, ahead(40)).runOnce();
    expect(await claims(s)).toHaveLength(1);
    expect(await executions(s)).toHaveLength(0);
    expect((await attempts(s)).map((a) => a.attempt_number)).toEqual([1]);
    expect((await dead(s)).map((d) => JSON.stringify(d))).toEqual([expect.stringContaining('RETRIES_EXHAUSTED')]);
    await untouched(s);
  }
  const engine = (s: Scenario) => new AuthorizedActionExecutionService({ statusProvider: s.provider, executionStatusMaxAgeMs: MAX_AGE, gate: { isEnabled: async () => true } as never, capabilities: CAPS });

  describe('the signal is written with the claim', () => {
    it('1. a claim writes exactly ONE reference-only recovery signal in its own transaction, due claimedAt + the ruled 60 s, with a deterministic id', async () => {
      const s = await scenario(false);
      const intake = new AuthorizedActionIntakeService({ statusProvider: new ScriptedProvider(() => answerFor(s.pkg)), statusMaxAgeMs: 10_000, capabilities: CAPS });
      const r = await intake.intake(s.ew.ctx, { package: s.pkg });
      expect(r.outcome).toBe('CLAIMED');
      const rows = await signals(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: authorizedActionRecoveryEventId(r.claimId), status: 'pending', aggregate_id: r.claimId, event_version: '1' });
      expect(rows[0].payload).toEqual({
        claimId: r.claimId, packageId: s.pkg.identity.packageId, packageVersion: s.pkg.identity.packageVersion, digest: s.pkg.integrity.digest,
        scope: { tenantId: t(s), workspaceId: s.ctx.workspaceId, businessId: s.businessId }, actionType: ACTION, claimedAt: r.claimedAt,
        dueAt: new Date(Date.parse(r.claimedAt) + EXECUTION_CLAIM_RECOVERY_MS).toISOString(),
      });
      expect(Math.abs(new Date(rows[0].available_at).getTime() - (Date.parse(r.claimedAt) + 60_000))).toBeLessThan(2); // the 60 s threshold, from the claim time
      expect(JSON.stringify(rows[0].payload)).not.toMatch(/parameters|reorderPoint|authority|"package"|approver/i); // a nudge, never a copy of the package
      expect(await executions(s)).toHaveLength(0); // scheduling executes nothing
      await untouched(s);
    });

    it('2. a replayed intake and a refused intake write NO second signal; a failed schedule rolls the claim back (no claim without its signal)', async () => {
      const s = await scenario(false);
      const provider = new ScriptedProvider(() => answerFor(s.pkg));
      const intake = new AuthorizedActionIntakeService({ statusProvider: provider, statusMaxAgeMs: 10_000, capabilities: CAPS });
      const first = await intake.intake(s.ew.ctx, { package: s.pkg });
      const again = await intake.intake(s.ew.ctx, { package: s.pkg });
      expect(again).toMatchObject({ outcome: 'REPLAYED', claimId: first.claimId });
      expect(await signals(s)).toHaveLength(1);

      const refused = await scenario(false);
      const revoked = new ScriptedProvider(() => answerFor(refused.pkg, { authority: { state: 'REVOKED' }, status: { lifecycle: 'REVOKED' } } as never));
      await new AuthorizedActionIntakeService({ statusProvider: revoked, statusMaxAgeMs: 10_000, capabilities: CAPS }).intake(refused.ew.ctx, { package: refused.pkg }).catch(() => undefined);
      expect(await claims(refused)).toHaveLength(0);
      expect(await signals(refused)).toHaveLength(0);

      const failing = await scenario(false);
      const broken = new AuthorizedActionIntakeService({
        statusProvider: new ScriptedProvider(() => answerFor(failing.pkg)), statusMaxAgeMs: 10_000, capabilities: CAPS,
        recovery: { schedule: async () => { throw new Error('the signal could not be written'); } },
      });
      await expect(broken.intake(failing.ew.ctx, { package: failing.pkg })).rejects.toThrow('the signal could not be written');
      expect(await claims(failing)).toHaveLength(0);
      expect(await receipts(failing)).toHaveLength(0);
      expect(await signals(failing)).toHaveLength(0);
    });

    it('3. scheduling the same claim twice is a no-op (deterministic id): one signal per claim', async () => {
      const s = await scenario(false);
      const r = await new AuthorizedActionIntakeService({ statusProvider: new ScriptedProvider(() => answerFor(s.pkg)), statusMaxAgeMs: 10_000, capabilities: CAPS }).intake(s.ew.ctx, { package: s.pkg });
      const event = buildAuthorizedActionRecoveryEvent({ payload: (await signals(s))[0].payload, correlationId: randomUUID() });
      const second = await outbox.enqueueIfAbsent(s.ctx, { event, availableAt: new Date() });
      expect(second).toEqual({ id: authorizedActionRecoveryEventId(r.claimId), inserted: false });
      expect(await signals(s)).toHaveLength(1);
    });
  });

  describe('recovery of a really stranded claim', () => {
    it('4. the signal is NOT delivered before its due time (the ruled 60 s threshold)', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false;
      const early = await worker(s, ahead(40)).runOnce(); // the signal is due at claim + 60 s; this pass is about claim + 40 s
      expect(early.claimed).toBe(0);
      expect(await executions(s)).toHaveLength(0);
      expect((await signals(s))[0].status).toBe('pending');
      await untouched(s);
    });

    it('5. when it falls due the existing worker recovers the stranded claim ONCE: one mutation, one evidence row, one executed event, the claim stays the canonical record', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false; // the condition that stranded it has cleared
      await worker(s, ahead(120)).runOnce();
      const claim = await claims(s);
      expect(claim).toHaveLength(1); // no second claim
      const ex = await executions(s);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: claim[0].id, attempt_count: 2 });
      await applied(s);
      expect(await executedEvents(s)).toHaveLength(1);
      expect((await signals(s))[0].status).toBe('published');
      expect(s.mirrors).toHaveLength(1); // recovery never re-mirrors: it is not intake
      // a further pass changes nothing
      await worker(s, ahead(240)).runOnce();
      expect(await executions(s)).toHaveLength(1);
      expect(await executedEvents(s)).toHaveLength(1);
      await applied(s);
    });

    it('6. recovery adds NO second retry policy: a condition that never clears ends in the engine terminal outcome within its own 3 attempts, nothing mutated', async () => {
      const s = await scenario();
      await strand(s); // engine attempt 1 consumed before the signal
      for (let i = 0; i < 6; i += 1) await worker(s, ahead(120 + i * 60)).runOnce();
      const ex = await executions(s);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'RETRIES_EXHAUSTED', mutation_result: 'NOT_APPLICABLE', attempt_count: 3 });
      expect((await attempts(s)).map((a) => a.attempt_number)).toEqual([1, 2]); // the third attempt is the terminal row: never more than the ruled 3
      await untouched(s);
      expect(await executedEvents(s)).toHaveLength(1); // the terminal outcome is announced once
    });
  });

  describe('a terminal outcome is spent', () => {
    it('7. a claim that completed normally is NEVER re-driven when its signal falls due: no attempt, no second execution, evidence or event', async () => {
      const s = await scenario();
      await enable(s);
      await worker(s, ahead(0)).runOnce();
      const before = { ex: await executions(s), ev: await executedEvents(s), at: await attempts(s) };
      expect(before.ex).toHaveLength(1);
      await applied(s);
      expect((await signals(s))[0].status).toBe('pending'); // still waiting for its due time
      const due = await worker(s, ahead(120)).runOnce();
      expect(due.claimed).toBeGreaterThan(0);
      expect(await executions(s)).toEqual(before.ex);
      expect(await executedEvents(s)).toHaveLength(1);
      expect(await attempts(s)).toEqual(before.at);
      await applied(s);
      expect((await signals(s))[0].status).toBe('published'); // handled as a no-op, not dead-lettered
      expect(await dead(s)).toHaveLength(0);
    });

    it('8. a terminal REFUSED / FAILED claim stays spent: recovery does not retry it, and a new authorization is required', async () => {
      const s = await scenario();
      await enable(s);
      s.revoked = true; // authority revoked after the claim: terminal REFUSED(AUTHORITY_REVOKED)
      await worker(s, ahead(0)).runOnce();
      const refused = await executions(s);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'AUTHORITY_REVOKED' });
      s.revoked = false; // even if authority were CURRENT again, the spent claim is not retried
      await worker(s, ahead(120)).runOnce();
      expect(await executions(s)).toEqual(refused);
      expect(await attempts(s)).toHaveLength(0);
      await untouched(s);
      expect(await executedEvents(s)).toHaveLength(1);
    });
  });

  describe('recovery carries no authority of its own', () => {
    it('9. the FINAL authority check is still mandatory: a stranded claim whose authority was revoked meanwhile ends REFUSED(AUTHORITY_REVOKED), nothing mutated', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false;
      s.revoked = true;
      await worker(s, ahead(120)).runOnce();
      const ex = await executions(s);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', reason_code: 'AUTHORITY_REVOKED', mutation_result: 'NOT_APPLICABLE' });
      await untouched(s);
    });

    it('10. a closed gate (activation disabled) recovers nothing: dead letter CAPABILITY_DISABLED, no execution, no mutation, the claim is left as it was', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false;
      await enable(s, 'DISABLED');
      await worker(s, ahead(120)).runOnce();
      expect(await executions(s)).toHaveLength(0);
      expect((await attempts(s)).map((a) => a.attempt_number)).toEqual([1]);
      expect(JSON.stringify(await dead(s))).toContain('CAPABILITY_DISABLED');
      expect((await signals(s))[0].status).not.toBe('published');
      await untouched(s);
      expect(await claims(s)).toHaveLength(1);
    });
  });

  describe('idempotent and concurrency-safe', () => {
    it('11. a signal delivered by two workers while the engine is also driven directly yields exactly one execution, one mutation and one executed event', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false;
      const claimId = (await claims(s))[0].id as string;
      await Promise.all([
        worker(s, ahead(120)).runOnce(), worker(s, ahead(120)).runOnce(), worker(s, ahead(120)).runOnce(),
        engine(s).executeClaim({ ...s.ew.ctx } as never, claimId),
      ]);
      const ex = await executions(s);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED' });
      await applied(s); // version 2 exactly: applied once
      expect(await executedEvents(s)).toHaveLength(1);
      expect(await claims(s)).toHaveLength(1);
    });

    it('12. a duplicate delivery of the same signal (inbox replay) changes nothing', async () => {
      const s = await scenario();
      await strand(s);
      s.statusDown = false;
      await worker(s, ahead(120)).runOnce();
      const done = await executions(s);
      expect(done).toHaveLength(1);
      // re-open the delivered signal as if the outbox redelivered it
      await admin.query(`UPDATE events.outbox_events SET status='pending', available_at=now() WHERE tenant_id=$1 AND event_type=$2`, [t(s), RECOVERY_TYPE]);
      await worker(s, ahead(300)).runOnce();
      expect(await executions(s)).toEqual(done);
      expect(await executedEvents(s)).toHaveLength(1);
      await applied(s);
    });
  });

  describe('a recovery signal can never create or borrow a claim', () => {
    const forged = (s: Scenario, payload: Record<string, unknown>) => ({
      ...buildAuthorizedActionRecoveryEvent({
        payload: { claimId: randomUUID(), packageId: s.pkg.identity.packageId, packageVersion: 1, digest: s.pkg.integrity.digest, scope: { tenantId: t(s), workspaceId: s.ctx.workspaceId, businessId: s.businessId }, actionType: ACTION, claimedAt: '2026-10-12T10:00:00.000Z', dueAt: '2026-10-12T10:01:00.000Z', ...payload } as never,
        correlationId: randomUUID(),
      }),
      eventId: randomUUID(), idempotencyKey: `forged:${randomUUID()}`,
    });

    it('13. a signal naming no claim, a claim of another scope, or a claim it does not describe is dead-lettered: no claim, receipt, execution or mutation appears', async () => {
      const a = await scenario(false);
      const b = await scenario(false);
      await enable(a); await enable(b);
      const realB = await new AuthorizedActionIntakeService({ statusProvider: new ScriptedProvider(() => answerFor(b.pkg)), statusMaxAgeMs: 10_000, capabilities: CAPS }).intake(b.ew.ctx, { package: b.pkg });
      const claimsBefore = (await claims(a)).length;
      // (i) no such claim in A's scope
      await outbox.enqueueIfAbsent(a.ctx, { event: forged(a, {}), availableAt: new Date() });
      // (ii) B's real claim id, delivered in A's scope: RLS hides it
      await outbox.enqueueIfAbsent(a.ctx, { event: forged(a, { claimId: realB.claimId }), availableAt: new Date() });
      await worker(a, ahead(0)).runOnce();
      // (iii) B's own claim, described with the wrong digest
      await outbox.enqueueIfAbsent(b.ctx, { event: forged(b, { claimId: realB.claimId, packageId: b.pkg.identity.packageId, digest: `sha256:${'b'.repeat(64)}` }), availableAt: new Date() });
      b.statusDown = true; // were it driven, it could not execute either way; the point is that it is refused before the engine
      await worker(b, ahead(0)).runOnce();

      const deadA = JSON.stringify(await dead(a));
      expect(deadA.match(/CLAIM_NOT_FOUND/g)).toHaveLength(2);
      expect(JSON.stringify(await dead(b))).toContain('CLAIM_MISMATCH');
      expect(await claims(a)).toHaveLength(claimsBefore);
      expect(await receipts(a)).toHaveLength(0);
      expect(await executions(a)).toHaveLength(0);
      expect(await attempts(b)).toHaveLength(0); // refused before the engine was ever asked
      await untouched(a); await untouched(b);
    });
  });
});
