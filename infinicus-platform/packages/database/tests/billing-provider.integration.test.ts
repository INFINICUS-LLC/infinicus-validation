/**
 * STRIPE-SBX-01 (migration 0225): live PostgreSQL negative and security tests for provider identity and the durable event ledger.
 * Requires DATABASE_URL (application role, RLS enforced) and ADMIN_DATABASE_URL (fixtures, privileged tamper attempts). Disposable databases only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import {
  createPool, closePool, getPool, withTenantTransaction, SubscriptionRepository, PlanRepository,
  ProviderBillingRepository, ProviderLinkConflictError, ProviderLinkNotFoundError, ProviderInputError, type TenantContext,
} from '../src/index.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = !!process.env.DATABASE_URL;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

let admin: Pool;
let appRole: string;
const repo = new ProviderBillingRepository();
const tenantIds: string[] = [];

async function tenant(withSubscription = true): Promise<{ ctx: TenantContext; subscriptionId: string | null }> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const s = uid('t');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Provider Test',$2,'active','test')`, [tenantId, `prov-${s}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Provider WS',$3,'active')`, [workspaceId, tenantId, `prov-ws-${s}`]);
  tenantIds.push(tenantId);
  const ctx: TenantContext = { tenantId, workspaceId, userId: randomUUID() };
  let subscriptionId: string | null = null;
  if (withSubscription) subscriptionId = (await new SubscriptionRepository().create(ctx, { planId: (await new PlanRepository().getByCode('free')).id, trialDays: 0 })).id;
  return { ctx, subscriptionId };
}
const rejects = async (p: Promise<unknown>, pattern: RegExp) => { await expect(p).rejects.toThrow(pattern); };
/** Runs fn on the admin connection inside a transaction that is ALWAYS rolled back. */
async function rolledBack<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try { await c.query('BEGIN'); return await fn(c); } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}

describe.runIf(run)('STRIPE-SBX-01 migration 0225 - provider identity and event ledger (live PostgreSQL)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    appRole = (await getPool().query('SELECT current_user AS u')).rows[0].u as string;
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  });
  afterAll(async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const t of ['provider_events', 'provider_subscription_links', 'provider_customers']) await c.query(`DELETE FROM billing.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
      await c.query('COMMIT');
    } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    await admin.end(); await closePool();
  });

  describe('structure and hardening', () => {
    it('all three tables have ENABLED and FORCED row-level security with a tenant policy', async () => {
      const r = await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'billing' AND c.relname IN ('provider_customers','provider_subscription_links','provider_events') ORDER BY 1`);
      expect(r.rows.map((x) => [x.relname, x.relrowsecurity, x.relforcerowsecurity, Number(x.policies)])).toEqual([
        ['provider_customers', true, true, 1], ['provider_events', true, true, 1], ['provider_subscription_links', true, true, 1]]);
    });
    it('every function is SECURITY DEFINER with a pinned search_path (pg_catalog, pg_temp) and is not executable by PUBLIC', async () => {
      const r = await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'billing' AND p.proname IN ('claim_provider_event','finish_provider_event','resolve_provider_customer','check_provider_subscription_link','link_provider_subscription') ORDER BY 1`);
      expect(r.rows).toHaveLength(5);
      for (const f of r.rows) {
        expect(f.prosecdef, f.proname).toBe(true);
        expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(f.acl ?? '', f.proname).not.toMatch(/(^|[{,])=X/); // no PUBLIC grant
      }
      const guard = await admin.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'guard_provider_events'`);
      expect(guard.rows[0].acl ?? '').not.toMatch(/(^|[{,])=X/);
    });
    it('the application role can execute the governed functions but cannot write the ledger directly', async () => {
      const priv = await admin.query(`SELECT has_function_privilege($1, 'billing.claim_provider_event(text,text,text,text)', 'EXECUTE') AS e, has_table_privilege($1, 'billing.provider_events', 'INSERT') AS i,
        has_table_privilege($1, 'billing.provider_events', 'UPDATE') AS u, has_table_privilege($1, 'billing.provider_events', 'DELETE') AS d, has_table_privilege($1, 'billing.provider_events', 'TRUNCATE') AS t,
        has_table_privilege($1, 'billing.provider_events', 'SELECT') AS s`, [appRole]);
      expect(priv.rows[0]).toEqual({ e: true, i: false, u: false, d: false, t: false, s: true });
    });
  });

  describe('provider customers (the trust anchor)', () => {
    it('registers idempotently for the same tenant; the same provider customer id in another tenant is a non-disclosing conflict', async () => {
      const a = await tenant(); const b = await tenant(); const cus = uid('cus');
      expect(await repo.registerCustomer(a.ctx, 'stripe', cus)).toEqual({ created: true });
      expect(await repo.registerCustomer(a.ctx, 'stripe', cus)).toEqual({ created: false });
      await expect(repo.registerCustomer(b.ctx, 'stripe', cus)).rejects.toBeInstanceOf(ProviderLinkConflictError);
      // the same id under a different provider is a different identity
      expect(await repo.registerCustomer(b.ctx, 'otherpay', cus)).toEqual({ created: true });
    });
    it('row-level security: another tenant sees none of it and cannot insert a row for a tenant that is not its own', async () => {
      const a = await tenant(); const b = await tenant(); const cus = uid('cus');
      await repo.registerCustomer(a.ctx, 'stripe', cus);
      const seen = await withTenantTransaction(b.ctx, (c) => c.query('SELECT 1 FROM billing.provider_customers WHERE provider_customer_id = $1', [cus]));
      expect(seen.rowCount).toBe(0);
      await rejects(withTenantTransaction(b.ctx, (c) => c.query(`INSERT INTO billing.provider_customers (provider, provider_customer_id, tenant_id) VALUES ('stripe',$1,$2)`, [uid('cus'), a.ctx.tenantId])), /row-level security/i);
    });
    it('is append-only: update, delete and truncate are refused, even for the administrator', async () => {
      const a = await tenant(); const cus = uid('cus'); await repo.registerCustomer(a.ctx, 'stripe', cus);
      await rejects(admin.query(`UPDATE billing.provider_customers SET tenant_id = $2 WHERE provider_customer_id = $1`, [cus, randomUUID()]), /append-only/);
      await rejects(admin.query(`DELETE FROM billing.provider_customers WHERE provider_customer_id = $1`, [cus]), /append-only/);
      await rejects(truncateRefusal(admin, 'TRUNCATE billing.provider_customers CASCADE'), /append-only/);
    });
    it('rejects malformed identifiers before any SQL (no email-, name- or injection-shaped identity)', async () => {
      const a = await tenant();
      for (const bad of ['', 'a b', "x'; DROP TABLE billing.provider_events;--", 'person@example.com', 'x'.repeat(256), 'cus\n1']) {
        await expect(repo.registerCustomer(a.ctx, 'stripe', bad), JSON.stringify(bad)).rejects.toBeInstanceOf(ProviderInputError);
      }
      await expect(repo.registerCustomer(a.ctx, 'Stripe', uid('cus'))).rejects.toBeInstanceOf(ProviderInputError);
      await rejects(admin.query(`INSERT INTO billing.provider_customers (provider, provider_customer_id, tenant_id) VALUES ('stripe','bad id',$1)`, [a.ctx.tenantId]), /provider_customers_customer_id_check/);
    });
  });

  describe('provider subscription links', () => {
    it('several provider subscriptions per tenant are allowed; a provider subscription id is globally unique and idempotent for the same customer only', async () => {
      const a = await tenant(); const b = await tenant(); const cusA = uid('cus'); const cusB = uid('cus');
      await repo.registerCustomer(a.ctx, 'stripe', cusA); await repo.registerCustomer(b.ctx, 'stripe', cusB);
      const subs = [uid('sub'), uid('sub'), uid('sub')];
      for (const s of subs) expect(await repo.registerSubscriptionLink(a.ctx, 'stripe', s, cusA)).toEqual({ created: true });
      expect(await repo.registerSubscriptionLink(a.ctx, 'stripe', subs[0]!, cusA)).toEqual({ created: false });
      await expect(repo.registerSubscriptionLink(b.ctx, 'stripe', subs[0]!, cusB)).rejects.toBeInstanceOf(ProviderLinkConflictError); // collision with another tenant's subscription id
      expect(Number((await admin.query('SELECT count(*) n FROM billing.provider_subscription_links WHERE tenant_id = $1', [a.ctx.tenantId])).rows[0].n)).toBe(3);
    });
    it('cannot link to a customer that is not the caller tenant\'s own', async () => {
      const a = await tenant(); const b = await tenant(); const cusA = uid('cus'); await repo.registerCustomer(a.ctx, 'stripe', cusA);
      await expect(repo.registerSubscriptionLink(b.ctx, 'stripe', uid('sub'), cusA)).rejects.toBeInstanceOf(ProviderLinkNotFoundError);
      await expect(repo.registerSubscriptionLink(a.ctx, 'stripe', uid('sub'), uid('cus_missing'))).rejects.toBeInstanceOf(ProviderLinkNotFoundError);
    });
    it('composite keys pin tenant and provider: a link cannot reference another tenant\'s customer, another provider\'s customer, or another tenant\'s internal subscription', async () => {
      const a = await tenant(); const b = await tenant(); const cusA = uid('cus'); await repo.registerCustomer(a.ctx, 'stripe', cusA);
      const ref = (await admin.query('SELECT id FROM billing.provider_customers WHERE provider_customer_id = $1', [cusA])).rows[0].id as string;
      await rejects(admin.query(`INSERT INTO billing.provider_subscription_links (provider, provider_subscription_id, provider_customer_ref, tenant_id) VALUES ('stripe',$1,$2,$3)`, [uid('sub'), ref, b.ctx.tenantId]), /provider_subscription_links_customer_fk/);
      await rejects(admin.query(`INSERT INTO billing.provider_subscription_links (provider, provider_subscription_id, provider_customer_ref, tenant_id) VALUES ('otherpay',$1,$2,$3)`, [uid('sub'), ref, a.ctx.tenantId]), /provider_subscription_links_customer_fk/);
      await expect(repo.registerSubscriptionLink(a.ctx, 'stripe', uid('sub'), cusA, b.subscriptionId!)).rejects.toThrow(/provider_subscription_links_internal_fk/);
      expect(await repo.registerSubscriptionLink(a.ctx, 'stripe', uid('sub'), cusA, a.subscriptionId!)).toEqual({ created: true }); // its own internal subscription is fine
    });
    it('is append-only', async () => {
      const a = await tenant(); const cus = uid('cus'); const s = uid('sub'); await repo.registerCustomer(a.ctx, 'stripe', cus); await repo.registerSubscriptionLink(a.ctx, 'stripe', s, cus);
      await rejects(admin.query(`UPDATE billing.provider_subscription_links SET provider_subscription_id = 'sub_other' WHERE provider_subscription_id = $1`, [s]), /append-only/);
      await rejects(admin.query(`DELETE FROM billing.provider_subscription_links WHERE provider_subscription_id = $1`, [s]), /append-only/);
      await rejects(truncateRefusal(admin, 'TRUNCATE billing.provider_subscription_links'), /append-only/);
    });
  });

  describe('governed functions (webhook path, no tenant context)', () => {
    it('resolveCustomer returns only the tenant and billing workspace; unknown customers and tenants without a subscription resolve to nothing', async () => {
      const a = await tenant(); const none = await tenant(false); const cus = uid('cus'); const cusNone = uid('cus');
      await repo.registerCustomer(a.ctx, 'stripe', cus); await repo.registerCustomer(none.ctx, 'stripe', cusNone);
      expect(await repo.resolveCustomer('stripe', cus)).toEqual({ tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId });
      expect(await repo.resolveCustomer('stripe', uid('cus_unknown'))).toBeNull();
      expect(await repo.resolveCustomer('otherpay', cus)).toBeNull();
      expect(await repo.resolveCustomer('stripe', cusNone)).toBeNull();
    });
    it('linkSubscription derives the tenant from the trusted customer only, and reports LINKED / ALREADY_LINKED / MISMATCH / CUSTOMER_UNKNOWN', async () => {
      const a = await tenant(); const b = await tenant(); const cusA = uid('cus'); const cusB = uid('cus'); const s = uid('sub');
      await repo.registerCustomer(a.ctx, 'stripe', cusA); await repo.registerCustomer(b.ctx, 'stripe', cusB);
      expect(await repo.checkSubscriptionLink('stripe', s, cusA)).toBe('UNLINKED');
      expect(await repo.linkSubscription('stripe', s, cusA)).toBe('LINKED');
      expect(await repo.linkSubscription('stripe', s, cusA)).toBe('ALREADY_LINKED');
      expect(await repo.linkSubscription('stripe', s, cusB)).toBe('MISMATCH');
      expect(await repo.linkSubscription('stripe', uid('sub'), uid('cus_unknown'))).toBe('CUSTOMER_UNKNOWN');
      expect(await repo.checkSubscriptionLink('stripe', s, cusA)).toBe('MATCH');
      expect(await repo.checkSubscriptionLink('stripe', s, cusB)).toBe('MISMATCH');
      const row = (await admin.query('SELECT tenant_id FROM billing.provider_subscription_links WHERE provider_subscription_id = $1', [s])).rows[0];
      expect(row.tenant_id).toBe(a.ctx.tenantId);
    });
  });

  describe('event ledger', () => {
    it('claim -> finish -> duplicate; a failed event is re-claimed with the attempt count incremented; identity collisions are reported', async () => {
      const id = uid('evt'); const h = hash(id);
      expect(await repo.claimEvent('stripe', id, 'invoice.paid', h)).toEqual({ outcome: 'CLAIMED', attemptCount: 1 });
      expect((await repo.claimEvent('stripe', id, 'invoice.paid', h)).outcome).toBe('IN_PROGRESS'); // fresh claim held
      expect((await repo.claimEvent('stripe', id, 'invoice.paid', hash('other'))).outcome).toBe('CONFLICT');
      expect((await repo.claimEvent('stripe', id, 'invoice.payment_failed', h)).outcome).toBe('CONFLICT');
      expect(await repo.finishEvent('stripe', id, 'failed', 'CUSTOMER_UNLINKED', null)).toBe(true);
      expect(await repo.finishEvent('stripe', id, 'failed', 'CUSTOMER_UNLINKED', null)).toBe(false); // no longer claimed
      expect(await repo.claimEvent('stripe', id, 'invoice.paid', h)).toEqual({ outcome: 'CLAIMED', attemptCount: 2 });
      expect(await repo.finishEvent('stripe', id, 'processed', 'PAYMENT_PAID_APPLIED', null)).toBe(true);
      expect((await repo.claimEvent('stripe', id, 'invoice.paid', h)).outcome).toBe('DUPLICATE');
      expect((await repo.claimEvent('stripe', id, 'invoice.paid', hash('other'))).outcome).toBe('CONFLICT'); // even after success
      const row = (await admin.query('SELECT state, attempt_count, processed_at, result_code FROM billing.provider_events WHERE event_id = $1', [id])).rows[0];
      expect(row.state).toBe('processed'); expect(row.attempt_count).toBe(2); expect(row.processed_at).not.toBeNull(); expect(row.result_code).toBe('PAYMENT_PAID_APPLIED');
    });
    it('a crashed attempt (claim older than five minutes) is re-claimed; a fresh claim is not', async () => {
      const id = uid('evt'); const h = hash(id);
      await repo.claimEvent('stripe', id, 'invoice.paid', h);
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = 'replica'`); await c.query(`UPDATE billing.provider_events SET last_attempt_at = now() - interval '6 minutes' WHERE event_id = $1`, [id]); await c.query('COMMIT'); } finally { c.release(); }
      expect(await repo.claimEvent('stripe', id, 'invoice.paid', h)).toEqual({ outcome: 'CLAIMED', attemptCount: 2 });
      expect((await repo.claimEvent('stripe', id, 'invoice.paid', h)).outcome).toBe('IN_PROGRESS');
    });
    it('only one of many concurrent claims wins', async () => {
      const id = uid('evt'); const h = hash(id);
      const outcomes = (await Promise.all(Array.from({ length: 8 }, () => repo.claimEvent('stripe', id, 'invoice.paid', h)))).map((r) => r.outcome);
      expect(outcomes.filter((o) => o === 'CLAIMED')).toHaveLength(1);
      expect(outcomes.filter((o) => o !== 'CLAIMED').every((o) => o === 'IN_PROGRESS')).toBe(true);
      expect(Number((await admin.query('SELECT count(*) n FROM billing.provider_events WHERE event_id = $1', [id])).rows[0].n)).toBe(1);
    });
    it('the ledger cannot be written outside the governed functions: not by the application role, not by the administrator, not with the marker alone as another role', async () => {
      const id = uid('evt'); await repo.claimEvent('stripe', id, 'invoice.paid', hash(id));
      // administrator (the function owner) without the governed function's marker
      await rejects(admin.query(`INSERT INTO billing.provider_events (provider, event_id, event_type, payload_hash) VALUES ('stripe',$1,'invoice.paid',$2)`, [uid('evt'), hash('x')]), /written only by the governed billing functions/);
      await rejects(admin.query(`UPDATE billing.provider_events SET state = 'processed', result_code = 'FORGED_OK', processed_at = now() WHERE event_id = $1`, [id]), /written only by the governed billing functions/);
      // the application role has no table privilege at all
      await rejects(withTenantTransaction({ tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() }, (c) => c.query(`INSERT INTO billing.provider_events (provider, event_id, event_type, payload_hash) VALUES ('stripe',$1,'invoice.paid',$2)`, [uid('evt'), hash('y')])), /permission denied/);
      // marker set by a caller who is not the function owner: the privilege is granted for the test only, and the trigger still refuses
      await rolledBack(async (c) => {
        await c.query(`GRANT INSERT ON billing.provider_events TO "${appRole}"`);
        await c.query(`SET LOCAL ROLE "${appRole}"`); await c.query(`SELECT set_config('billing.provider_event_writer','on',true)`);
        await rejects(c.query(`INSERT INTO billing.provider_events (provider, event_id, event_type, payload_hash) VALUES ('stripe',$1,'invoice.paid',$2)`, [uid('evt'), hash('z')]), /written only by the governed billing functions/);
      });
    });
    it('even through the governed marker, identity is immutable, a processed event is final, rows are never deleted, and the state machine is closed', async () => {
      const id = uid('evt'); const h = hash(id); await repo.claimEvent('stripe', id, 'invoice.paid', h);
      const withMarker = async (sql: string, params: unknown[] = []) => rolledBack(async (c) => { await c.query(`SELECT set_config('billing.provider_event_writer','on',true)`); return c.query(sql, params); });
      await rejects(withMarker(`UPDATE billing.provider_events SET payload_hash = $2 WHERE event_id = $1`, [id, hash('tampered')]), /identity is immutable/);
      await rejects(withMarker(`UPDATE billing.provider_events SET event_type = 'invoice.payment_failed' WHERE event_id = $1`, [id]), /identity is immutable/);
      await rejects(withMarker(`UPDATE billing.provider_events SET event_id = 'evt_renamed' WHERE event_id = $1`, [id]), /identity is immutable/);
      await rejects(withMarker(`DELETE FROM billing.provider_events WHERE event_id = $1`, [id]), /append-only/);
      await rejects(truncateRefusal(admin, 'TRUNCATE billing.provider_events'), /append-only/); // refused regardless of any marker
      await repo.finishEvent('stripe', id, 'processed', 'PAYMENT_PAID_APPLIED', null);
      await rejects(withMarker(`UPDATE billing.provider_events SET state = 'failed', result_code = 'REOPENED', processed_at = NULL WHERE event_id = $1`, [id]), /processed event is final/);
      await rejects(withMarker(`INSERT INTO billing.provider_events (provider, event_id, event_type, payload_hash, state, attempt_count, result_code, processed_at) VALUES ('stripe',$1,'invoice.paid',$2,'processed',1,'PAYMENT_PAID_APPLIED',now())`, [uid('evt'), hash('pre')]), /created claimed with attempt 1/);
    });
    it('rejects malformed identifiers, codes and event types; only closed result-code shapes are accepted', async () => {
      const h = hash('x');
      for (const [p, e, t, hh] of [['Stripe', 'evt_1', 'invoice.paid', h], ['stripe', 'evt 1', 'invoice.paid', h], ['stripe', 'evt_1', 'Invoice Paid', h], ['stripe', 'evt_1', 'invoice.paid', 'nothex']] as const) {
        await expect(repo.claimEvent(p, e, t, hh), `${p}|${e}|${t}`).rejects.toBeInstanceOf(ProviderInputError);
      }
      const id = uid('evt'); await repo.claimEvent('stripe', id, 'invoice.paid', hash(id));
      for (const bad of ['lowercase', 'HAS SPACE', 'AB', "X'; DROP", 'A'.repeat(65)]) await expect(repo.finishEvent('stripe', id, 'failed', bad, null)).rejects.toBeInstanceOf(ProviderInputError);
      await rejects(admin.query(`SELECT billing.finish_provider_event('stripe',$1,'deleted','FIXED_CODE',NULL)`, [id]), /invalid state/);
    });
    it('a tenant session sees only its own resolved events; unresolved events are visible to no tenant', async () => {
      const a = await tenant(); const b = await tenant(); const mine = uid('evt'); const open = uid('evt');
      await repo.claimEvent('stripe', mine, 'invoice.paid', hash(mine)); await repo.finishEvent('stripe', mine, 'processed', 'PAYMENT_PAID_APPLIED', a.ctx.tenantId);
      await repo.claimEvent('stripe', open, 'invoice.paid', hash(open)); await repo.finishEvent('stripe', open, 'failed', 'CUSTOMER_UNLINKED', null);
      const q = (ctx: TenantContext) => withTenantTransaction(ctx, async (c) => (await c.query('SELECT event_id FROM billing.provider_events WHERE event_id = ANY($1)', [[mine, open]])).rows.map((r) => r.event_id));
      expect(await q(a.ctx)).toEqual([mine]); expect(await q(b.ctx)).toEqual([]);
    });
  });
});
