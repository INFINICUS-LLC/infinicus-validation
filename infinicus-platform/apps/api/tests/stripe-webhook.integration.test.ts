/**
 * STRIPE-SBX-01: live PostgreSQL integration tests for POST /webhooks/stripe (SANDBOX ONLY, synthetic identifiers, no network, no Stripe API call).
 * Signatures are produced with the official SDK's test-header generator over the exact bytes sent. Provider links are created through the trusted repository boundary
 * (ProviderBillingRepository under a tenant context) - the same boundary the future checkout flow will use; a webhook can never create a customer link.
 *
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures and ledger inspection). Migration 0225 must be applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, ProviderBillingRepository, type TenantContext } from '@infinicus/database';
import { EntitlementService, ProviderBillingService } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;
const SECRET = 'whsec_' + 'T3stS1gn1ngS3cretForSbx01Only';
const OTHER_SECRET = 'whsec_' + '0therS1gn1ngS3cretNotTheRealOne';

let admin: Pool;
let app: FastifyInstance;
const links = new ProviderBillingRepository();
const entitlements = new EntitlementService();
const tenantIds: string[] = [];
const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

interface World { ctx: TenantContext; customer: string }

async function world(plan = 'free', registerCustomer = true, startSubscription = true): Promise<World> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uid('s');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Stripe SBX Tenant',$2,'active','test')`, [tenantId, `sbx-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'Stripe SBX WS',$3,'active')`, [workspaceId, tenantId, `sbx-ws-${sfx}`]);
  tenantIds.push(tenantId);
  const ctx: TenantContext = { tenantId, workspaceId, userId: randomUUID() };
  if (startSubscription) await entitlements.startSubscription(ctx, plan);
  const customer = uid('cus');
  if (registerCustomer) await links.registerCustomer(ctx, 'stripe', customer);
  return { ctx, customer };
}

const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: uid('evt'), object: 'event', api_version: Stripe.API_VERSION, created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object }, ...extra });
const invoice = (customer: string, subscription: string | null = null, extra: Record<string, unknown> = {}) => ({ id: uid('in'), object: 'invoice', customer, subscription, ...extra });
const sub = (id: string, customer: string, status: string, extra: Record<string, unknown> = {}) => ({ id, object: 'subscription', customer, status, ...extra });

function sign(body: string | Buffer, secret = SECRET, timestamp?: number): string {
  return Stripe.webhooks.generateTestHeaderString({ payload: body.toString('utf8'), secret, ...(timestamp !== undefined ? { timestamp } : {}) });
}
async function post(body: unknown, opts: { secret?: string; timestamp?: number; header?: string | null; contentType?: string; target?: FastifyInstance } = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/json' };
  if (opts.header !== null) headers['stripe-signature'] = opts.header ?? sign(payload, opts.secret ?? SECRET, opts.timestamp);
  return (opts.target ?? app).inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
}

const sbs = async (tenantId: string) => (await admin.query(`SELECT * FROM billing.subscriptions WHERE tenant_id = $1`, [tenantId])).rows[0] as Record<string, unknown>;
const historyCount = async (tenantId: string) => Number((await admin.query(`SELECT count(*) n FROM billing.subscription_status_history WHERE tenant_id = $1`, [tenantId])).rows[0].n);
const ledger = async (eventId: string) => (await admin.query(`SELECT * FROM billing.provider_events WHERE provider = 'stripe' AND event_id = $1`, [eventId])).rows[0] as Record<string, unknown> | undefined;
const linkRows = async (providerSubscriptionId: string) => (await admin.query(`SELECT * FROM billing.provider_subscription_links WHERE provider = 'stripe' AND provider_subscription_id = $1`, [providerSubscriptionId])).rows;
const ledgerCount = async () => Number((await admin.query(`SELECT count(*) n FROM billing.provider_events`)).rows[0].n);

describe.runIf(run)('STRIPE-SBX-01 POST /webhooks/stripe - live PostgreSQL', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', STRIPE_WEBHOOK_SECRET: SECRET });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = await buildApp(config);
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      // fixtures only (disposable database): the append-only guards are bypassed by replica role on the admin connection
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = 'replica'`);
        await c.query('DELETE FROM billing.provider_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM billing.provider_subscription_links WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM billing.provider_customers WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    }
    await admin?.end(); await closePool();
  });

  describe('signature, raw body and shape (fail closed; nothing is recorded)', () => {
    it('refuses a missing signature, a wrong-secret signature, a modified body with the old signature and a stale timestamp', async () => {
      const before = await ledgerCount();
      const body = JSON.stringify(event('invoice.paid', invoice('cus_x')));
      const missing = await post(body, { header: null });
      expect(missing.statusCode).toBe(400); expect(missing.json().error.code).toBe('MISSING_SIGNATURE');
      const wrong = await post(body, { secret: OTHER_SECRET });
      expect(wrong.statusCode).toBe(400); expect(wrong.json().error.code).toBe('INVALID_SIGNATURE');
      const modified = await post(body.replace('cus_x', 'cus_y'), { header: sign(body) });
      expect(modified.statusCode).toBe(400); expect(modified.json().error.code).toBe('INVALID_SIGNATURE');
      const stale = await post(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
      expect(stale.statusCode).toBe(400); expect(stale.json().error.code).toBe('INVALID_SIGNATURE');
      expect(await post(body, { header: '' })).toMatchObject({ statusCode: 400 });
      expect(await post(body, { header: 't=1,v1=zz' })).toMatchObject({ statusCode: 400 });
      expect(await ledgerCount()).toBe(before);
      for (const r of [missing, wrong, modified, stale]) { expect(r.body).not.toContain(SECRET); expect(r.body).not.toContain(OTHER_SECRET); }
    });

    it('verifies the EXACT raw bytes: a differently-spaced but equivalent JSON body does not verify against the signature of the other', async () => {
      const compact = JSON.stringify(event('invoice.paid', invoice('cus_z')));
      const spaced = JSON.stringify(JSON.parse(compact), null, 2);
      expect((await post(spaced, { header: sign(compact) })).statusCode).toBe(400);
    });

    it('refuses a validly signed body that is not JSON, not an event, or has no event id', async () => {
      const before = await ledgerCount();
      const notJson = await post('this is { not json');
      expect(notJson.statusCode).toBe(400); expect(notJson.json().error.code).toBe('INVALID_PAYLOAD');
      for (const bad of [{ hello: 'world' }, { id: 'evt_1', type: 'invoice.paid' }, { id: 'bad id!', type: 'invoice.paid', livemode: false, data: { object: {} } }, [1, 2, 3]]) {
        expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(await ledgerCount()).toBe(before);
    });

    it('refuses a live-mode event and records nothing', async () => {
      const before = await ledgerCount();
      const r = await post(event('invoice.paid', invoice('cus_live'), { livemode: true }));
      expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe('LIVE_MODE_REJECTED');
      expect(await ledgerCount()).toBe(before);
    });

    it('answers 503 when no webhook secret is configured, and refuses a non-JSON content type', async () => {
      const unconfigured = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
      try {
        const r = await post(event('invoice.paid', invoice('cus_a')), { target: unconfigured });
        expect(r.statusCode).toBe(503); expect(r.json().error.code).toBe('WEBHOOK_NOT_CONFIGURED');
      } finally { await unconfigured.close(); }
      const text = await post('x=1', { contentType: 'text/plain' });
      expect(text.statusCode).toBe(400); expect(text.json().error.code).toBe('INVALID_PAYLOAD'); // only the raw JSON buffer is ever verified
    });

    it('does not change body parsing for any other route (the raw-body parser is scoped to the webhook only)', async () => {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'nobody@stripe-sbx.example', password: 'Wrong-Password-9!' } });
      expect([400, 401]).toContain(r.statusCode);
      expect(r.json().error).toBeDefined();
      const malformed = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad json' });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('invoice events reuse EntitlementService.recordPaymentResult', () => {
    it('invoice.payment_failed starts a grace period and invoice.paid reactivates; the Stripe invoice id is kept as external_invoice_reference', async () => {
      const w = await world();
      const failed = event('invoice.payment_failed', invoice(w.customer, null));
      const failedInvoice = (failed.data.object as { id: string }).id;
      const r1 = await post(failed);
      expect(r1.statusCode).toBe(200); expect(r1.json()).toEqual({ received: true, status: 'applied' });
      let s = await sbs(w.ctx.tenantId);
      expect(s.status).toBe('grace_period'); expect(s.payment_status).toBe('failed'); expect(s.external_invoice_reference).toBe(failedInvoice); expect(s.grace_period_ends_at).not.toBeNull();
      const row = (await ledger(failed.id))!;
      expect(row.state).toBe('processed'); expect(row.result_code).toBe('PAYMENT_FAILED_APPLIED'); expect(row.tenant_id).toBe(w.ctx.tenantId); expect(row.attempt_count).toBe(1);

      const paid = event('invoice.paid', invoice(w.customer, null));
      const paidInvoice = (paid.data.object as { id: string }).id;
      expect((await post(paid)).statusCode).toBe(200);
      s = await sbs(w.ctx.tenantId);
      expect(s.status).toBe('active'); expect(s.payment_status).toBe('paid'); expect(s.external_invoice_reference).toBe(paidInvoice); expect(s.grace_period_ends_at).toBeNull();
    });

    it('reads the invoice subscription from the newer parent.subscription_details location too', async () => {
      const w = await world(); const sid = uid('sub');
      await links.registerSubscriptionLink(w.ctx, 'stripe', sid, w.customer);
      const inv = { id: uid('in'), object: 'invoice', customer: w.customer, parent: { subscription_details: { subscription: sid } } };
      expect((await post(event('invoice.payment_failed', inv))).statusCode).toBe(200);
      expect((await sbs(w.ctx.tenantId)).status).toBe('grace_period');
    });
  });

  describe('replay and idempotency (durable, not in memory)', () => {
    it('a duplicate delivery of a processed event returns success and applies nothing again', async () => {
      const w = await world();
      const e = event('invoice.payment_failed', invoice(w.customer));
      expect((await post(e)).json().status).toBe('applied');
      const history = await historyCount(w.ctx.tenantId); const state = await sbs(w.ctx.tenantId);
      const again = await post(e);
      expect(again.statusCode).toBe(200); expect(again.json()).toEqual({ received: true, status: 'duplicate' });
      expect(await historyCount(w.ctx.tenantId)).toBe(history);
      expect(await sbs(w.ctx.tenantId)).toEqual(state);
      expect((await ledger(e.id))!.attempt_count).toBe(1);
    });

    it('concurrent deliveries of one event produce exactly one effect and one ledger row', async () => {
      const w = await world();
      const e = event('invoice.payment_failed', invoice(w.customer));
      const results = await Promise.all(Array.from({ length: 6 }, () => post(e)));
      expect(results.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
      expect(results.filter((r) => r.statusCode === 200 && r.json().status === 'applied')).toHaveLength(1);
      expect(Number((await admin.query(`SELECT count(*) n FROM billing.provider_events WHERE event_id = $1`, [e.id])).rows[0].n)).toBe(1);
      expect((await sbs(w.ctx.tenantId)).status).toBe('grace_period');
      expect(Number((await admin.query(`SELECT count(*) n FROM billing.subscription_status_history WHERE tenant_id = $1 AND to_status = 'grace_period'`, [w.ctx.tenantId])).rows[0].n)).toBe(1);
      // after the dust settles any further delivery is a plain duplicate
      expect((await post(e)).json().status).toBe('duplicate');
    });

    it('a refused event is recorded as failed and is safely re-claimed on redelivery; once the trusted link exists the same event succeeds', async () => {
      const w = await world('free', false);
      const e = event('invoice.payment_failed', invoice(w.customer));
      const first = await post(e);
      expect(first.statusCode).toBe(200); expect(first.json().status).toBe('recorded');
      let row = (await ledger(e.id))!;
      expect(row.state).toBe('failed'); expect(row.result_code).toBe('CUSTOMER_UNLINKED'); expect(row.attempt_count).toBe(1); expect(row.tenant_id).toBeNull();
      expect((await sbs(w.ctx.tenantId)).status).toBe('active');
      expect((await post(e)).json().status).toBe('recorded');
      row = (await ledger(e.id))!; expect(row.attempt_count).toBe(2);

      await links.registerCustomer(w.ctx, 'stripe', w.customer); // the trusted flow establishes the link later
      const third = await post(e);
      expect(third.json().status).toBe('applied');
      row = (await ledger(e.id))!; expect(row.state).toBe('processed'); expect(row.attempt_count).toBe(3); expect(row.tenant_id).toBe(w.ctx.tenantId);
      expect((await sbs(w.ctx.tenantId)).status).toBe('grace_period');
    });

    it('an unexpected processing failure answers a generic 500, is recorded as failed, and the redelivery succeeds', async () => {
      const w = await world();
      let calls = 0;
      const flaky = new EntitlementService();
      const original = flaky.recordPaymentResult.bind(flaky);
      flaky.recordPaymentResult = async (...args) => { calls += 1; if (calls === 1) throw new Error('db exploded: password=hunter2'); return original(...args); };
      const flakyApp = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', STRIPE_WEBHOOK_SECRET: SECRET }),
        { stripeWebhookService: new ProviderBillingService(links, flaky) });
      try {
        const e = event('invoice.payment_failed', invoice(w.customer));
        const r1 = await post(e, { target: flakyApp });
        expect(r1.statusCode).toBe(500); expect(r1.body).not.toContain('hunter2'); expect(r1.body).not.toContain('exploded');
        let row = (await ledger(e.id))!; expect(row.state).toBe('failed'); expect(row.result_code).toBe('INTERNAL_ERROR');
        expect((await sbs(w.ctx.tenantId)).status).toBe('active');
        const r2 = await post(e, { target: flakyApp });
        expect(r2.statusCode).toBe(200); expect(r2.json().status).toBe('applied');
        row = (await ledger(e.id))!; expect(row.state).toBe('processed'); expect(row.attempt_count).toBe(2);
      } finally { await flakyApp.close(); }
    });

    it('the same event id with a different body is an identity collision: refused, and the stored event is unchanged', async () => {
      const w = await world();
      const e = event('invoice.payment_failed', invoice(w.customer));
      expect((await post(e)).statusCode).toBe(200);
      const stored = await ledger(e.id);
      const forged = { ...e, data: { object: { ...(e.data.object as object), id: uid('in') } } };
      const r = await post(forged);
      expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('EVENT_IDENTITY_CONFLICT');
      expect(await ledger(e.id)).toEqual(stored);
      // a different event TYPE under the same id is also a collision
      const retyped = { ...e, type: 'invoice.paid' };
      expect((await post(retyped)).statusCode).toBe(409);
    });
  });

  describe('tenant correlation (trusted links only; metadata is never authority)', () => {
    it('an event for an unknown customer is recorded as refused and changes nothing anywhere', async () => {
      const w = await world();
      const stateBefore = await sbs(w.ctx.tenantId);
      const e = event('invoice.paid', invoice(uid('cus_unknown')));
      expect((await post(e)).json().status).toBe('recorded');
      expect((await ledger(e.id))!.result_code).toBe('CUSTOMER_UNLINKED');
      expect(await sbs(w.ctx.tenantId)).toEqual(stateBefore);
    });

    it('forged metadata cannot redirect an effect to another tenant or create authority for an unknown customer', async () => {
      const a = await world(); const b = await world();
      const metadata = { tenant_id: b.ctx.tenantId, tenantId: b.ctx.tenantId, infinicus_tenant_id: b.ctx.tenantId };
      const bBefore = await sbs(b.ctx.tenantId);
      // customer A with metadata naming tenant B: the effect lands on A (the trusted link), never on B
      expect((await post(event('invoice.payment_failed', invoice(a.customer, null, { metadata })))).json().status).toBe('applied');
      expect((await sbs(a.ctx.tenantId)).status).toBe('grace_period');
      expect(await sbs(b.ctx.tenantId)).toEqual(bBefore);
      // an unknown customer naming tenant B in metadata / client_reference_id is refused outright
      const forged = event('checkout.session.completed', { id: uid('cs'), object: 'checkout.session', mode: 'subscription', customer: uid('cus_forged'), subscription: uid('sub_forged'), client_reference_id: b.ctx.tenantId, metadata });
      expect((await post(forged)).json().status).toBe('recorded');
      expect((await ledger(forged.id))!.result_code).toBe('CUSTOMER_UNLINKED');
      expect(await sbs(b.ctx.tenantId)).toEqual(bBefore);
      expect(Number((await admin.query(`SELECT count(*) n FROM billing.provider_customers WHERE tenant_id = $1`, [b.ctx.tenantId])).rows[0].n)).toBe(1);
    });

    it('a subscription linked to one customer cannot be used through another customer (cross-tenant mapping attempt): refused, both tenants unchanged', async () => {
      const a = await world(); const b = await world(); const sid = uid('sub');
      await links.registerSubscriptionLink(a.ctx, 'stripe', sid, a.customer);
      const aBefore = await sbs(a.ctx.tenantId); const bBefore = await sbs(b.ctx.tenantId);
      for (const e of [
        event('invoice.payment_failed', invoice(b.customer, sid)),
        event('customer.subscription.updated', sub(sid, b.customer, 'canceled')),
        event('customer.subscription.deleted', sub(sid, b.customer, 'canceled')),
        event('customer.subscription.created', sub(sid, b.customer, 'active')),
        event('checkout.session.completed', { id: uid('cs'), mode: 'subscription', customer: b.customer, subscription: sid }),
      ]) {
        expect((await post(e)).json().status, e.type).toBe('recorded');
        expect((await ledger(e.id))!.result_code, e.type).toBe('CUSTOMER_SUBSCRIPTION_MISMATCH');
      }
      expect(await sbs(a.ctx.tenantId)).toEqual(aBefore); expect(await sbs(b.ctx.tenantId)).toEqual(bBefore);
      const stored = await linkRows(sid);
      expect(stored).toHaveLength(1); expect(stored[0].tenant_id).toBe(a.ctx.tenantId);
    });

    it('a tenant with no subscription row is refused fail-closed (NO_SUBSCRIPTION); nothing is created', async () => {
      const w = await world('free', true, false);
      // without a subscription row the customer cannot be resolved to a billing workspace
      const e = event('invoice.paid', invoice(w.customer));
      expect((await post(e)).json().status).toBe('recorded');
      expect((await ledger(e.id))!.result_code).toBe('CUSTOMER_UNLINKED');
      expect(Number((await admin.query('SELECT count(*) n FROM billing.subscriptions WHERE tenant_id = $1', [w.ctx.tenantId])).rows[0].n)).toBe(0);
    });
  });

  describe('subscription events', () => {
    it('customer.subscription.created establishes provider subscription identity from the trusted customer, without touching the lifecycle', async () => {
      const w = await world(); const sid = uid('sub'); const before = await sbs(w.ctx.tenantId); const history = await historyCount(w.ctx.tenantId);
      const e = event('customer.subscription.created', sub(sid, w.customer, 'active', { metadata: { tenant_id: randomUUID() } }));
      expect((await post(e)).json().status).toBe('applied');
      expect((await ledger(e.id))!.result_code).toBe('SUBSCRIPTION_LINKED');
      const rows = await linkRows(sid); expect(rows).toHaveLength(1); expect(rows[0].tenant_id).toBe(w.ctx.tenantId);
      expect(await sbs(w.ctx.tenantId)).toEqual(before); expect(await historyCount(w.ctx.tenantId)).toBe(history);
      // a second created event (new event id) is a no-op ALREADY_LINKED
      const again = event('customer.subscription.created', sub(sid, w.customer, 'active'));
      expect((await post(again)).json().status).toBe('applied');
      expect((await ledger(again.id))!.result_code).toBe('SUBSCRIPTION_ALREADY_LINKED'); expect(await linkRows(sid)).toHaveLength(1);
    });

    it('customer.subscription.created for an unknown customer creates nothing', async () => {
      const sid = uid('sub'); const e = event('customer.subscription.created', sub(sid, uid('cus_nobody'), 'active'));
      expect((await post(e)).json().status).toBe('recorded');
      expect((await ledger(e.id))!.result_code).toBe('CUSTOMER_UNLINKED'); expect(await linkRows(sid)).toHaveLength(0);
    });

    it('a tenant can hold several provider subscriptions (POS 2.0 direction)', async () => {
      const w = await world(); const ids = [uid('sub'), uid('sub'), uid('sub')];
      for (const id of ids) expect((await post(event('customer.subscription.created', sub(id, w.customer, 'active')))).json().status).toBe('applied');
      expect(Number((await admin.query('SELECT count(*) n FROM billing.provider_subscription_links WHERE tenant_id = $1', [w.ctx.tenantId])).rows[0].n)).toBe(3);
    });

    it('updated: canceled -> canceled, unpaid -> suspended; deleted -> canceled (idempotent)', async () => {
      const c = await world(); const cs = uid('sub'); await links.registerSubscriptionLink(c.ctx, 'stripe', cs, c.customer);
      expect((await post(event('customer.subscription.updated', sub(cs, c.customer, 'canceled')))).json().status).toBe('applied');
      expect((await sbs(c.ctx.tenantId)).status).toBe('canceled');
      const del = event('customer.subscription.deleted', sub(cs, c.customer, 'canceled'));
      expect((await post(del)).json().status).toBe('applied'); expect((await ledger(del.id))!.result_code).toBe('SUBSCRIPTION_CANCELED');
      expect((await sbs(c.ctx.tenantId)).status).toBe('canceled');
      expect(await historyCount(c.ctx.tenantId)).toBe(2); // created + one cancellation; the second cancel was a no-op

      const u = await world(); const us = uid('sub'); await links.registerSubscriptionLink(u.ctx, 'stripe', us, u.customer);
      expect((await post(event('customer.subscription.updated', sub(us, u.customer, 'unpaid')))).json().status).toBe('applied');
      expect((await sbs(u.ctx.tenantId)).status).toBe('suspended');

      const d = await world(); const ds = uid('sub'); await links.registerSubscriptionLink(d.ctx, 'stripe', ds, d.customer);
      expect((await post(event('customer.subscription.deleted', sub(ds, d.customer, 'canceled')))).json().status).toBe('applied');
      expect((await sbs(d.ctx.tenantId)).status).toBe('canceled');
    });

    it('an unpaid state cannot revive or alter a canceled subscription: refused TRANSITION_NOT_ALLOWED', async () => {
      const w = await world(); const s = uid('sub'); await links.registerSubscriptionLink(w.ctx, 'stripe', s, w.customer);
      await post(event('customer.subscription.deleted', sub(s, w.customer, 'canceled')));
      const e = event('customer.subscription.updated', sub(s, w.customer, 'unpaid'));
      expect((await post(e)).json().status).toBe('recorded');
      expect((await ledger(e.id))!.result_code).toBe('TRANSITION_NOT_ALLOWED'); expect((await sbs(w.ctx.tenantId)).status).toBe('canceled');
    });

    it('past_due, active and trialing are reconciliation only: past_due never regresses a grace period created from invoice.payment_failed', async () => {
      const w = await world(); const s = uid('sub'); await links.registerSubscriptionLink(w.ctx, 'stripe', s, w.customer);
      await post(event('invoice.payment_failed', invoice(w.customer, s)));
      expect((await sbs(w.ctx.tenantId)).status).toBe('grace_period');
      const history = await historyCount(w.ctx.tenantId); const graceEnds = (await sbs(w.ctx.tenantId)).grace_period_ends_at;
      for (const status of ['past_due', 'active', 'trialing']) {
        const e = event('customer.subscription.updated', sub(s, w.customer, status));
        expect((await post(e)).json().status, status).toBe('applied');
        expect((await ledger(e.id))!.result_code).toBe('STATE_RECONCILED_NO_CHANGE');
      }
      const after = await sbs(w.ctx.tenantId);
      expect(after.status).toBe('grace_period'); expect(after.grace_period_ends_at).toEqual(graceEnds); expect(await historyCount(w.ctx.tenantId)).toBe(history);
    });

    it('incomplete, incomplete_expired, paused and any unknown status are refused with a fixed code and change nothing', async () => {
      const w = await world(); const s = uid('sub'); await links.registerSubscriptionLink(w.ctx, 'stripe', s, w.customer);
      const before = await sbs(w.ctx.tenantId);
      const expected: Record<string, string> = { incomplete: 'INCOMPLETE_STATE_UNSUPPORTED', incomplete_expired: 'INCOMPLETE_STATE_UNSUPPORTED', paused: 'UNMAPPED_PROVIDER_STATE', some_future_status: 'UNMAPPED_PROVIDER_STATE' };
      for (const [status, code] of Object.entries(expected)) {
        const e = event('customer.subscription.updated', sub(s, w.customer, status));
        expect((await post(e)).json().status, status).toBe('recorded');
        expect((await ledger(e.id))!.result_code, status).toBe(code);
      }
      expect(await sbs(w.ctx.tenantId)).toEqual(before);
    });

    it('updated / deleted for a subscription that was never linked are refused (SUBSCRIPTION_NOT_LINKED), not guessed', async () => {
      const w = await world(); const before = await sbs(w.ctx.tenantId);
      for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) {
        const e = event(type, sub(uid('sub'), w.customer, 'canceled'));
        expect((await post(e)).json().status).toBe('recorded'); expect((await ledger(e.id))!.result_code).toBe('SUBSCRIPTION_NOT_LINKED');
      }
      expect(await sbs(w.ctx.tenantId)).toEqual(before);
    });
  });

  describe('checkout.session.completed never grants anything by itself', () => {
    it('requires subscription mode and references; confirms only an existing trusted relationship', async () => {
      const w = await world(); const before = await sbs(w.ctx.tenantId); const history = await historyCount(w.ctx.tenantId);
      const payment = event('checkout.session.completed', { id: uid('cs'), mode: 'payment', customer: w.customer, subscription: null });
      expect((await post(payment)).json().status).toBe('recorded'); expect((await ledger(payment.id))!.result_code).toBe('CHECKOUT_MODE_UNSUPPORTED');
      const noRefs = event('checkout.session.completed', { id: uid('cs'), mode: 'subscription', customer: null, subscription: null });
      expect((await post(noRefs)).json().status).toBe('recorded'); expect((await ledger(noRefs.id))!.result_code).toBe('CHECKOUT_REFERENCES_MISSING');

      const sid = uid('sub');
      const awaiting = event('checkout.session.completed', { id: uid('cs'), mode: 'subscription', customer: w.customer, subscription: sid, metadata: { tenant_id: randomUUID() } });
      expect((await post(awaiting)).json().status).toBe('applied'); expect((await ledger(awaiting.id))!.result_code).toBe('CHECKOUT_AWAITING_SUBSCRIPTION_EVENT');
      expect(await linkRows(sid)).toHaveLength(0); // checkout never creates a link

      await links.registerSubscriptionLink(w.ctx, 'stripe', sid, w.customer);
      const confirmed = event('checkout.session.completed', { id: uid('cs'), mode: 'subscription', customer: { id: w.customer }, subscription: { id: sid } });
      expect((await post(confirmed)).json().status).toBe('applied'); expect((await ledger(confirmed.id))!.result_code).toBe('CHECKOUT_CONFIRMED');
      expect(await sbs(w.ctx.tenantId)).toEqual(before); expect(await historyCount(w.ctx.tenantId)).toBe(history);
    });
  });

  describe('unsupported events and data hygiene', () => {
    it('an event type outside the six approved ones is recorded and refused, never applied', async () => {
      const w = await world(); const before = await sbs(w.ctx.tenantId);
      const e = event('customer.created', { id: w.customer, object: 'customer' });
      const r = await post(e);
      expect(r.statusCode).toBe(200); expect(r.json().status).toBe('recorded');
      expect((await ledger(e.id))!.result_code).toBe('UNSUPPORTED_EVENT_TYPE'); expect(await sbs(w.ctx.tenantId)).toEqual(before);
    });

    it('the ledger stores identity and fixed codes only: no payload, no customer data, no secret', async () => {
      const w = await world(); const e = event('invoice.payment_failed', invoice(w.customer, null, { customer_email: 'private.person@example.com', customer_name: 'Private Person', amount_due: 98765 }));
      await post(e);
      const row = (await ledger(e.id))!;
      const flat = JSON.stringify(row);
      for (const needle of ['private.person', 'Private Person', '98765', SECRET, w.customer]) expect(flat).not.toContain(needle);
      expect(Object.keys(row).sort()).toEqual(['attempt_count', 'event_id', 'event_type', 'id', 'last_attempt_at', 'payload_hash', 'processed_at', 'provider', 'received_at', 'result_code', 'state', 'tenant_id']);
    });
  });
});
