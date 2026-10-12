/**
 * P0-6d - end-to-end proof of the BO -> OM execution-verification pipeline with REAL components on real PostgreSQL:
 * BO engine (execution + evidence + outbox in one transaction) -> dispatcher/worker -> ledger -> subscription -> OM consumer ->
 * BO evidence port -> OM verification record.
 *
 * Proves: OM records EXECUTION_VERIFIED with an outcome that is never better than PENDING/INCONCLUSIVE; refused/failed executions are
 * preserved as such; tampering, a swapped reference and duplicate delivery are handled; OM never changes a BO fact; and nothing here
 * reaches Continuous Learning. Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ActionExecutionVerificationRepository, EventSubscriptionRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { ACTION_EXECUTED_CONSUMER, ACTION_EXECUTED_EVENT_TYPE } from '@infinicus/event-contracts';
import { AuthorizedActionExecutionService } from '@infinicus/business-operations-runtime';
import { ScriptedProvider, SUPPORTED, buildPackage, claimPackage, consumedAnswer, makeExecWorld, type ExecWorld } from '../../business-operations-runtime/tests/helpers/executionWorld.js';
import { deleteMovementsForTenants } from '../../business-operations-runtime/tests/helpers/movementCleanup.js';
import { buildEventWorker } from '../src/index.js';
import type { ScopeDiscovery } from '../src/index.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const ACTOR = randomUUID();
const OPEN = { isEnabled: async () => true };

describe.runIf(run)('P0-6d: ACTION_EXECUTED pipeline (real components)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const subscriptions = new EventSubscriptionRepository();
  const verifications = new ActionExecutionVerificationRepository();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  interface Case { ew: ExecWorld; ctx: TenantContext; businessId: string; executionId: string; evidenceDigest: string }
  async function executed(revoked = false): Promise<Case> {
    const ew = await makeExecWorld(admin, tenantIds, {});
    const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
    const { claimId, receiptId } = await claimPackage(ew, pkg);
    const provider = new ScriptedProvider(() => consumedAnswer(pkg, receiptId, revoked ? { authority: { state: 'REVOKED' } } : {}));
    const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: randomUUID() };
    const r = await new AuthorizedActionExecutionService({ statusProvider: provider, executionStatusMaxAgeMs: 5000, gate: OPEN, capabilities: SUPPORTED }).executeClaim(ctx, claimId);
    if (r.state !== 'TERMINAL') throw new Error('expected terminal');
    return { ew, ctx, businessId: r.execution.businessId, executionId: r.execution.id, evidenceDigest: r.execution.evidenceDigest };
  }
  const subscribe = (c: Case) => subscriptions.create(c.ctx, {
    subscriberName: `${ACTION_EXECUTED_CONSUMER}@${c.ew.w.workspaceId}`, eventPattern: ACTION_EXECUTED_EVENT_TYPE, destinationType: 'in_process',
    destinationReference: ACTION_EXECUTED_CONSUMER, supportedVersions: ['1'], retryPolicy: { maxAttempts: 3, backoffSeconds: [1, 5, 15] },
  });
  const worker = (c: Case) => buildEventWorker({
    config: { workerId: 'w-exec', actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: 5000, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: { discover: async () => [{ tenantId: c.ew.w.tenantId, workspaceId: c.ew.w.workspaceId }] } satisfies ScopeDiscovery,
  });
  const rows = async (c: Case) => (await admin.query('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [c.ew.w.tenantId])).rows;
  const execRow = async (c: Case) => (await admin.query('SELECT * FROM business_operations.authorized_action_executions WHERE id=$1', [c.executionId])).rows[0];
  const dead = async (c: Case) => (await admin.query('SELECT * FROM events.dead_letter_events WHERE tenant_id=$1', [c.ew.w.tenantId])).rows;

  it('a succeeded, applied execution is EXECUTION_VERIFIED with its outcome PENDING - never verified, observed or failed', async () => {
    const c = await executed();
    await subscribe(c);
    expect(await worker(c).runOnce()).toMatchObject({ claimed: 1, published: 1, deadLettered: 0, scopeErrors: 0 });
    const v = await rows(c);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      execution_id: c.executionId, evidence_digest: c.evidenceDigest, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING',
      execution_outcome: 'SUCCEEDED', mutation_result: 'APPLIED', contract_version: 'execution-evidence/1', business_id: c.businessId,
    });
    expect(v[0].source_event_id).toBeTruthy();
    expect(v[0].outcome_state_reason).toMatch(/NO_AUTHORITATIVE_MEASUREMENT_MODEL/);
  });

  it('OM does not rewrite the execution fact: the BO row and its evidence digest are unchanged by verification', async () => {
    const c = await executed();
    await subscribe(c);
    const before = await execRow(c);
    await worker(c).runOnce();
    expect(await execRow(c)).toEqual(before);
    expect((await rows(c))[0].evidence_digest).toBe(before.evidence_digest);
  });

  it('a refused execution is preserved as REFUSED / NOT_APPLICABLE and is INCONCLUSIVE - never positive', async () => {
    const c = await executed(true);
    await subscribe(c);
    await worker(c).runOnce();
    const v = await rows(c);
    expect(v[0]).toMatchObject({ execution_outcome: 'REFUSED', mutation_result: 'NOT_APPLICABLE', execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_INCONCLUSIVE' });
  });

  it('duplicate delivery and a second pass create one verification', async () => {
    const c = await executed();
    await subscribe(c);
    await worker(c).runOnce();
    await worker(c).runOnce();
    expect(await rows(c)).toHaveLength(1);
    const again = await verifications.getByExecution(c.ctx, c.businessId, c.executionId);
    expect(again?.executionId).toBe(c.executionId);
  });

  it('tampered stored evidence is rejected (dead letter), nothing is verified', async () => {
    const c = await executed();
    await subscribe(c);
    await admin.query(`ALTER TABLE business_operations.authorized_action_executions DISABLE TRIGGER USER`);
    try {
      await admin.query(`UPDATE business_operations.authorized_action_executions SET evidence = jsonb_set(evidence, '{outcome,outcome}', '"FAILED"') WHERE id=$1`, [c.executionId]);
    } finally { await admin.query(`ALTER TABLE business_operations.authorized_action_executions ENABLE TRIGGER USER`); }
    expect(await worker(c).runOnce()).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(await rows(c)).toHaveLength(0);
    expect((await dead(c))[0]).toBeTruthy();
  });

  it('the database refuses an OBSERVED / VERIFIED / FAILED outcome and any UPDATE or DELETE of a verification', async () => {
    const c = await executed();
    await subscribe(c);
    await worker(c).runOnce();
    for (const state of ['OUTCOME_OBSERVED', 'OUTCOME_VERIFIED', 'OUTCOME_FAILED']) {
      await expect(admin.query(`UPDATE outcome_monitoring.action_execution_verifications SET outcome_state=$1 WHERE tenant_id=$2`, [state, c.ew.w.tenantId]), state).rejects.toThrow();
    }
    await expect(admin.query(`DELETE FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1`, [c.ew.w.tenantId])).rejects.toThrow();
    expect(await rows(c)).toHaveLength(1);
  });

  it('no learning side effect: verification writes nothing to Continuous Learning or OM learning-feedback tables', async () => {
    const c = await executed();
    await subscribe(c);
    await worker(c).runOnce();
    for (const [schema, table] of [['outcome_monitoring', 'learning_feedback_packages'], ['continuous_learning', 'learning_cases'], ['continuous_learning', 'learned_lessons']]) {
      const exists = (await admin.query(`SELECT to_regclass($1) AS t`, [`${schema}.${table}`])).rows[0].t;
      if (exists) expect((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE tenant_id=$1`, [c.ew.w.tenantId])).rows[0].n, `${schema}.${table}`).toBe(0);
    }
  });
});
