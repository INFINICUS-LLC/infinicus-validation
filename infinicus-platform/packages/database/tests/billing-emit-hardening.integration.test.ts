/**
 * SEC-BILL-02B-1 (SF-3): the legacy BUILD-28 billing.emit_* SECURITY DEFINER functions (migration 0153) bypassed row-level security: a tenant-A application session could
 * write a pending outbox event in tenant B's name, with ANY event type (including the control-loop execution events the event worker dispatches), through a function that had
 * no pinned search_path and was executable by PUBLIC. Migration 0227 pins the search_path, confines the helper to billing.* event types, enforces the session's own tenant and
 * workspace, and revokes PUBLIC; the grant script withholds the internal helper from the application role.
 *
 * Live PostgreSQL 16, synthetic records only. Requires DATABASE_URL (application role, RLS enforced) and ADMIN_DATABASE_URL (fixtures and inspection).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, getPool, withTenantTransaction, PlanRepository, SubscriptionRepository, type TenantContext } from '../src/index.js';

const run = !!process.env.DATABASE_URL;
const HELPER = 'billing.emit_outbox_event(uuid,uuid,text,text,uuid,uuid,jsonb,text,uuid)';
const WRAPPERS = ['billing.emit_subscription_status_changed(uuid,uuid,uuid,text,text,uuid)', 'billing.emit_usage_limit_exceeded(uuid,uuid,text,bigint,bigint,uuid)'];
let admin: Pool; let appRole: string;
let A: TenantContext; let B: TenantContext;
const subscriptions = new SubscriptionRepository(); const plans = new PlanRepository();

const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
async function tenant(): Promise<TenantContext> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const s = sfx();
  await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'Emit Hardening',$2,'active','test')`, [tenantId, `emit-${s}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'Emit WS',$3,'active')`, [workspaceId, tenantId, `emit-ws-${s}`]);
  return { tenantId, workspaceId, userId: randomUUID() };
}
const outbox = async (tenantId: string) => (await admin.query(
  `SELECT event_type, event_version, workspace_id, payload, correlation_id, causation_id, aggregate_type, aggregate_id, status FROM events.outbox_events WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId])).rows;
const outboxCount = async (tenantId: string) => (await outbox(tenantId)).length;
/** Runs SQL as an application-role session that is scoped to `as` - exactly what a compromised or injected request session can do. */
async function asSession<T>(as: TenantContext, fn: (c: PoolClient) => Promise<T>): Promise<T> { return withTenantTransaction(as, fn); }
const callWrapper = (c: PoolClient, t: TenantContext, w: string) =>
  c.query('SELECT billing.emit_subscription_status_changed($1,$2,$3,$4,$5,$6) AS id', [t.tenantId, w, randomUUID(), 'active', 'suspended', randomUUID()]);
const callUsage = (c: PoolClient, t: TenantContext, w: string) =>
  c.query('SELECT billing.emit_usage_limit_exceeded($1,$2,$3,$4,$5,$6) AS id', [t.tenantId, w, 'simulation_runs', 20, 21, randomUUID()]);
const callHelper = (c: PoolClient, tenantId: string, workspaceId: string, type: string) =>
  c.query('SELECT billing.emit_outbox_event($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS id', [tenantId, workspaceId, type, '1.0', randomUUID(), null, JSON.stringify({ probe: true }), 'subscription', randomUUID()]);

describe.runIf(run)('SEC-BILL-02B-1 / SF-3: billing.emit_* hardening (live PostgreSQL)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    appRole = (await getPool().query('SELECT current_user AS u')).rows[0].u as string;
    A = await tenant(); B = await tenant();
  });
  afterAll(async () => { await admin.end(); await closePool(); });

  describe('catalog', () => {
    it('all three functions are SECURITY DEFINER with a pinned search_path and are not executable by PUBLIC', async () => {
      const r = await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'billing' AND p.proname IN ('emit_outbox_event','emit_subscription_status_changed','emit_usage_limit_exceeded') ORDER BY 1`);
      expect(r.rows).toHaveLength(3);
      for (const f of r.rows) {
        expect(f.prosecdef, f.proname).toBe(true);
        expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(f.acl ?? '', f.proname).not.toMatch(/(^|[{,])=X/);
      }
    });
    it('the application role can run the two wrappers its repositories call, but not the internal helper', async () => {
      const p = await admin.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS helper, has_function_privilege($1,$3,'EXECUTE') AS w1, has_function_privilege($1,$4,'EXECUTE') AS w2`, [appRole, HELPER, WRAPPERS[0], WRAPPERS[1]]);
      expect(p.rows[0]).toEqual({ helper: false, w1: true, w2: true });
    });
  });

  describe('a compromised application session cannot forge events in another tenant\'s name', () => {
    it('both wrappers refuse a foreign tenant (and a foreign workspace), writing nothing', async () => {
      const before = await outboxCount(B.tenantId); const beforeA = await outboxCount(A.tenantId);
      for (const call of [callWrapper, callUsage]) {
        await expect(asSession(A, (c) => call(c, B, B.workspaceId))).rejects.toThrow(/tenant scope mismatch/);
        await expect(asSession(A, (c) => call(c, A, B.workspaceId))).rejects.toThrow(/tenant scope mismatch/); // right tenant, another tenant's workspace
        await expect(asSession(A, (c) => call(c, B, A.workspaceId))).rejects.toThrow(/tenant scope mismatch/);
      }
      expect(await outboxCount(B.tenantId)).toBe(before); expect(await outboxCount(A.tenantId)).toBe(beforeA);
    });
    it('a session with no tenant context, or a malformed one, is refused (fail closed)', async () => {
      const before = await outboxCount(A.tenantId);
      await expect(getPool().query('SELECT billing.emit_usage_limit_exceeded($1,$2,$3,$4,$5,$6)', [A.tenantId, A.workspaceId, 'simulation_runs', 1, 2, randomUUID()])).rejects.toThrow(/tenant scope mismatch/);
      const c = await getPool().connect();
      try {
        await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id','not-a-uuid',true), set_config('app.workspace_id',$1,true)`, [A.workspaceId]);
        await expect(callUsage(c, A, A.workspaceId)).rejects.toThrow();
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
      expect(await outboxCount(A.tenantId)).toBe(before);
    });
    it('the internal helper is not callable by the application role at all, so it cannot mint any event type, including control-loop execution events', async () => {
      const before = await outboxCount(A.tenantId);
      for (const type of ['billing.subscription.status_changed', 'control_loop.action.authorized', 'operations.action.executed', 'operations.authorized_action.recovery_due']) {
        await expect(asSession(A, (c) => callHelper(c, A.tenantId, A.workspaceId, type)), type).rejects.toThrow(/permission denied/);
      }
      expect(await outboxCount(A.tenantId)).toBe(before);
    });
    it('a pg_temp function shadow cannot hijack the pinned function: a legitimate own-tenant call still works and the shadow never runs', async () => {
      const before = await outboxCount(A.tenantId);
      await asSession(A, async (c) => {
        await c.query('CREATE TEMP TABLE hijack_probe (who text)');
        await c.query(`CREATE FUNCTION pg_temp.now() RETURNS timestamptz LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO pg_temp.hijack_probe VALUES (current_user); RETURN pg_catalog.clock_timestamp(); END $f$`);
        await c.query('SET LOCAL search_path = pg_temp, pg_catalog');
        await callUsage(c, A, A.workspaceId);
        expect((await c.query('SELECT count(*)::int AS n FROM pg_temp.hijack_probe')).rows[0].n).toBe(0);
      });
      expect(await outboxCount(A.tenantId)).toBe(before + 1);
    });
  });

  describe('function-level containment holds even where a role does hold EXECUTE (defence in depth, administrator connection)', () => {
    async function asAdminScoped<T>(t: TenantContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [t.tenantId, t.workspaceId]);
        const out = await fn(c); await c.query('COMMIT'); return out;
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }
    it('the helper accepts only billing.* event types for the session\'s own tenant and workspace', async () => {
      const before = await outboxCount(A.tenantId);
      await asAdminScoped(A, (c) => callHelper(c, A.tenantId, A.workspaceId, 'billing.subscription.status_changed'));
      await asAdminScoped(A, (c) => callHelper(c, A.tenantId, A.workspaceId, 'billing.usage.limit_exceeded'));
      expect(await outboxCount(A.tenantId)).toBe(before + 2);
      for (const type of ['control_loop.action.authorized', 'operations.action.executed', 'operations.authorized_action.recovery_due', 'billing', 'billing.', 'billingx.event',
        'BILLING.event', 'billing.Event', 'billing.event\n', ' billing.event', 'billing..event', 'billing.event.', 'business_operations.publication.ready', '']) {
        await expect(asAdminScoped(A, (c) => callHelper(c, A.tenantId, A.workspaceId, type)), JSON.stringify(type)).rejects.toThrow(/event type not permitted/);
      }
      await expect(asAdminScoped(A, (c) => callHelper(c, B.tenantId, B.workspaceId, 'billing.subscription.status_changed'))).rejects.toThrow(/tenant scope mismatch/);
      await expect(asAdminScoped(A, (c) => callHelper(c, A.tenantId, B.workspaceId, 'billing.subscription.status_changed'))).rejects.toThrow(/tenant scope mismatch/);
      expect(await outboxCount(A.tenantId)).toBe(before + 2); expect(await outboxCount(B.tenantId)).toBe(0);
    });
  });

  describe('legitimate event delivery and the audit/outbox contracts are preserved', () => {
    it('creating and transitioning a subscription each emit exactly one billing.subscription.status_changed event with the unchanged shape; a no-op transition emits none', async () => {
      const T = await tenant();
      const plan = await plans.getByCode('free');
      const sub = await subscriptions.create(T, { planId: plan.id, trialDays: 0 });
      let rows = await outbox(T.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event_type: 'billing.subscription.status_changed', event_version: '1.0', workspace_id: T.workspaceId, correlation_id: sub.correlationId, causation_id: null, aggregate_type: 'subscription', aggregate_id: sub.id, status: 'pending' });
      expect(rows[0].payload).toEqual({ subscriptionId: sub.id, fromStatus: null, toStatus: 'active' });
      await subscriptions.transitionStatus(T, sub.id, 'grace_period', 'payment_failed', { gracePeriodEndsAt: new Date(Date.now() + 86_400_000) });
      rows = await outbox(T.tenantId);
      expect(rows).toHaveLength(2);
      expect(rows[1].payload).toEqual({ subscriptionId: sub.id, fromStatus: 'active', toStatus: 'grace_period' });
      await subscriptions.transitionStatus(T, sub.id, 'grace_period', 'repeat'); // idempotent no-op
      expect(await outboxCount(T.tenantId)).toBe(2);
      const history = await admin.query(`SELECT to_status FROM billing.subscription_status_history WHERE tenant_id = $1 ORDER BY occurred_at, id`, [T.tenantId]);
      expect(history.rows.map((h) => h.to_status)).toEqual(['active', 'grace_period']); // audit trail unchanged
    });
    it('the usage limit event keeps its shape, and concurrent emissions for two tenants never cross or duplicate', async () => {
      const T1 = await tenant(); const T2 = await tenant();
      const jobs = Array.from({ length: 8 }, (_, i) => asSession(i % 2 === 0 ? T1 : T2, (c) => callUsage(c, i % 2 === 0 ? T1 : T2, (i % 2 === 0 ? T1 : T2).workspaceId)));
      await Promise.all(jobs);
      const r1 = await outbox(T1.tenantId); const r2 = await outbox(T2.tenantId);
      expect(r1).toHaveLength(4); expect(r2).toHaveLength(4);
      for (const [rows, t] of [[r1, T1], [r2, T2]] as const) {
        for (const row of rows) {
          expect(row).toMatchObject({ event_type: 'billing.usage.limit_exceeded', event_version: '1.0', workspace_id: t.workspaceId, aggregate_type: 'usage_record', status: 'pending' });
          expect(row.payload).toEqual({ metric: 'simulation_runs', limitValue: 20, attemptedQuantity: 21 });
        }
      }
    });
    it('every other domain\'s event path is untouched: no billing function is the only SECURITY DEFINER emitter, and billing now has none without a pinned search_path', async () => {
      const unpinnedBilling = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'billing' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')`);
      expect(unpinnedBilling.rows).toEqual([]);
      const others = await admin.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname <> 'billing' AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')`);
      expect(others.rows[0].n).toBeGreaterThan(0); // wider function hardening is a separately authorized block (R8); it must not have been swept in
    });
  });
});
