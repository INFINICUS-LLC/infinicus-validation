/**
 * Migration 0196 - database authority hardening (final-audit findings F1 and F3), proven on real PostgreSQL as the least-privilege application role.
 *
 *   F1  an execution capability can be enabled only through business_operations.record_execution_capability_activation()
 *   F3  reorder_point / reorder_quantity (and the reorder policy state) change only through business_operations.apply_inventory_reorder_policy()
 *
 * Requires DATABASE_URL (the application role, with the grant-app-role.sh provisioning applied) and ADMIN_DATABASE_URL (operator / function owner).
 * The "defence in depth" tests use a throw-away, fully privileged NOLOGIN role to prove the TRIGGERS refuse a direct write even when the privileges
 * are present and the old session variable (or the new marker) is set: only the function owner, inside the governed function, can write.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { EventSubscriptionRepository, ExecutionCapabilityActivationRepository, closePool, createPool } from '@infinicus/database';
import { executionPipelineSubscriptions } from '@infinicus/event-contracts';
import { ExecutionActivationService, GovernedExecutionGate, OperationalCommandExecutor, PRODUCTION_BO_CAPABILITIES } from '../src/index.js';
import { makeExecWorld, type ExecWorld } from './helpers/executionWorld.js';
import { seedAdminUser } from './helpers/activationAdmin.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const ACTION = { code: 'inventory_reorder_policy_update', schemaVersion: '1' };
const OLD_MARKER = 'configure_inventory_reorder_policy';
const NEW_REORDER_MARKER = 'apply_inventory_reorder_policy';
const NEW_ACTIVATION_MARKER = 'record_execution_capability_activation';
const ACTIVATE = `${BO}.record_execution_capability_activation`;
const APPLY = `${BO}.apply_inventory_reorder_policy`;

describe.runIf(run)('migration 0196: database authority hardening (F1 + F3), real PostgreSQL', () => {
  let admin: Pool;
  let app: Pool;
  const tenantIds: string[] = [];
  const roles: string[] = [];

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => {
    for (const r of roles) await admin.query(`DROP OWNED BY ${r}`).then(() => admin.query(`DROP ROLE IF EXISTS ${r}`)).catch(() => undefined);
    await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined);
    await app?.end(); await admin?.end(); await closePool();
  });

  const world = async (): Promise<{ ew: ExecWorld; t: string; ws: string; biz: string; actor: string }> => {
    const ew = await makeExecWorld(admin, tenantIds, {});
    return { ew, t: ew.w.tenantId, ws: ew.w.workspaceId, biz: ew.ctx.businessId, actor: await seedAdminUser(admin, ew.w.tenantId, ew.w.workspaceId) };
  };

  /** Runs `fn` in ONE transaction as `pool`'s role, scoped (RLS) to tenant/workspace; rolls back unless `commit`. */
  async function scoped<T>(pool: Pool, t: string, ws: string, fn: (c: PoolClient) => Promise<T>, o: { commit?: boolean; role?: string } = {}): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (o.role) await c.query(`SET LOCAL ROLE ${o.role}`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)`, [t, ws]);
      const out = await fn(c);
      await c.query(o.commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { c.release(); }
  }
  /** A refusal inside a scoped transaction (the statement fails; the transaction is rolled back). */
  const refused = (pool: Pool, t: string, ws: string, sql: string, args: unknown[] = [], o: { role?: string; pre?: string[] } = {}) =>
    scoped(pool, t, ws, async (c) => { for (const p of o.pre ?? []) await c.query(p); await c.query(sql, args); }, o.role ? { role: o.role } : {});

  /** A fully privileged role that is NOT the function owner: used to prove the triggers do not depend on missing privileges. */
  async function privilegedNonOwner(o: { execute?: boolean } = {}): Promise<string> {
    const name = `zz_authority_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.query(`CREATE ROLE ${name} NOLOGIN`);
    roles.push(name);
    await admin.query(`GRANT USAGE ON SCHEMA ${BO}, platform, audit, tenancy TO ${name}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${BO}.execution_capability_activations, ${BO}.inventory_balances, platform.businesses, audit.audit_events TO ${name}`);
    await admin.query(`GRANT SELECT ON tenancy.memberships, tenancy.membership_roles, tenancy.role_permissions, tenancy.permissions TO ${name}`);
    if (o.execute !== false) await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${BO} TO ${name}`);
    return name;
  }
  const directInsert = (w: { t: string; ws: string; biz: string; actor: string }, version = 1, state = 'ENABLED') => [
    `INSERT INTO ${BO}.execution_capability_activations (tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version, version, state, actor_user_id, permission_code, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'bo:admin','forged')`, [w.t, w.ws, w.biz, ACTION.code, ACTION.schemaVersion, version, state, w.actor]] as const;
  const activate = (c: PoolClient, w: { t: string; ws: string; biz: string; actor: string }, over: Partial<Record<string, unknown>> = {}) => {
    const a = { t: w.t, ws: w.ws, biz: w.biz, code: ACTION.code, ver: ACTION.schemaVersion, state: 'ENABLED', actor: w.actor, perm: 'bo:admin', reason: 'pilot', corr: randomUUID(), ...over };
    return c.query(`SELECT * FROM ${ACTIVATE}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.t, a.ws, a.biz, a.code, a.ver, a.state, a.actor, a.perm, a.reason, a.corr]);
  };
  const balance = async (id: string) => (await admin.query(`SELECT reorder_point::text rp, reorder_quantity::text rq, reorder_policy_state st, reorder_policy_configured_source src, version, quantity_on_hand::text qoh, updated_at, xmin::text xmin FROM ${BO}.inventory_balances WHERE id=$1`, [id])).rows[0];
  const apply = (c: PoolClient, w: { t: string; ws: string; biz: string; ew: ExecWorld }, point: unknown, qty: unknown, expected: [unknown, unknown], over: { source?: string; balance?: string } = {}) =>
    c.query(`SELECT * FROM ${APPLY}($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric)`, [w.t, w.ws, w.biz, over.balance ?? w.ew.balanceId, point, qty, over.source ?? 'BO_COMMAND', expected[0], expected[1]]);

  describe('F1 - execution capability activation', () => {
    it('the ordinary application role cannot INSERT, UPDATE, DELETE or TRUNCATE activation rows directly', async () => {
      const w = await world();
      const [sql, args] = directInsert(w);
      await expect(refused(app, w.t, w.ws, sql, [...args])).rejects.toThrow(/permission denied|record_execution_capability_activation/);
      await expect(refused(app, w.t, w.ws, `UPDATE ${BO}.execution_capability_activations SET state='ENABLED'`)).rejects.toThrow(/permission denied|append-only/);
      await expect(refused(app, w.t, w.ws, `DELETE FROM ${BO}.execution_capability_activations`)).rejects.toThrow(/permission denied|append-only/);
      await expect(truncateRefusal(app, `TRUNCATE ${BO}.execution_capability_activations`)).rejects.toThrow(/permission denied|append-only/);
      expect((await admin.query(`SELECT 1 FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.biz])).rowCount).toBe(0);
    });

    it('privileges alone are not the barrier: a fully privileged non-owner role is refused by the trigger even with the governed marker set', async () => {
      const w = await world();
      const role = await privilegedNonOwner();
      const [sql, args] = directInsert(w);
      await expect(refused(admin, w.t, w.ws, sql, [...args], { role })).rejects.toThrow(/record_execution_capability_activation/);
      await expect(refused(admin, w.t, w.ws, sql, [...args], { role, pre: [`SELECT set_config('app.bo_activation_writer','${NEW_ACTIVATION_MARKER}', true)`] })).rejects.toThrow(/record_execution_capability_activation/);
      expect((await admin.query(`SELECT 1 FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.biz])).rowCount).toBe(0);
    });

    it('the governed entry point succeeds for a valid authorized actor, appends the version chain and writes its audit row atomically; a repeated state is a no-op; DISABLED works', async () => {
      const w = await world();
      const r1 = await scoped(app, w.t, w.ws, async (c) => (await activate(c, w)).rows[0], { commit: true });
      expect(r1.out_changed).toBe(true);
      const again = await scoped(app, w.t, w.ws, async (c) => (await activate(c, w)).rows[0], { commit: true });
      expect(again).toMatchObject({ out_activation_id: r1.out_activation_id, out_changed: false });
      const off = await scoped(app, w.t, w.ws, async (c) => (await activate(c, w, { state: 'DISABLED', reason: 'pause' })).rows[0], { commit: true });
      expect(off.out_changed).toBe(true);
      expect((await admin.query(`SELECT version, state, actor_user_id, permission_code, reason FROM ${BO}.execution_capability_activations WHERE business_id=$1 ORDER BY version`, [w.biz])).rows)
        .toEqual([{ version: 1, state: 'ENABLED', actor_user_id: w.actor, permission_code: 'bo:admin', reason: 'pilot' }, { version: 2, state: 'DISABLED', actor_user_id: w.actor, permission_code: 'bo:admin', reason: 'pause' }]);
      const audit = await admin.query(`SELECT action, actor_type, actor_id, entity_id, metadata FROM audit.audit_events WHERE tenant_id=$1 AND action LIKE 'bo.execution_activation.%' ORDER BY occurred_at`, [w.t]);
      expect(audit.rows.map((a) => a.action)).toEqual(['bo.execution_activation.enabled', 'bo.execution_activation.disabled']);
      expect(audit.rows[0]).toMatchObject({ actor_type: 'user', actor_id: w.actor, entity_id: r1.out_activation_id });
      expect(audit.rows[0].metadata).toMatchObject({ actionType: 'inventory_reorder_policy_update@1', version: 1, state: 'ENABLED', permission: 'bo:admin', reason: 'pilot' });
      // history stays append-only for every role, including the operator
      await expect(admin.query(`UPDATE ${BO}.execution_capability_activations SET state='ENABLED' WHERE business_id=$1`, [w.biz])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.biz])).rejects.toThrow(/append-only/);
    });

    it('is refused for: the wrong permission, another tenant scope, a business outside the scope, an actor without membership, a non-admin role, a suspended member, an invalid state and a blank reason', async () => {
      const w = await world();
      const other = await world();
      const member = await seedAdminUser(admin, w.t, w.ws, 'member');   // bo:write, not bo:admin
      const viewer = await seedAdminUser(admin, w.t, w.ws, 'viewer');
      const suspended = await seedAdminUser(admin, w.t, w.ws);
      await admin.query(`UPDATE tenancy.memberships SET status='suspended' WHERE user_id=$1`, [suspended]);
      const stranger = randomUUID();
      const cases: [string, Partial<Record<string, unknown>>, RegExp][] = [
        ['wrong permission', { perm: 'platform:admin' }, /governed by bo:admin/],
        ['aba permission', { perm: 'aba:admin' }, /governed by bo:admin/],
        ['actor without membership', { actor: stranger }, /no active membership holding bo:admin/],
        ['member (no bo:admin)', { actor: member }, /no active membership holding bo:admin/],
        ['viewer (no bo:admin)', { actor: viewer }, /no active membership holding bo:admin/],
        ['suspended membership', { actor: suspended }, /no active membership holding bo:admin/],
        ['actor of ANOTHER workspace', { actor: other.actor }, /no active membership holding bo:admin/],
        ['business of another tenant', { biz: other.biz }, /does not belong to the stated tenant and workspace/],
        ['unknown business', { biz: randomUUID() }, /does not belong to the stated tenant and workspace/],
        ['invalid state', { state: 'ON' }, /state must be ENABLED or DISABLED/],
        ['blank reason', { reason: '   ' }, /a reason of 1 to 500 characters/],
        ['long reason', { reason: 'x'.repeat(501) }, /a reason of 1 to 500 characters/],
      ];
      for (const [name, over, re] of cases) {
        await expect(scoped(app, w.t, w.ws, (c) => activate(c, w, over)), name).rejects.toThrow(re);
      }
      // caller-provided scope cannot override the authoritative transaction scope
      await expect(scoped(app, w.t, w.ws, (c) => activate(c, other)), 'foreign tenant args').rejects.toThrow(/not the transaction scope/);
      await expect(scoped(app, other.t, other.ws, (c) => activate(c, w)), 'transaction scoped to another tenant').rejects.toThrow(/not the transaction scope/);
      await expect(scoped(app, w.t, w.ws, (c) => activate(c, w, { ws: other.ws })), 'foreign workspace arg').rejects.toThrow(/not the transaction scope/);
      for (const t of [w, other]) expect((await admin.query(`SELECT 1 FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [t.biz])).rowCount).toBe(0);
    });

    it('no row still means OFF: nothing was activated by the migration, the repository answers false, and even with every subscription valid the gate stays closed', async () => {
      const w = await world();
      const ctx = { tenantId: w.t, workspaceId: w.ws, userId: w.actor };
      const repo = new ExecutionCapabilityActivationRepository();
      expect((await admin.query(`SELECT 1 FROM ${BO}.execution_capability_activations WHERE business_id=$1`, [w.biz])).rowCount).toBe(0);
      expect(await new ExecutionActivationService().current(ctx, w.biz, ACTION)).toBeNull();
      expect(await repo.isEnabled(ctx, w.biz, ACTION)).toBe(false);
      const subs = new EventSubscriptionRepository();
      for (const spec of executionPipelineSubscriptions(w.ws)) await subs.ensure(ctx, spec);
      const gate = new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => false, actorUserId: w.actor });
      const scope = { tenantId: w.t, workspaceId: w.ws, businessId: w.biz };
      expect(await gate.isEnabled(scope, ACTION)).toBe(false);               // valid subscriptions + supported type + no kill switch, but NO activation row
      await new ExecutionActivationService().setActivation(ctx, 'bo:admin', { businessId: w.biz, actionType: ACTION, state: 'ENABLED', reason: 'pilot', correlationId: randomUUID() });
      expect(await repo.isEnabled(ctx, w.biz, ACTION)).toBe(true);
      expect(await gate.isEnabled(scope, ACTION)).toBe(true);
      await new ExecutionActivationService().setActivation(ctx, 'bo:admin', { businessId: w.biz, actionType: ACTION, state: 'DISABLED', reason: 'pause', correlationId: randomUUID() });
      expect(await repo.isEnabled(ctx, w.biz, ACTION)).toBe(false);
      expect(await gate.isEnabled(scope, ACTION)).toBe(false);
      expect(await new GovernedExecutionGate({ capabilities: PRODUCTION_BO_CAPABILITIES, killSwitchEngaged: () => true, actorUserId: w.actor }).isEnabled(scope, ACTION)).toBe(false); // the kill switch can only remove capability
    });
  });

  describe('F3 - inventory reorder fields', () => {
    const wr = async () => { const w = await world(); return { ...w, ew: w.ew }; };

    it('the application role cannot UPDATE reorder_point, reorder_quantity, both, or the policy state directly', async () => {
      const w = await wr();
      const before = await balance(w.ew.balanceId);
      for (const set of ['reorder_point = 999', 'reorder_quantity = 999', 'reorder_point = 999, reorder_quantity = 999', `reorder_policy_state = 'CONFIGURED', reorder_policy_configured_at = now(), reorder_policy_configured_source = 'BO_COMMAND'`]) {
        await expect(refused(app, w.t, w.ws, `UPDATE ${BO}.inventory_balances SET ${set} WHERE id=$1`, [w.ew.balanceId]), set).rejects.toThrow(/permission denied|apply_inventory_reorder_policy/);
      }
      expect(await balance(w.ew.balanceId)).toEqual(before);
    });

    it('the old session variable does NOT bypass the protection: SET, SET LOCAL and set_config of the old name, the new marker, and a fully privileged non-owner role are all refused', async () => {
      const w = await wr();
      const before = await balance(w.ew.balanceId);
      const upd = `UPDATE ${BO}.inventory_balances SET reorder_point = 999 WHERE id=$1`;
      for (const pre of [
        [`SET LOCAL app.bo_reorder_policy_writer = '${OLD_MARKER}'`],
        [`SELECT set_config('app.bo_reorder_policy_writer','${OLD_MARKER}', true)`],
        [`SELECT set_config('app.bo_reorder_policy_writer','${NEW_REORDER_MARKER}', true)`],
        [`SET app.bo_reorder_policy_writer = '${OLD_MARKER}'`],
      ]) {
        await expect(refused(app, w.t, w.ws, upd, [w.ew.balanceId], { pre }), pre[0]).rejects.toThrow(/permission denied|apply_inventory_reorder_policy/);
      }
      // privileges present (so the column privilege is NOT what stops it) + marker set, but not the function owner: the trigger refuses
      const role = await privilegedNonOwner();
      for (const marker of [OLD_MARKER, NEW_REORDER_MARKER]) {
        await expect(refused(admin, w.t, w.ws, upd, [w.ew.balanceId], { role, pre: [`SELECT set_config('app.bo_reorder_policy_writer','${marker}', true)`] }), marker).rejects.toThrow(/apply_inventory_reorder_policy/);
      }
      // and the operator connection (the function owner) is refused outside the governed function too
      await expect(admin.query(upd, [w.ew.balanceId])).rejects.toThrow(/apply_inventory_reorder_policy/);
      expect(await balance(w.ew.balanceId)).toEqual(before);
    });

    it('the governed function applies a real mutation exactly once: exact values, version +1, CONFIGURED with the source, nothing else touched', async () => {
      const w = await wr();
      const b0 = await balance(w.ew.balanceId);
      const out = await scoped(app, w.t, w.ws, async (c) => (await apply(c, w, '150.1234', '250', [100, 200], { source: 'AUTHORIZED_ACTION_PACKAGE' })).rows[0], { commit: true });
      expect(out).toMatchObject({ out_applied: true, out_reorder_point: '150.1234', out_reorder_quantity: '250.0000', out_reorder_policy_state: 'CONFIGURED', out_version: b0.version + 1 });
      const b1 = await balance(w.ew.balanceId);
      expect(b1).toMatchObject({ rp: '150.1234', rq: '250.0000', st: 'CONFIGURED', src: 'AUTHORIZED_ACTION_PACKAGE', version: b0.version + 1, qoh: b0.qoh });
    });

    it('NO_CHANGE is not an UPDATE and not a version bump; stale baselines change nothing', async () => {
      const w = await wr();
      await scoped(app, w.t, w.ws, (c) => apply(c, w, 150, 250, [100, 200]), { commit: true });
      const b1 = await balance(w.ew.balanceId);
      const same = await scoped(app, w.t, w.ws, async (c) => (await apply(c, w, 150, 250, [150, 250])).rows[0], { commit: true });
      expect(same).toMatchObject({ out_applied: false, out_version: b1.version });
      expect(await balance(w.ew.balanceId)).toEqual(b1); // same row version (xmin), updated_at and version: no UPDATE happened
      const stale = await scoped(app, w.t, w.ws, async (c) => (await apply(c, w, 300, 400, [100, 200])).rows, { commit: true });
      expect(stale).toEqual([]); // compare-and-set mismatch writes nothing
      const stalePoint = await scoped(app, w.t, w.ws, async (c) => (await apply(c, w, 300, 400, [999, 250])).rows, { commit: true });
      expect(stalePoint).toEqual([]); // only the reorder point differs from the caller baseline
      const staleQty = await scoped(app, w.t, w.ws, async (c) => (await apply(c, w, 300, 400, [150, 999])).rows, { commit: true });
      expect(staleQty).toEqual([]); // only the reorder quantity differs
      expect(await balance(w.ew.balanceId)).toEqual(b1);
    });

    it('refuses negative values, more than 4 decimal places, out-of-range values, an unknown source and a missing baseline - nothing rounded, nothing written', async () => {
      const w = await wr();
      const b0 = await balance(w.ew.balanceId);
      const cases: [string, unknown, unknown, [unknown, unknown], string | undefined, RegExp][] = [
        ['negative point', -1, 5, [100, 200], undefined, /must not be negative/],
        ['negative quantity', 5, -0.0001, [100, 200], undefined, /must not be negative/],
        ['5 decimals', '1.00001', 5, [100, 200], undefined, /at most 4 decimal places/],
        ['out of range', '100000000000000', 5, [100, 200], undefined, /storable range/],
        ['unknown source', 5, 5, [100, 200], 'MANUAL', /source must be/],
        ['missing baseline', 5, 5, [null, null], undefined, /every argument is required/],
      ];
      for (const [name, p, q, e, source, re] of cases) {
        await expect(scoped(app, w.t, w.ws, (c) => apply(c, w, p, q, e, source ? { source } : {})), name).rejects.toThrow(re);
      }
      expect(await balance(w.ew.balanceId)).toEqual(b0);
    });

    it('cannot cross tenant, workspace, business or balance: the stated scope must be the transaction scope and own the balance', async () => {
      const a = await wr();
      const b = await wr();
      const before = await balance(a.ew.balanceId);
      await expect(scoped(app, b.t, b.ws, (c) => apply(c, a, 1, 1, [100, 200])), 'A args inside B scope').rejects.toThrow(/not the transaction scope/);
      await expect(scoped(app, a.t, a.ws, (c) => apply(c, { ...a, t: b.t }, 1, 1, [100, 200])), 'B tenant arg inside A scope').rejects.toThrow(/not the transaction scope/);
      await expect(scoped(app, a.t, a.ws, (c) => apply(c, { ...a, biz: b.biz }, 1, 1, [100, 200])), 'foreign business').rejects.toThrow(/no such balance/);
      await expect(scoped(app, a.t, a.ws, (c) => apply(c, a, 1, 1, [100, 200], { balance: b.ew.balanceId })), 'foreign balance id').rejects.toThrow(/no such balance/);
      await expect(scoped(app, a.t, a.ws, (c) => apply(c, a, 1, 1, [100, 200], { balance: randomUUID() })), 'unknown balance').rejects.toThrow(/no such balance/);
      // direct cross-tenant statements see and change nothing (row-level security for the application role)
      expect(await scoped(app, b.t, b.ws, async (c) => (await c.query(`SELECT 1 FROM ${BO}.inventory_balances WHERE id=$1`, [a.ew.balanceId])).rowCount)).toBe(0);
      expect(await balance(a.ew.balanceId)).toEqual(before);
      expect((await balance(b.ew.balanceId)).rp).toBe('100.0000');
    });

    it('the BO executor path still works end to end through the governed function (CONFIGURED, source recorded, no-op re-send is not an UPDATE)', async () => {
      const w = await wr();
      const executor = new OperationalCommandExecutor();
      const ctx = { tenantId: w.t, workspaceId: w.ws, userId: w.actor };
      const item = (await admin.query(`SELECT inventory_item_id, warehouse_id FROM ${BO}.inventory_balances WHERE id=$1`, [w.ew.balanceId])).rows[0];
      const cmd = { type: 'configure_inventory_reorder_policy', context: { tenantId: w.t, workspaceId: w.ws, businessId: w.biz, correlationId: randomUUID(), sourceReference: 'hardening-test' },
        payload: { inventoryItemId: item.inventory_item_id, warehouseId: item.warehouse_id, reorderPoint: 12.5, reorderQuantity: 40, expectedBaseline: { reorderPoint: 100, reorderQuantity: 200 }, configurationSource: 'BO_COMMAND' } } as any;
      const { withTenantTransaction } = await import('@infinicus/database');
      const first = await withTenantTransaction(ctx, (client) => executor.configureInventoryReorderPolicy(client, ctx, cmd));
      expect(first).toMatchObject({ applied: true, after: { reorderPoint: '12.5', reorderQuantity: '40', state: 'CONFIGURED' } });
      const b1 = await balance(w.ew.balanceId);
      const second = await withTenantTransaction(ctx, (client) => executor.configureInventoryReorderPolicy(client, ctx, { ...cmd, payload: { ...cmd.payload, expectedBaseline: undefined } }));
      expect(second).toMatchObject({ applied: false });
      expect(await balance(w.ew.balanceId)).toEqual(b1);
    });

    it('the application role keeps its ordinary inventory rights (quantity movements) but holds no UPDATE on the protected reorder columns', async () => {
      const w = await wr();
      await scoped(app, w.t, w.ws, (c) => c.query(`UPDATE ${BO}.inventory_balances SET quantity_on_hand = 77, last_movement_at = now(), version = version + 1 WHERE id=$1`, [w.ew.balanceId]), { commit: true });
      expect((await balance(w.ew.balanceId)).qoh).toBe('77.0000');
      const privs = await app.query(
        `SELECT column_name, has_column_privilege(current_user, 'business_operations.inventory_balances', column_name, 'UPDATE') AS can_update
           FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='inventory_balances'
            AND column_name IN ('reorder_point','reorder_quantity','reorder_policy_state','reorder_policy_configured_at','reorder_policy_configured_source','quantity_on_hand','version')`);
      const can = Object.fromEntries(privs.rows.map((r) => [r.column_name, r.can_update]));
      expect(can).toEqual({ reorder_point: false, reorder_quantity: false, reorder_policy_state: false, reorder_policy_configured_at: false, reorder_policy_configured_source: false, quantity_on_hand: true, version: true });
      expect((await app.query(`SELECT has_table_privilege(current_user, 'business_operations.execution_capability_activations', 'INSERT') i, has_table_privilege(current_user, 'business_operations.execution_capability_activations', 'UPDATE') u, has_table_privilege(current_user, 'business_operations.execution_capability_activations', 'DELETE') d`)).rows[0]).toEqual({ i: false, u: false, d: false });
    });
  });

  describe('SECURITY DEFINER hygiene', () => {
    const fns = [ACTIVATE, APPLY];
    const sig = { [ACTIVATE]: 'uuid,uuid,uuid,text,text,text,uuid,text,text,uuid', [APPLY]: 'uuid,uuid,uuid,uuid,numeric,numeric,text,numeric,numeric' } as Record<string, string>;

    it('owner, definer flag, pinned search_path and no dynamic SQL; the table triggers pin the same owner and a pinned search_path', async () => {
      const me = (await admin.query('SELECT current_user u')).rows[0].u;
      for (const fn of fns) {
        const p = (await admin.query(`SELECT p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig, p.prosrc FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`${fn}(${sig[fn]})`])).rows[0];
        expect(p.prosecdef, fn).toBe(true);
        expect(p.owner, fn).toBe(me); // the migration / operator role; never the application role
        expect(p.proconfig, fn).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(p.prosrc, fn).not.toMatch(/\bEXECUTE\b\s+[^;]*(format|\|\|)|\bEXECUTE\s+'/i); // no dynamic SQL
      }
      for (const trg of [`${BO}.guard_execution_capability_activation_insert()`, `${BO}.enforce_reorder_policy_state_writer()`]) {
        const t = (await admin.query(`SELECT p.proconfig, p.prosecdef FROM pg_proc p WHERE p.oid = $1::regprocedure`, [trg])).rows[0];
        expect(t.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(t.prosecdef).toBe(false);
      }
      const appRole = (await app.query('SELECT current_user u')).rows[0].u;
      expect(appRole).not.toBe(me);
      expect((await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1`, [appRole])).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('EXECUTE is minimal: PUBLIC holds none, the application role holds it explicitly, and a role without it cannot call the functions even with every table privilege', async () => {
      for (const fn of fns) {
        const acl = (await admin.query(`SELECT coalesce(p.proacl::text, 'NULL') acl FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`${fn}(${sig[fn]})`])).rows[0].acl as string;
        expect(acl, fn).not.toBe('NULL');            // an explicit ACL exists (the default would leave EXECUTE with PUBLIC)
        expect(acl, fn).not.toMatch(/[{,]=X\//);      // no PUBLIC entry
        expect((await app.query(`SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') ok`, [`${fn}(${sig[fn]})`])).rows[0].ok, fn).toBe(true);
      }
      const w = await world();
      const role = await privilegedNonOwner({ execute: false });
      await expect(scoped(admin, w.t, w.ws, (c) => activate(c, w), { role }), 'activation').rejects.toThrow(/permission denied for function/);
      await expect(scoped(admin, w.t, w.ws, (c) => apply(c, { ...w, ew: w.ew }, 1, 1, [100, 200]), { role }), 'reorder').rejects.toThrow(/permission denied for function/);
    });

    it('a hostile search_path or a shadowing object created by the caller cannot hijack the function', async () => {
      const w = await world();
      const out = await scoped(app, w.t, w.ws, async (c) => {
        await c.query(`CREATE FUNCTION pg_temp.btrim(text) RETURNS text LANGUAGE sql AS $$ SELECT 'hijacked'::text $$`);
        await c.query(`CREATE FUNCTION pg_temp.length(text) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$`);
        await c.query(`SET LOCAL search_path = pg_temp, public`);
        return (await activate(c, w, { reason: '  padded reason  ' })).rows[0];
      }, { commit: true });
      expect(out.out_changed).toBe(true);
      expect((await admin.query(`SELECT reason FROM ${BO}.execution_capability_activations WHERE id=$1`, [out.out_activation_id])).rows[0].reason).toBe('padded reason');
    });

    it('arguments are values, never SQL: hostile text is stored verbatim and nothing else happens', async () => {
      const w = await world();
      const evil = `x'); DROP TABLE ${BO}.execution_capability_activations; --`;
      const out = await scoped(app, w.t, w.ws, async (c) => (await activate(c, w, { code: evil, ver: '1' })).rows[0], { commit: true });
      expect((await admin.query(`SELECT action_type_code FROM ${BO}.execution_capability_activations WHERE id=$1`, [out.out_activation_id])).rows[0].action_type_code).toBe(evil);
      expect((await admin.query(`SELECT to_regclass('${BO}.execution_capability_activations') r`)).rows[0].r).not.toBeNull();
    });

    it('the reorder function changes no unrelated column and the activation function touches no balance', async () => {
      const w = await world();
      const before = (await admin.query(`SELECT to_jsonb(b) - ARRAY['reorder_point','reorder_quantity','reorder_policy_state','reorder_policy_configured_at','reorder_policy_configured_source','version','updated_at'] j FROM ${BO}.inventory_balances b WHERE id=$1`, [w.ew.balanceId])).rows[0].j;
      await scoped(app, w.t, w.ws, (c) => apply(c, w, 9, 9, [100, 200]), { commit: true });
      const after = (await admin.query(`SELECT to_jsonb(b) - ARRAY['reorder_point','reorder_quantity','reorder_policy_state','reorder_policy_configured_at','reorder_policy_configured_source','version','updated_at'] j FROM ${BO}.inventory_balances b WHERE id=$1`, [w.ew.balanceId])).rows[0].j;
      expect(after).toEqual(before);
      const b1 = await balance(w.ew.balanceId);
      await scoped(app, w.t, w.ws, (c) => activate(c, w), { commit: true });
      expect(await balance(w.ew.balanceId)).toEqual(b1);
    });
  });
});
