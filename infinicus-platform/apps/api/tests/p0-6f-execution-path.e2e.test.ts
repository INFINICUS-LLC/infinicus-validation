/**
 * P0-6f - THE PRINCIPAL END-TO-END PROOF of the authorized-action execution path, with the production composition and no injected BO package:
 *
 *   ABA authoring + issuance (HTTP, real verifier) -> governed activation (HTTP, bo:admin) -> ABA announcer (inside the issuance transaction)
 *   -> outbox -> worker -> BO consumer -> BO intake receipt -> single-use claim -> ABA CONSUMED mirror (real recorder)
 *   -> governed gate -> engine -> FRESH ABA status (real provider) -> mutation -> sealed execution-evidence/1 + executed event (same transaction)
 *   -> worker -> OM EXECUTION_VERIFIED / OUTCOME_PENDING.
 *
 * REAL: the Fastify application (production composition root incl. the ABA announcer), the ABA authoring chain and issuer, the BO evaluation and
 * verifier, the worker composition with the real ABA status provider / package source / consumption recorder, the dispatcher, outbox, ledger,
 * subscriptions, inbox, BO intake, engine, activation record, OM consumer and tables, on PostgreSQL with RLS enforced for the app role.
 * SCRIPTED: nothing external to the platform. (One negative test wraps the real status provider to withhold answers, to reproduce a stranded claim.)
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads and rows are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, EventSubscriptionRepository } from '@infinicus/database';
import { executionPipelineSubscriptions } from '@infinicus/event-contracts';
import { learningEligibility } from '@infinicus/handoff-contracts';
import type { AuthoritativePackageStatusProvider } from '@infinicus/handoff-contracts';
import { AbaPackageStatusProvider, DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { AuthorizedActionExecutionService, GovernedExecutionGate, PRODUCTION_BO_CAPABILITIES } from '@infinicus/business-operations-runtime';
// The worker composition is imported by path (not as a package dependency): the API package must never depend on the dispatcher host (P0-6b guard).
import { buildEventWorker } from '../../../packages/event-worker/src/index.js';
import { buildApp } from '../src/app.js';
import { ACTION, FINAL, BASELINE, chainKit, type Chain } from './helpers/authorizedPackageChain.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ACTOR = randomUUID();
const BO = 'business_operations';
const ABA = 'approved_business_action';
const MAX_AGE = 5000;

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
let kit: ReturnType<typeof chainKit>;
const subscriptions = new EventSubscriptionRepository();

describe.runIf(run)('P0-6f: authorized-action execution path - production composition, real ABA issuance, real BO, real OM', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    // PRODUCTION composition root: the real evidence verifier AND the ABA announcer joined to BO's governed gate. No override.
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = chainKit({ app, admin, tenantIds });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const t = (c: Chain) => c.s.ctx.tenantId;
  const authorizedEvents = (c: Chain) => q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='control_loop.action.authorized'`, [t(c)]);
  const executedEvents = (c: Chain) => q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(c)]);
  const receipts = (c: Chain) => q(`SELECT * FROM ${BO}.authorized_action_receipts WHERE tenant_id=$1`, [t(c)]);
  const claims = (c: Chain) => q(`SELECT * FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [t(c)]);
  const executions = (c: Chain) => q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [t(c)]);
  const lifecycle = (c: Chain) => q(`SELECT state, consumption_receipt_id FROM ${ABA}.authorized_action_package_lifecycle_events WHERE business_id=$1 ORDER BY created_at`, [c.s.bizId]);
  const verifications = (c: Chain) => q('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [t(c)]);
  const dead = (c: Chain) => q('SELECT * FROM events.dead_letter_events WHERE tenant_id=$1', [t(c)]);
  const balance = async (c: Chain) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version, reorder_policy_state state FROM ${BO}.inventory_balances WHERE id=$1`, [c.balanceId]))[0];
  const untouched = async (c: Chain) => expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1, state: 'UNSET' });
  const nothingExecuted = async (c: Chain) => { expect(await claims(c)).toHaveLength(0); expect(await executions(c)).toHaveLength(0); await untouched(c); };

  const worker = (c: Chain, over: { clock?: () => Date; statusProvider?: AuthoritativePackageStatusProvider } = {}) => buildEventWorker({
    config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: MAX_AGE, executionStatusMaxAgeMs: MAX_AGE, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: { discover: async () => [{ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId }] },
    killSwitchEngaged: () => false,
    ...(over.statusProvider ? { ports: { statusProvider: over.statusProvider } } : {}), // the ONLY port ever substituted (see the stranded-claim test)
    ...(over.clock ? { clock: over.clock } : {}),
  });
  async function drain(w: ReturnType<typeof worker>, max = 6): Promise<void> {
    for (let i = 0; i < max; i += 1) { const r = await w.runOnce(); if (r.claimed === 0) return; }
  }

  it('THE PROOF: ABA issues and announces; BO receives, claims, executes under fresh ABA authority; evidence and event commit together; OM verifies - with no injected BO package', async () => {
    const c = await kit.authorChain();
    // The test wrote NO Business Operations or event row for this package: everything below is produced by the platform.
    expect(await receipts(c)).toHaveLength(0);
    expect(await authorizedEvents(c)).toHaveLength(0);

    const on = await kit.activate(c);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ state: 'ENABLED', version: 1, permissionCode: 'bo:admin', changed: true });
    const issued = await kit.issue(c);
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED' });
    const packageId = issued.json().packageId as string;

    // ABA announced - authorization only, a REFERENCE (no body, no parameters), via the existing outbox, idempotent identity.
    const announced = await authorizedEvents(c);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ status: 'pending', aggregate_id: packageId });
    expect(Object.keys(announced[0].payload).sort()).toEqual(['actionType', 'automationLevel', 'decisionId', 'digest', 'expiresAt', 'issuedAt', 'packageId', 'packageVersion', 'scope']);
    expect(JSON.stringify(announced[0].payload)).not.toContain('reorderPoint');
    expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, version: 1 }); // announcing mutates nothing
    expect(await receipts(c)).toHaveLength(0);

    await drain(worker(c));

    const rc = await receipts(c);
    expect(rc).toHaveLength(1);
    expect(rc[0].digest).toBe(issued.json().digest);
    const cl = await claims(c);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toMatchObject({ package_id: packageId, receipt_id: rc[0].id });
    // ABA's CONSUMED mirror was written by the REAL recorder, carrying BO's receipt id
    expect((await lifecycle(c)).map((l) => l.state)).toEqual(['ISSUED', 'CONSUMED']);
    expect((await lifecycle(c))[1].consumption_receipt_id).toBe(rc[0].id);

    const ex = await executions(c);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: cl[0].id, package_id: packageId });
    expect(await balance(c)).toMatchObject({ rp: FINAL.reorderPoint, rq: FINAL.reorderQuantity, version: 2, state: 'CONFIGURED' });
    expect(ex[0].evidence.contractVersion).toBe('execution-evidence/1');
    expect(ex[0].evidence_digest).toBe(ex[0].evidence.integrity.digest);
    expect(ex[0].evidence.identity.packageDigest).toBe(issued.json().digest);

    const ev = await executedEvents(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: 'published', aggregate_id: ex[0].id });
    expect(ev[0].payload).toMatchObject({ executionId: ex[0].id, evidenceDigest: ex[0].evidence_digest, packageId, outcome: 'SUCCEEDED', mutationResult: 'APPLIED' });

    const v = await verifications(c);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ execution_id: ex[0].id, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING', evidence_digest: ex[0].evidence_digest });
    expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false);
    expect(await dead(c)).toHaveLength(0);
    // the authorized notification was delivered through the ledger to the BO consumer
    expect((await authorizedEvents(c))[0].status).toBe('published');
  }, 60_000);

  describe('closed by default', () => {
    it('NO ACTIVATION: the package is issued (ISSUED) but never announced; nothing is delivered, claimed or executed; activating later announces it on an identical issue request', async () => {
      const c = await kit.authorChain();
      const first = await kit.issue(c);
      expect(first.statusCode).toBe(201);
      expect(await authorizedEvents(c)).toHaveLength(0); // gate closed: ISSUED, not announced
      await drain(worker(c));
      await nothingExecuted(c);
      expect((await lifecycle(c)).map((l) => l.state)).toEqual(['ISSUED']);

      expect((await kit.activate(c)).statusCode).toBe(200);
      const again = await kit.issue(c);
      expect(again.json()).toMatchObject({ outcome: 'REPLAYED', packageId: first.json().packageId });
      expect(await authorizedEvents(c)).toHaveLength(1); // announced now, once
      await drain(worker(c));
      expect((await executions(c))[0]).toMatchObject({ outcome: 'SUCCEEDED' });
    }, 60_000);

    it('MISSING SUBSCRIPTION: a subscription removed after activation closes the gate - the package is not announced, and an announced one is never claimed', async () => {
      const a = await kit.authorChain();
      await kit.activate(a);
      await admin.query(`DELETE FROM events.event_subscriptions WHERE tenant_id=$1 AND subscriber_name LIKE 'bo.authorized_action_intake@%'`, [t(a)]);
      expect((await kit.issue(a)).statusCode).toBe(201);
      expect(await authorizedEvents(a)).toHaveLength(0);
      await drain(worker(a));
      await nothingExecuted(a);

      const b = await kit.authorChain();
      await kit.activate(b);
      expect((await kit.issue(b)).statusCode).toBe(201);
      expect(await authorizedEvents(b)).toHaveLength(1);
      await admin.query(`DELETE FROM events.event_subscriptions WHERE tenant_id=$1 AND subscriber_name LIKE 'om.execution_verification@%'`, [t(b)]); // OM's path is gone: no execution without a verification path
      await drain(worker(b));
      await nothingExecuted(b);
      expect((await dead(b)).map((d) => String(d.failure_reason)).join()).toContain('CAPABILITY_DISABLED');
    }, 90_000);

    it('FAILED SUBSCRIPTION PROVISIONING: a conflicting subscription makes the activation request 409, writes no activation, and leaves announcement and execution closed', async () => {
      const c = await kit.authorChain();
      const [intake] = executionPipelineSubscriptions(c.s.ctx.workspaceId);
      await subscriptions.ensure(c.s.ctx, { ...intake, supportedVersions: ['2'] }); // same platform-unique name, different pin
      const on = await kit.activate(c);
      expect(on.statusCode).toBe(409);
      expect(on.json().error.code).toBe('ExecutionActivationError');
      expect(await q(`SELECT 1 FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [c.s.bizId])).toHaveLength(0);
      expect((await kit.get(c.s, `/v1/businesses/${c.s.bizId}/execution-activations?code=${ACTION.code}&schemaVersion=${ACTION.schemaVersion}`)).json().state).toBe('NOT_ACTIVATED');
      expect((await kit.issue(c)).statusCode).toBe(201);
      expect(await authorizedEvents(c)).toHaveLength(0);
      await drain(worker(c));
      await nothingExecuted(c);
    }, 60_000);

    it('the kill switch (production composition option) stops the ABA announcement too: capability can only be removed', async () => {
      const killed = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), { abaAnnouncement: { killSwitchEngaged: () => true } });
      await killed.ready();
      try {
        const k = chainKit({ app: killed, admin, tenantIds });
        const c = await k.authorChain();
        expect((await k.activate(c)).statusCode).toBe(200);
        expect((await k.issue(c)).statusCode).toBe(201);
        expect(await authorizedEvents(c)).toHaveLength(0);
      } finally { await killed.close(); }
    }, 90_000);
  });

  describe('authority', () => {
    it('REVOKED approver authority before execution: BO refuses at intake (no claim), nothing mutates, the package is never consumed', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      expect((await kit.issue(c)).statusCode).toBe(201);
      // the REAL ABA revocation route (aba:admin; the owner holds it): the approver authority recorded at decision time is no longer current
      const rev = await kit.post(c.s, `/v1/businesses/${c.s.bizId}/approver-assignments/${DEFAULT_APPROVER_ASSIGNMENT_CODE}/revoke`, { reason: 'p0-6f revoked before execution' });
      expect(rev.statusCode).toBe(200);
      expect(rev.json()).toMatchObject({ status: 'revoked' });
      await drain(worker(c));
      await nothingExecuted(c);
      expect((await lifecycle(c)).map((l) => l.state)).toEqual(['ISSUED']); // never CONSUMED
      // the refusal is BO's own, for the right reason: ABA's authoritative answer said the approver authority is not current
      const attempts = await q(`SELECT outcome, refusal_codes FROM ${BO}.authorized_action_intake_attempts WHERE tenant_id=$1`, [t(c)]);
      expect(attempts.length).toBeGreaterThan(0);
      expect(JSON.stringify(attempts.map((a) => a.refusal_codes))).toContain('AUTHORITY_REVOKED');
    }, 60_000);
  });

  describe('exactly once', () => {
    it('DUPLICATE AUTHORIZATION ANNOUNCEMENT: re-issuing the identical package leaves one notification and one execution', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      const first = await kit.issue(c);
      for (let i = 0; i < 3; i += 1) expect((await kit.issue(c)).json()).toMatchObject({ outcome: 'REPLAYED', packageId: first.json().packageId });
      expect(await authorizedEvents(c)).toHaveLength(1);
      await drain(worker(c));
      expect(await executions(c)).toHaveLength(1);
    }, 60_000);

    it('DUPLICATE BO NOTIFICATION: re-arming the delivered notification neither re-claims nor re-executes, and OM still holds one verification', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      await kit.issue(c);
      await drain(worker(c));
      await admin.query(`UPDATE events.outbox_events SET status='pending', available_at=now(), claimed_at=NULL, published_at=NULL WHERE tenant_id=$1 AND event_type='control_loop.action.authorized'`, [t(c)]);
      await drain(worker(c));
      expect(await claims(c)).toHaveLength(1);
      expect(await executions(c)).toHaveLength(1);
      expect((await balance(c)).version).toBe(2);
      expect(await verifications(c)).toHaveLength(1);
    }, 60_000);

    it('CONCURRENT PROCESSING: racing workers execute the authorization at most once', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      await kit.issue(c);
      await Promise.all([worker(c).runOnce(), worker(c).runOnce(), worker(c).runOnce()]);
      await drain(worker(c));
      expect(await claims(c)).toHaveLength(1);
      expect(await executions(c)).toHaveLength(1);
      expect((await balance(c)).version).toBe(2);
      expect(await executedEvents(c)).toHaveLength(1);
      expect(await verifications(c)).toHaveLength(1);
    }, 60_000);
  });

  describe('OM is downstream only', () => {
    it('OM UNAVAILABLE: BO execution truth, evidence and balance stay exactly as committed; no verification is invented', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      await kit.issue(c);
      const fn = `p06f_fail_${t(c).replace(/-/g, '')}`;
      await admin.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${t(c)}' THEN RAISE EXCEPTION 'om unavailable'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON outcome_monitoring.action_execution_verifications FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
      try { await drain(worker(c)); } finally {
        await admin.query(`DROP TRIGGER ${fn} ON outcome_monitoring.action_execution_verifications`);
        await admin.query(`DROP FUNCTION public.${fn}()`);
      }
      const ex = await executions(c);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED' });
      expect(await balance(c)).toMatchObject({ rp: FINAL.reorderPoint, version: 2 });
      expect(await verifications(c)).toHaveLength(0);
    }, 60_000);
  });

  describe('dead-lettered notification with a claim and no outcome (owner decision required - see P0-6f doc)', () => {
    it('is reproducible, fail-safe and observable: nothing mutates and nothing re-drives it; the existing scoped primitive (runDue) can recover it safely, but no worker calls it', async () => {
      const c = await kit.authorChain();
      await kit.activate(c);
      await kit.issue(c);
      const real = new AbaPackageStatusProvider({ actorUserId: ACTOR });
      // Delivery attempts 1-2 are spent BEFORE the claim (status "not obtainable yet"); attempt 3 claims, but the final check cannot decide -> dead letter.
      let claimedAtCall: boolean | null = null;
      const starve: AuthoritativePackageStatusProvider = {
        getStatus: async (req) => {
          const hasClaim = (await claims(c)).length > 0;
          const calls = (claimedAtCall = hasClaim, (starve as any).n = ((starve as any).n ?? 0) + 1);
          if (!hasClaim && calls <= 2) return null; // transient intake refusal, attempts 1 and 2
          if (hasClaim) return null; // the engine cannot get an answer after the claim
          return real.getStatus(req);
        },
      };
      let offset = 0;
      const clock = () => new Date(Date.now() + offset);
      for (let i = 0; i < 5; i += 1) { await worker(c, { clock, statusProvider: starve }).runOnce(); offset += 60_000; }
      expect(claimedAtCall).not.toBeNull();

      const cl = await claims(c);
      expect(cl).toHaveLength(1);                       // BO holds the single-use claim ...
      expect(await executions(c)).toHaveLength(0);       // ... with no terminal outcome ...
      await untouched(c);                                // ... and nothing was mutated.
      const letters = await dead(c);
      expect(letters).toHaveLength(1);                   // the notification is dead-lettered
      expect(String(letters[0].failure_reason)).toContain('RETRIES_EXHAUSTED');
      const attemptRows = await q(`SELECT attempt_number FROM ${BO}.authorized_action_execution_attempts WHERE claim_id=$1`, [cl[0].id]);
      expect(attemptRows.length).toBeLessThan(3);        // the engine's own budget was not spent: the shared delivery budget was

      // No worker pass re-drives it (the stranded state is stable) ...
      await worker(c, { clock: () => new Date(Date.now() + offset + 600_000) }).runOnce();
      expect(await executions(c)).toHaveLength(0);
      // ... while the EXISTING scoped primitive recovers it safely: fresh ABA status, the 60 s threshold, terminal never re-driven.
      const engine = new AuthorizedActionExecutionService({
        statusProvider: real, executionStatusMaxAgeMs: MAX_AGE, clock: () => new Date(Date.now() + 120_000),
        gate: new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: ACTOR }),
      });
      const recovered = await engine.runDue({ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId, userId: ACTOR }, { limit: 10 });
      expect(recovered).toHaveLength(1);
      expect((await executions(c))[0]).toMatchObject({ outcome: 'SUCCEEDED', claim_id: cl[0].id });
      expect(await engine.runDue({ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId, userId: ACTOR }, { limit: 10 })).toHaveLength(0); // terminal: never re-driven
    }, 120_000);
  });
});
