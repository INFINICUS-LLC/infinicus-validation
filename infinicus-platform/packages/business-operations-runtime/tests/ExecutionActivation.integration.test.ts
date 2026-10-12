/**
 * P0-6e - the governed activation record (migration 0195), its service and the gate, on real PostgreSQL.
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truncateRefusal } from './helpers/truncateRefusal.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventSubscriptionRepository, ExecutionCapabilityActivationRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import {
  EXECUTION_ACTIVATION_PERMISSION, ExecutionActivationError, ExecutionActivationService, GovernedExecutionGate, KILL_SWITCH_ENV, PRODUCTION_BO_CAPABILITIES,
  explicitCapabilities, killSwitchEngagedFrom,
} from '../src/index.js';
import { makeExecWorld, type ExecWorld } from './helpers/executionWorld.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };

describe('P0-6e kill switch (pure)', () => {
  it('absent or an explicit "off" is not engaged; anything else - including a typo - engages it (it can only remove capability)', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', ' OFF ']) expect(killSwitchEngagedFrom({ [KILL_SWITCH_ENV]: v }), String(v)).toBe(false);
    for (const v of ['1', 'true', 'on', 'engaged', 'yes', 'fasle', 'disable']) expect(killSwitchEngagedFrom({ [KILL_SWITCH_ENV]: v }), v).toBe(true);
  });
});

describe.runIf(run)('P0-6e: governed activation (real PostgreSQL)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const repo = new ExecutionCapabilityActivationRepository();
  const service = new ExecutionActivationService();
  const system = randomUUID();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  async function world(): Promise<{ ew: ExecWorld; ctx: TenantContext; businessId: string }> {
    const ew = await makeExecWorld(admin, tenantIds, {});
    return { ew, ctx: { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: randomUUID() }, businessId: ew.ctx.businessId };
  }
  const set = (w: { ctx: TenantContext; businessId: string }, state: 'ENABLED' | 'DISABLED', over: Record<string, unknown> = {}) =>
    service.setActivation(w.ctx, EXECUTION_ACTIVATION_PERMISSION, { businessId: w.businessId, actionType: ACTION, state, reason: 'test', correlationId: randomUUID(), ...over } as any);
  const gate = (over: { kill?: boolean; capabilities?: any } = {}) => new GovernedExecutionGate({ capabilities: over.capabilities ?? PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => over.kill === true, actorUserId: system });
  const scopeOf = (w: { ew: ExecWorld; businessId: string }) => ({ tenantId: w.ew.w.tenantId, workspaceId: w.ew.w.workspaceId, businessId: w.businessId });

  it('is CLOSED by default and for every shape of "no answer": no row, malformed scope, another business', async () => {
    const w = await world();
    expect(await repo.getCurrent(w.ctx, w.businessId, ACTION)).toBeNull();
    expect(await gate().isEnabled(scopeOf(w), ACTION)).toBe(false);
    expect(await gate().isEnabled({ ...scopeOf(w), businessId: 'not-a-uuid' }, ACTION)).toBe(false);
    expect(await gate().isEnabled({ ...scopeOf(w), businessId: randomUUID() }, ACTION)).toBe(false);
    expect(await gate().isEnabled(undefined as any, ACTION)).toBe(false);
  });

  it('opens only when all three keys agree: ENABLED row AND registry support AND kill switch not engaged', async () => {
    const w = await world();
    await set(w, 'ENABLED');
    expect(await gate().isEnabled(scopeOf(w), ACTION)).toBe(true);
    expect(await gate({ kill: true }).isEnabled(scopeOf(w), ACTION)).toBe(false); // key 3
    expect(await gate({ capabilities: explicitCapabilities([]) }).isEnabled(scopeOf(w), ACTION)).toBe(false); // key 1
    expect(await gate().isEnabled(scopeOf(w), { code: ACTION.code, schemaVersion: '2' })).toBe(false); // no wildcard on the version
    expect(await gate().isEnabled(scopeOf(w), { code: 'other_action', schemaVersion: '1' })).toBe(false);
    await set(w, 'DISABLED');
    expect(await gate().isEnabled(scopeOf(w), ACTION)).toBe(false); // key 2 removed
  });

  it('a gate that cannot read, or whose kill switch throws, is closed', async () => {
    const w = await world();
    await set(w, 'ENABLED');
    const throwing = new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => { throw new Error('boom'); }, actorUserId: system });
    expect(await throwing.isEnabled(scopeOf(w), ACTION)).toBe(false);
    const nonBoolean = new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: (() => undefined) as any, actorUserId: system });
    expect(await nonBoolean.isEnabled(scopeOf(w), ACTION)).toBe(false); // anything but an explicit "not engaged" is engaged
    const unreadable = new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: system, activations: { isEnabled: async () => { throw new Error('db down'); } } });
    expect(await unreadable.isEnabled(scopeOf(w), ACTION)).toBe(false);
    expect(() => new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: 'x' })).toThrow();
  });

  it('is append-only and version-chained: states are new rows; repeating the current state adds nothing; UPDATE, DELETE and TRUNCATE are refused for every role', async () => {
    const w = await world();
    expect((await set(w, 'ENABLED')).changed).toBe(true);
    expect((await set(w, 'ENABLED')).changed).toBe(false);
    expect((await set(w, 'DISABLED')).changed).toBe(true);
    expect((await set(w, 'DISABLED')).changed).toBe(false);
    expect((await set(w, 'ENABLED')).changed).toBe(true);
    expect((await repo.history(w.ctx, w.businessId, ACTION)).map((r) => `${r.version}:${r.state}`)).toEqual(['1:ENABLED', '2:DISABLED', '3:ENABLED']);
    await expect(admin.query(`UPDATE ${BO}.execution_capability_activations SET state='DISABLED' WHERE business_id=$1`, [w.businessId])).rejects.toThrow(/append-only/);
    await expect(admin.query(`DELETE FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.businessId])).rejects.toThrow(/append-only/);
    await expect(truncateRefusal(admin, `TRUNCATE ${BO}.execution_capability_activations`)).rejects.toThrow(/append-only/);
    // the chain cannot be forged: a skipped version, and a business outside the stated scope, are refused by the database
    await expect(admin.query(`INSERT INTO ${BO}.execution_capability_activations (tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version, version, state, actor_user_id, permission_code, reason) VALUES ($1,$2,$3,$4,$5,9,'ENABLED',$6,'bo:admin','x')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, ACTION.code, ACTION.schemaVersion, randomUUID()])).rejects.toThrow(/does not follow/);
    await expect(admin.query(`INSERT INTO ${BO}.execution_capability_activations (tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version, version, state, actor_user_id, permission_code, reason) VALUES ($1,$2,$3,$4,$5,1,'ENABLED',$6,'bo:admin','x')`, [w.ctx.tenantId, w.ctx.workspaceId, randomUUID(), ACTION.code, ACTION.schemaVersion, randomUUID()])).rejects.toThrow();
  });

  it('records who, under which permission, when (database clock) and why; every change is audited with the same facts', async () => {
    const w = await world();
    const { activation } = await set(w, 'ENABLED', { reason: 'pilot store' });
    expect(activation).toMatchObject({ businessId: w.businessId, actionType: ACTION, version: 1, state: 'ENABLED', actorUserId: w.ctx.userId, permissionCode: 'bo:admin', reason: 'pilot store' });
    expect(activation.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const audit = await admin.query(`SELECT actor_id, metadata, entity_id FROM audit.audit_events WHERE tenant_id=$1 AND action='bo.execution_activation.enabled'`, [w.ctx.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: w.ctx.userId, entity_id: activation.id });
    expect(audit.rows[0].metadata).toMatchObject({ actionType: 'inventory_reorder_policy_update@1', version: 1, state: 'ENABLED', permission: 'bo:admin', reason: 'pilot store' });
    await set(w, 'ENABLED'); // an unchanged state is not re-audited
    expect((await admin.query(`SELECT 1 FROM audit.audit_events WHERE tenant_id=$1 AND action LIKE 'bo.execution_activation.%'`, [w.ctx.tenantId])).rowCount).toBe(1);
  });

  it('is tenant-isolated: another tenant cannot read, enable or see the record', async () => {
    const a = await world();
    const b = await world();
    await set(a, 'ENABLED');
    expect(await repo.getCurrent(b.ctx, a.businessId, ACTION)).toBeNull();
    expect(await gate().isEnabled({ ...scopeOf(a), tenantId: b.ctx.tenantId, workspaceId: b.ctx.workspaceId }, ACTION)).toBe(false);
    await expect(set({ ctx: b.ctx, businessId: a.businessId }, 'ENABLED')).rejects.toMatchObject({ code: 'BUSINESS_NOT_IN_SCOPE' });
  });

  it('the service refuses a wrong permission, an unsupported type (to enable), a missing reason and a malformed request - and writes nothing', async () => {
    const w = await world();
    const bad = async (p: Promise<unknown>, code: string) => expect(await p.then(() => null, (e: unknown) => e)).toMatchObject({ name: 'ExecutionActivationError', code });
    await bad(service.setActivation(w.ctx, 'aba:admin', { businessId: w.businessId, actionType: ACTION, state: 'ENABLED', reason: 'x', correlationId: randomUUID() }), 'PERMISSION_INVALID');
    await bad(service.setActivation(w.ctx, 'platform:admin', { businessId: w.businessId, actionType: ACTION, state: 'ENABLED', reason: 'x', correlationId: randomUUID() }), 'PERMISSION_INVALID');
    await bad(set(w, 'ENABLED', { actionType: { code: 'other_action', schemaVersion: '1' } }), 'ACTION_TYPE_UNSUPPORTED');
    await bad(set(w, 'ENABLED', { actionType: { code: ACTION.code, schemaVersion: '2' } }), 'ACTION_TYPE_UNSUPPORTED');
    await bad(set(w, 'ENABLED', { reason: '   ' }), 'REASON_REQUIRED');
    await bad(set(w, 'ENABLED', { reason: 'x'.repeat(501) }), 'REASON_REQUIRED');
    await bad(set(w, 'MAYBE' as any), 'INVALID_REQUEST');
    expect(ExecutionActivationError.name).toBe('ExecutionActivationError');
    expect(await repo.getCurrent(w.ctx, w.businessId, ACTION)).toBeNull();
    expect((await admin.query(`SELECT 1 FROM events.event_subscriptions WHERE tenant_id=$1`, [w.ctx.tenantId])).rowCount).toBe(0); // a refusal provisions nothing
  });

  it('disabling is always allowed (it only removes capability), even for a type no longer in the registry', async () => {
    const w = await world();
    await set(w, 'ENABLED');
    const noRegistry = new ExecutionActivationService({ capabilities: explicitCapabilities([]) });
    const out = await noRegistry.setActivation(w.ctx, 'bo:admin', { businessId: w.businessId, actionType: ACTION, state: 'DISABLED', reason: 'retire', correlationId: randomUUID() });
    expect(out).toMatchObject({ changed: true, activation: { state: 'DISABLED', version: 2 } });
  });

  it('concurrent administrators cannot fork the chain: N parallel ENABLED requests produce one row', async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 8 }, () => set(w, 'ENABLED')));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await repo.history(w.ctx, w.businessId, ACTION)).toHaveLength(1);
  });

  it('subscription provisioning is idempotent and never adopts or overwrites a conflicting or foreign subscription', async () => {
    const w = await world();
    const subs = new EventSubscriptionRepository();
    const spec = { subscriberName: `om.execution_verification@${w.ctx.workspaceId}`, eventPattern: 'operations.action.executed', destinationType: 'in_process' as const, destinationReference: 'om.execution_verification', supportedVersions: ['1'], retryPolicy: { maxAttempts: 3, backoffSeconds: [1, 5, 15] } };
    expect((await subs.ensure(w.ctx, spec)).created).toBe(true);
    expect((await subs.ensure(w.ctx, spec)).created).toBe(false);
    await expect(subs.ensure(w.ctx, { ...spec, supportedVersions: ['2'] })).rejects.toThrow('SUBSCRIPTION_CONFLICT');
    const other = await world();
    await expect(subs.ensure(other.ctx, spec)).rejects.toThrow('SUBSCRIPTION_NAME_TAKEN'); // the name belongs to another scope
  });
});
