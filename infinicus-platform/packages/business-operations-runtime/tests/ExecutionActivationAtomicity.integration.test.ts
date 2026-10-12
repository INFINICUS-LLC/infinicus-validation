/**
 * P0-6f - ACTIVATION / SUBSCRIPTION SAFETY on real PostgreSQL.
 *
 * Invariant: an activation is never observably ENABLED unless every required delivery subscription for its scope is already valid.
 * Proved two ways, both fail-closed (never "enabled now, repaired later"):
 *   A. atomicity - the ENABLED row, the subscription provisioning and their verification commit in ONE transaction; any failure rolls all of it back;
 *   C. runtime readiness - the gate itself requires both subscriptions to exist, be ACTIVE and be exactly the pinned ones, at every evaluation.
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventSubscriptionRepository, ExecutionCapabilityActivationRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { executionPipelineSubscriptions } from '@infinicus/event-contracts';
import { ExecutionActivationService, GovernedExecutionGate, PRODUCTION_BO_CAPABILITIES } from '../src/index.js';
import { makeExecWorld, type ExecWorld } from './helpers/executionWorld.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
const BO = 'business_operations';

describe.runIf(run)('P0-6f: an activation is never ENABLED without valid subscriptions (real PostgreSQL)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const activations = new ExecutionCapabilityActivationRepository();
  const subs = new EventSubscriptionRepository();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  interface W { ew: ExecWorld; ctx: TenantContext; businessId: string }
  async function world(): Promise<W> {
    const ew = await makeExecWorld(admin, tenantIds, {});
    return { ew, ctx: { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: randomUUID() }, businessId: ew.ctx.businessId };
  }
  const gate = () => new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: randomUUID() });
  const scope = (w: W) => ({ tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId });
  const enableWith = (w: W, deps: ConstructorParameters<typeof ExecutionActivationService>[0] = {}) =>
    new ExecutionActivationService(deps).setActivation(w.ctx, 'bo:admin', { businessId: w.businessId, actionType: ACTION, state: 'ENABLED', reason: 'atomicity', correlationId: randomUUID() });
  const subRows = async (w: W) => (await admin.query('SELECT subscriber_name, status FROM events.event_subscriptions WHERE tenant_id=$1 ORDER BY 1', [w.ctx.tenantId])).rows;
  const actRows = async (w: W) => (await admin.query(`SELECT version, state FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.businessId])).rows;
  const auditRows = async (w: W) => (await admin.query(`SELECT 1 FROM audit.audit_events WHERE tenant_id=$1 AND action LIKE 'bo.execution_activation.%'`, [w.ctx.tenantId])).rowCount;
  const spec = (w: W, i: 0 | 1 | 2) => executionPipelineSubscriptions(w.ctx.workspaceId)[i];

  /** After ANY failure: no activation row, no audit row, the gate is CLOSED. */
  async function expectClosed(w: W, opts: { subscriptions?: number } = {}) {
    expect(await actRows(w)).toEqual([]);
    expect(await auditRows(w)).toBe(0);
    expect(await activations.getCurrent(w.ctx, w.businessId, ACTION)).toBeNull();
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(false);
    if (opts.subscriptions !== undefined) expect(await subRows(w)).toHaveLength(opts.subscriptions);
  }
  const rejects = async (p: Promise<unknown>, expected: Record<string, unknown> | RegExp) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    if (expected instanceof RegExp) expect((e as Error).message).toMatch(expected); else expect(e).toMatchObject(expected);
  };

  it('success: the activation and ALL THREE subscriptions exist together, verified, and only then is the gate open', async () => {
    const w = await world();
    await enableWith(w);
    expect((await subRows(w)).map((r) => [r.subscriber_name, r.status])).toEqual([
      [`bo.authorized_action_intake@${w.ctx.workspaceId}`, 'active'], [`bo.authorized_action_recovery@${w.ctx.workspaceId}`, 'active'], [`om.execution_verification@${w.ctx.workspaceId}`, 'active'],
    ]);
    expect(await subs.verify(w.ctx, executionPipelineSubscriptions(w.ctx.workspaceId))).toBe(true);
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
  });

  it('the FIRST subscription cannot be created: nothing is enabled, nothing remains', async () => {
    const w = await world();
    let calls = 0;
    const failing = { ensureOnClient: async () => { calls += 1; throw new Error('connection lost'); }, verifyOnClient: async () => true };
    await rejects(enableWith(w, { subscriptions: failing as any }), /connection lost/);
    expect(calls).toBe(1);
    await expectClosed(w, { subscriptions: 0 });
  });

  it('the SECOND subscription cannot be created: the first is rolled back with the activation (all or nothing)', async () => {
    const w = await world();
    const real = new EventSubscriptionRepository();
    let calls = 0;
    const second = {
      ensureOnClient: async (c: any, ctx: any, s: any) => { calls += 1; if (calls === 2) throw new Error('disk full'); return real.ensureOnClient(c, ctx, s); },
      verifyOnClient: (c: any, specs: any) => real.verifyOnClient(c, specs),
    };
    await rejects(enableWith(w, { subscriptions: second as any }), /disk full/);
    expect(calls).toBe(2);
    await expectClosed(w, { subscriptions: 0 }); // the first subscription did NOT survive the failed activation
  });

  it('a CONFLICTING subscription of the same name is refused (409 class) - never adopted, never overwritten - and nothing is enabled', async () => {
    const w = await world();
    await subs.ensure(w.ctx, { ...spec(w, 1), supportedVersions: ['2'] }); // same name, different pin
    await rejects(enableWith(w), { name: 'ExecutionActivationError', code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(w, { subscriptions: 1 }); // only the pre-existing conflicting one; the correct first one was rolled back
    expect((await admin.query('SELECT supported_versions FROM events.event_subscriptions WHERE subscriber_name=$1', [spec(w, 1).subscriberName])).rows[0].supported_versions).toEqual(['2']);
  });

  it('a subscription that is PAUSED, DISABLED or FAILED is not valid: enabling is refused', async () => {
    for (const status of ['paused', 'disabled', 'failed'] as const) {
      const w = await world();
      const { id } = await subs.ensure(w.ctx, spec(w, 0));
      await admin.query('UPDATE events.event_subscriptions SET status=$2 WHERE id=$1', [id, status]);
      await rejects(enableWith(w), { code: 'SUBSCRIPTIONS_INVALID' });
      await expectClosed(w, { subscriptions: 1 });
    }
  });

  it('P0-6g: the claim-recovery subscription is required like the other two: a paused or conflicting one refuses enabling, and a missing one closes the gate', async () => {
    const paused = await world();
    const { id } = await subs.ensure(paused.ctx, spec(paused, 2));
    await admin.query('UPDATE events.event_subscriptions SET status=$2 WHERE id=$1', [id, 'paused']);
    await rejects(enableWith(paused), { code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(paused, { subscriptions: 1 });

    const conflicting = await world();
    await subs.ensure(conflicting.ctx, { ...spec(conflicting, 2), retryPolicy: { maxAttempts: 9, backoffSeconds: [1] } });
    await rejects(enableWith(conflicting), { code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(conflicting, { subscriptions: 1 });

    // an enabled business whose recovery subscription is later removed: the gate re-verifies at every evaluation and closes
    const w = await world();
    await enableWith(w);
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
    await admin.query('DELETE FROM events.event_subscriptions WHERE subscriber_name=$1', [spec(w, 2).subscriberName]);
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(false);
  });

  it('a subscription with a different retry policy is not the ruled one: enabling is refused', async () => {
    const w = await world();
    await subs.ensure(w.ctx, { ...spec(w, 0), retryPolicy: { maxAttempts: 9, backoffSeconds: [1] } });
    await rejects(enableWith(w), { code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(w, { subscriptions: 1 });
  });

  it('a FOREIGN-scope subscription holding the name (another tenant) is refused: the name is taken, nothing is enabled', async () => {
    const mine = await world();
    const other = await world();
    await subs.ensure(other.ctx, { ...spec(mine, 1) }); // the other tenant owns the platform-unique name
    await rejects(enableWith(mine), { code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(mine, { subscriptions: 0 });
    // and the other tenant's subscription is untouched
    expect(await subRows(other)).toHaveLength(1);
  });

  it('a failure AFTER provisioning (the audit write, or the verification) rolls back the activation AND the subscriptions', async () => {
    const w = await world();
    const brokenAudit = new ExecutionCapabilityActivationRepository();
    brokenAudit.recordAudit = async () => { throw new Error('audit store down'); };
    await rejects(enableWith(w, { activations: brokenAudit }), /audit store down/);
    await expectClosed(w, { subscriptions: 0 });

    const real = new EventSubscriptionRepository();
    const unverified = { ensureOnClient: (c: any, ctx: any, s: any) => real.ensureOnClient(c, ctx, s), verifyOnClient: async () => false };
    await rejects(enableWith(w, { subscriptions: unverified as any }), { code: 'SUBSCRIPTIONS_INVALID' });
    await expectClosed(w, { subscriptions: 0 });
  });

  it('a failed re-enable never disturbs a prior valid state; a failed first enable never leaves a half state', async () => {
    const w = await world();
    await enableWith(w);
    await new ExecutionActivationService().setActivation(w.ctx, 'bo:admin', { businessId: w.businessId, actionType: ACTION, state: 'DISABLED', reason: 'pause', correlationId: randomUUID() });
    const { id } = await subs.ensure(w.ctx, spec(w, 0));
    await admin.query(`UPDATE events.event_subscriptions SET status='paused' WHERE id=$1`, [id]);
    await rejects(enableWith(w), { code: 'SUBSCRIPTIONS_INVALID' });
    expect(await activations.getCurrent(w.ctx, w.businessId, ACTION)).toMatchObject({ state: 'DISABLED', version: 2 }); // still CLOSED
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(false);
  });

  it('repeated enable is idempotent; 8 concurrent enables of one business end with exactly one activation row, one valid subscription pair and an open gate', async () => {
    const w = await world();
    await enableWith(w); await enableWith(w);
    expect(await actRows(w)).toHaveLength(1);
    const c = await world();
    const results = await Promise.all(Array.from({ length: 8 }, () => enableWith(c)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await subRows(c)).toHaveLength(3);
    expect(await gate().isEnabled(scope(c), ACTION)).toBe(true);
  });

  it('RUNTIME readiness: after a valid enable, a subscription that is paused, removed or edited CLOSES the gate (fail closed), and restoring it reopens', async () => {
    const w = await world();
    await enableWith(w);
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
    const names = [spec(w, 0).subscriberName, spec(w, 1).subscriberName];
    for (const name of names) {
      await admin.query(`UPDATE events.event_subscriptions SET status='paused' WHERE subscriber_name=$1`, [name]);
      expect(await gate().isEnabled(scope(w), ACTION), `paused ${name}`).toBe(false);
      await admin.query(`UPDATE events.event_subscriptions SET status='active' WHERE subscriber_name=$1`, [name]);
      expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
      await admin.query(`UPDATE events.event_subscriptions SET destination_ref='elsewhere' WHERE subscriber_name=$1`, [name]);
      expect(await gate().isEnabled(scope(w), ACTION), `edited ${name}`).toBe(false);
      await admin.query(`UPDATE events.event_subscriptions SET destination_ref=$2 WHERE subscriber_name=$1`, [name, name.split('@')[0]]);
      expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
      await admin.query(`DELETE FROM events.event_subscriptions WHERE subscriber_name=$1`, [name]);
      expect(await gate().isEnabled(scope(w), ACTION), `removed ${name}`).toBe(false);
      await subs.ensure(w.ctx, executionPipelineSubscriptions(w.ctx.workspaceId).find((x) => x.subscriberName === name)!);
      expect(await gate().isEnabled(scope(w), ACTION)).toBe(true);
    }
  });

  it('subscription presence is not activation: both subscriptions without an ENABLED row leave the gate closed', async () => {
    const w = await world();
    for (const s of executionPipelineSubscriptions(w.ctx.workspaceId)) await subs.ensure(w.ctx, s);
    expect(await subs.verify(w.ctx, executionPipelineSubscriptions(w.ctx.workspaceId))).toBe(true);
    expect(await gate().isEnabled(scope(w), ACTION)).toBe(false);
  });

  it('a gate whose subscription read fails is closed', async () => {
    const w = await world();
    await enableWith(w);
    const unreadable = new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: randomUUID(), subscriptions: { verify: async () => { throw new Error('db down'); } } });
    expect(await unreadable.isEnabled(scope(w), ACTION)).toBe(false);
  });
});
