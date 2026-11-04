/**
 * STRIPE-SBX-01-R1: the two billing subsystems that now coexist (POS2-02 entitlement store, migration 0225; STRIPE-SBX-01 provider links and event ledger, migration 0226)
 * on a fresh migrated PostgreSQL 16. Proves, through the real webhook route and the real EntitlementService, that Stripe processing can neither grant, revoke nor infer an
 * entitlement: billing state (what Stripe reports) stays separate from entitlement (what INFINICUS grants), and billing suspension still takes precedence.
 * Synthetic ids only; no Stripe account, no network. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, getPool, EntitlementRepository, ProviderBillingRepository, type TenantContext } from '@infinicus/database';
import { EntitlementService, SubscriptionSuspendedError, SubscriptionCanceledError, CapabilityNotEntitledError, type Capability } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;
const SECRET = 'whsec_' + 'C0existenceSecretForR1Only';
const DAY = 86_400_000;
let admin: Pool; let app: FastifyInstance; let appRole: string;
const links = new ProviderBillingRepository();
const service = new EntitlementService();
const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

async function governed<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try { await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function world(withSubscription = true): Promise<{ ctx: TenantContext; customer: string; subscription: string }> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uid('s');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Coexistence',$2,'active','test')`, [tenantId, `coex-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Coexistence WS',$3,'active')`, [workspaceId, tenantId, `coex-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId: randomUUID() };
  if (withSubscription) await service.startSubscription(ctx, 'free');
  const customer = uid('cus'); const subscription = uid('sub');
  await links.registerCustomer(ctx, 'stripe', customer); await links.registerSubscriptionLink(ctx, 'stripe', subscription, customer);
  return { ctx, customer, subscription };
}
const grant = (ctx: TenantContext, capability: string, sourceType = 'subscription') =>
  governed(ctx.tenantId, (c) => EntitlementRepository.grant(c, ctx.tenantId, { capability, sourceType: sourceType as never, sourceReference: `fx-${randomUUID()}`, effectiveFrom: new Date(Date.now() - DAY) }));
const rows = async (tenantId: string) => JSON.stringify((await admin.query('SELECT * FROM billing.entitlements WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows);
const status = async (tenantId: string) => (await admin.query('SELECT status FROM billing.subscriptions WHERE tenant_id = $1', [tenantId])).rows[0].status as string;
const holds = async (ctx: TenantContext, cap: Capability) => { try { await service.enforceCapability(ctx, cap); return true; } catch (e) { if (e instanceof CapabilityNotEntitledError) return false; throw e; } };

const ev = (type: string, object: Record<string, unknown>) => ({ id: uid('evt'), object: 'event', api_version: Stripe.API_VERSION, created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
async function post(body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) }, payload });
}
/** Metadata, product and price data that try to name a capability, a plan or a tier: none of it may ever be read. */
const tempting = { metadata: { capability: 'intelligence.pro', plan: 'Pro', tier: 'Growth', entitlements: 'pos.core,intelligence.pro' }, lines: { data: [{ price: { id: 'price_pro', product: 'prod_pro', nickname: 'INFINICUS Pro' } }] } };

describe.runIf(run)('STRIPE-SBX-01-R1 coexistence: Stripe processing vs the POS2-02 entitlement store (live PostgreSQL)', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', STRIPE_WEBHOOK_SECRET: SECRET });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    appRole = (await getPool().query('SELECT current_user AS u')).rows[0].u as string;
    app = await buildApp(config);
  });
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('both subsystems are present on the same database: the entitlement store, the provider tables and every governed function', async () => {
    const t = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'billing' AND table_name IN ('entitlements','provider_customers','provider_subscription_links','provider_events','subscriptions') ORDER BY 1`)).rows.map((r) => r.table_name);
    expect(t).toEqual(['entitlements', 'provider_customers', 'provider_events', 'provider_subscription_links', 'subscriptions']);
    const f = (await admin.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'billing' AND proname IN ('grant_entitlement','revoke_entitlement','claim_provider_event','finish_provider_event','resolve_provider_customer','check_provider_subscription_link','link_provider_subscription') ORDER BY 1`)).rows.map((r) => r.proname);
    expect(f).toHaveLength(7);
    const rls = (await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'billing' AND c.relname IN ('entitlements','provider_customers','provider_subscription_links','provider_events','subscriptions') ORDER BY 1`)).rows;
    expect(rls.every((r) => r.relrowsecurity === true && r.relforcerowsecurity === true)).toBe(true);
  });

  it('application privileges stay restricted after grant-app-role.sh: no entitlement writes or minting, no ledger writes; only the governed provider functions are callable', async () => {
    const p = (await admin.query(
      `SELECT has_table_privilege($1,'billing.entitlements','INSERT') ei, has_table_privilege($1,'billing.entitlements','UPDATE') eu, has_table_privilege($1,'billing.entitlements','DELETE') ed, has_table_privilege($1,'billing.entitlements','TRUNCATE') et,
              has_table_privilege($1,'billing.entitlements','SELECT') es,
              has_function_privilege($1,'billing.grant_entitlement(uuid, text, text, text, timestamptz, timestamptz)','EXECUTE') eg, has_function_privilege($1,'billing.revoke_entitlement(uuid, uuid)','EXECUTE') er,
              has_table_privilege($1,'billing.provider_events','INSERT') pi, has_table_privilege($1,'billing.provider_events','UPDATE') pu, has_table_privilege($1,'billing.provider_events','DELETE') pd, has_table_privilege($1,'billing.provider_events','TRUNCATE') pt,
              has_function_privilege($1,'billing.claim_provider_event(text,text,text,text)','EXECUTE') pc`, [appRole])).rows[0];
    expect(p).toEqual({ ei: false, eu: false, ed: false, et: false, es: true, eg: false, er: false, pi: false, pu: false, pd: false, pt: false, pc: true });
  });

  it('Stripe events never create, change or revoke an entitlement, and the tenant profile is identical before and after every one of them', async () => {
    const w = await world();
    await grant(w.ctx, 'pos.core'); await grant(w.ctx, 'intelligence.growth');
    const before = await rows(w.ctx.tenantId); const profileBefore = [...(await service.resolveProfile(w.ctx)).capabilities].sort();
    expect(profileBefore).toEqual(['intelligence.growth', 'pos.core']);

    const sequence = [
      ev('customer.subscription.created', { id: uid('sub'), customer: w.customer, status: 'active', ...tempting }),
      ev('checkout.session.completed', { id: uid('cs'), mode: 'subscription', customer: w.customer, subscription: w.subscription, ...tempting }),
      ev('invoice.payment_failed', { id: uid('in'), customer: w.customer, subscription: w.subscription, ...tempting }),
      ev('customer.subscription.updated', { id: w.subscription, customer: w.customer, status: 'past_due', ...tempting }),
      ev('invoice.paid', { id: uid('in'), customer: w.customer, subscription: w.subscription, ...tempting }),
      ev('customer.subscription.updated', { id: w.subscription, customer: w.customer, status: 'active', ...tempting }),
    ];
    for (const e of sequence) {
      const r = await post(e); expect(r.statusCode, e.type).toBe(200);
      expect(await rows(w.ctx.tenantId), `after ${e.type}`).toBe(before);
      expect([...(await service.resolveProfile(w.ctx)).capabilities].sort(), `profile after ${e.type}`).toEqual(profileBefore);
    }
    // product / price / metadata / plan names that name a tier or capability are never an authorization source
    expect(await holds(w.ctx, 'intelligence.pro')).toBe(false);
    expect(await holds(w.ctx, 'pos.core')).toBe(true);
    expect(await status(w.ctx.tenantId)).toBe('active'); // payment failed then paid: billing state moved and recovered, entitlement never moved
  });

  it('a tenant with no entitlement rows keeps today\'s compatibility behaviour, and Stripe events do not create rows for it', async () => {
    const w = await world();
    expect((await post(ev('invoice.payment_failed', { id: uid('in'), customer: w.customer, subscription: w.subscription, ...tempting }))).statusCode).toBe(200);
    expect(await status(w.ctx.tenantId)).toBe('grace_period');
    expect(await rows(w.ctx.tenantId)).toBe('[]');
    expect([...(await service.resolveProfile(w.ctx)).capabilities].length).toBeGreaterThan(5); // compatibility: a functional subscription holds the whole vocabulary
    expect(await holds(w.ctx, 'pos.core')).toBe(true); // grace period is still functional: warnings, not blocks
  });

  it('billing suspension takes precedence and is not an entitlement revocation: unpaid suspends access (402) while the entitlement rows are untouched', async () => {
    const w = await world(); await grant(w.ctx, 'pos.core');
    const before = await rows(w.ctx.tenantId);
    expect((await post(ev('customer.subscription.updated', { id: w.subscription, customer: w.customer, status: 'unpaid' }))).json().status).toBe('applied');
    expect(await status(w.ctx.tenantId)).toBe('suspended');
    await expect(service.enforceCapability(w.ctx, 'pos.core')).rejects.toBeInstanceOf(SubscriptionSuspendedError);
    expect(await rows(w.ctx.tenantId)).toBe(before);
  });

  it('a Stripe cancellation cancels the billing subscription (402) and leaves the entitlement history intact; it cannot revoke', async () => {
    const w = await world(); await grant(w.ctx, 'pos.core'); await grant(w.ctx, 'intelligence.growth');
    const before = await rows(w.ctx.tenantId);
    expect((await post(ev('customer.subscription.deleted', { id: w.subscription, customer: w.customer, status: 'canceled' }))).json().status).toBe('applied');
    await expect(service.enforceCapability(w.ctx, 'pos.core')).rejects.toBeInstanceOf(SubscriptionCanceledError);
    expect(await rows(w.ctx.tenantId)).toBe(before);
    expect(JSON.parse(before).every((r: { status: string }) => r.status !== 'revoked')).toBe(true);
  });

  it('a revoked or expired entitlement stays denied however Stripe reports payment: a paid invoice cannot resurrect it', async () => {
    const w = await world();
    const revoked = await grant(w.ctx, 'pos.inventory', 'add_on');
    await governed(w.ctx.tenantId, (c) => EntitlementRepository.revoke(c, w.ctx.tenantId, (revoked as { id: string }).id));
    await governed(w.ctx.tenantId, (c) => EntitlementRepository.grant(c, w.ctx.tenantId, { capability: 'pos.offline', sourceType: 'add_on' as never, sourceReference: `fx-${randomUUID()}`, effectiveFrom: new Date(Date.now() - 3 * DAY), effectiveUntil: new Date(Date.now() - DAY) } as never));
    await grant(w.ctx, 'pos.core');
    for (const e of [ev('invoice.paid', { id: uid('in'), customer: w.customer, subscription: w.subscription }), ev('invoice.paid', { id: uid('in'), customer: w.customer, subscription: w.subscription, ...tempting })]) expect((await post(e)).statusCode).toBe(200);
    expect(await holds(w.ctx, 'pos.inventory')).toBe(false); // revoked
    expect(await holds(w.ctx, 'pos.offline')).toBe(false); // expired
    expect(await holds(w.ctx, 'pos.core')).toBe(true);
    expect(await holds(w.ctx, 'pos.invented' as Capability)).toBe(false); // unknown capability
  });

  it('events for one tenant never touch another tenant\'s entitlements or billing state', async () => {
    const a = await world(); const b = await world(); await grant(a.ctx, 'pos.core'); await grant(b.ctx, 'pos.core');
    const bRows = await rows(b.ctx.tenantId); const bStatus = await status(b.ctx.tenantId);
    await post(ev('invoice.payment_failed', { id: uid('in'), customer: a.customer, subscription: a.subscription, metadata: { tenant_id: b.ctx.tenantId } }));
    await post(ev('customer.subscription.updated', { id: a.subscription, customer: a.customer, status: 'unpaid', metadata: { tenant_id: b.ctx.tenantId } }));
    expect(await rows(b.ctx.tenantId)).toBe(bRows); expect(await status(b.ctx.tenantId)).toBe(bStatus);
    expect(await status(a.ctx.tenantId)).toBe('suspended');
  });
});
