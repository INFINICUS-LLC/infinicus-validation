/**
 * SEC-BILL-02A: adversarial acceptance tests for SF-1 (a tenant owner could start an ENTERPRISE trial) and SF-2 (a tenant owner could certify their own payment).
 * Live PostgreSQL 16, application role with RLS enforced, synthetic records only, no network, no Stripe account. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 *
 * The contract under test (docs/production-readiness/SEC-BILL-02A-SECURITY-CONTRACT.md):
 *  - SF-1: a public route may start only an allowlisted self-service plan (currently `free`); everything else is refused before any lookup or write, with ONE
 *    indistinguishable answer; the match is exact.
 *  - SF-2: no tenant-callable payment-result operation exists. Payment state changes only through the signature-verified provider webhook.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, ProviderBillingRepository, type TenantContext } from '@infinicus/database';
import { EntitlementService } from '@infinicus/billing';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;
const PW = 'Correct-Horse-9!';
const WEBHOOK_SECRET = 'whsec_' + 'Sec0a1ForgedPaymentSecret';
let admin: Pool; let app: FastifyInstance; let userA: { userId: string; token: string }; let userB: { userId: string; token: string };
const ent = new EntitlementService();
const providerLinks = new ProviderBillingRepository();
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const pid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

async function actor(): Promise<{ userId: string; token: string }> {
  const email = `${uc('s02a')}@sec-bill-02a.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: PW } });
  const userId = reg.json().id as string; await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  return { userId, token: login.json().rawSessionToken as string };
}
async function tenant(userId: string, roleCode: string): Promise<TenantContext> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const s = uc('sfx');
  await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'SEC-BILL-02A Tenant',$2,'active','test')`, [tenantId, `s02a-${s}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'SEC-BILL-02A WS',$3,'active')`, [workspaceId, tenantId, `s02a-ws-${s}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const m = new MembershipRepository(); const r = new RoleRepository();
  const mem = await m.create(ctx, userId); await m.activate(ctx, mem.id); await m.assignRole(ctx, mem.id, (await r.getByCode(ctx, roleCode)).id);
  return ctx;
}
const hdr = (c: TenantContext, t: string) => ({ authorization: `Bearer ${t}`, 'x-tenant-id': c.tenantId, 'x-workspace-id': c.workspaceId });
const sub = async (tenantId: string) => (await admin.query(
  `SELECT s.status, s.payment_status, s.external_invoice_reference AS invoice, s.grace_period_ends_at, s.suspended_at, p.code AS plan FROM billing.subscriptions s JOIN billing.plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [tenantId])).rows[0] as Record<string, unknown> | undefined;
const history = async (tenantId: string) => (await admin.query(`SELECT to_status, reason FROM billing.subscription_status_history WHERE tenant_id = $1 ORDER BY occurred_at, id`, [tenantId])).rows;
const outboxCount = async (tenantId: string) => Number((await admin.query(`SELECT count(*) n FROM events.outbox_events WHERE tenant_id = $1`, [tenantId])).rows[0].n);
const trial = (c: TenantContext, t: string, payload: unknown) => app.inject({ method: 'POST', url: '/v1/billing/trial', headers: hdr(c, t), payload: payload as never });

/** An owner tenant that has a subscription row and a trusted Stripe customer + subscription link (the webhook's prerequisites). */
async function payingTenant(a = userA): Promise<{ ctx: TenantContext; token: string; customer: string; subscription: string }> {
  const ctx = await tenant(a.userId, 'owner'); await ent.startSubscription(ctx, 'free');
  const customer = pid('cus'); const subscription = pid('sub');
  await providerLinks.registerCustomer(ctx, 'stripe', customer); await providerLinks.registerSubscriptionLink(ctx, 'stripe', subscription, customer);
  return { ctx, token: a.token, customer, subscription };
}
const stripeEvent = (type: string, object: Record<string, unknown>, id = pid('evt')) => ({ id, object: 'event', api_version: Stripe.API_VERSION, created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
async function webhook(body: unknown, opts: { secret?: string; unsigned?: boolean; target?: FastifyInstance } = {}) {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.unsigned) headers['stripe-signature'] = Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
  return (opts.target ?? app).inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
}
const invoice = (customer: string, subscription: string | null, id = pid('in')) => ({ id, object: 'invoice', customer, subscription });

describe.runIf(run)('SEC-BILL-02A billing authorization (live PostgreSQL)', () => {
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = await buildApp(config);
    userA = await actor(); userB = await actor();
  });
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  describe('SF-1: only an allowlisted self-service plan can be started', () => {
    it('1-2. an owner cannot start enterprise, pro, or any unknown privileged plan; every refusal is the SAME answer (no plan-existence oracle) and nothing is created', async () => {
      const answers = new Map<string, string>();
      for (const plan of ['enterprise', 'pro', 'superadmin', 'internal', 'does-not-exist', 'admin', 'enterprise-plus', 'free-enterprise']) {
        const a = userA; const ctx = await tenant(a.userId, 'owner');
        const r = await trial(ctx, a.token, { planCode: plan });
        expect(r.statusCode, plan).toBe(403);
        expect(r.json().error.code, plan).toBe('PlanNotSelfServiceError');
        answers.set(plan, r.json().error.message);
        expect(await sub(ctx.tenantId), plan).toBeUndefined();
        expect(await history(ctx.tenantId), plan).toEqual([]);
      }
      expect(new Set(answers.values()).size).toBe(1); // existing plans and non-existent plans are indistinguishable
    });

    it('3. the approved free plan still starts (explicit and by default), active with no trial, and is recorded in the history', async () => {
      const a = userA; const ctx = await tenant(a.userId, 'owner');
      const r = await trial(ctx, a.token, { planCode: 'free' });
      expect(r.statusCode).toBe(201); expect(r.json()).toMatchObject({ status: 'active', plan: { code: 'free' }, trialEndsAt: null });
      expect((await history(ctx.tenantId)).map((h) => h.to_status)).toEqual(['active']);
      const b = userB; const ctx2 = await tenant(b.userId, 'owner');
      const d = await trial(ctx2, b.token, {}); // default planCode
      expect(d.statusCode).toBe(201); expect(d.json().plan.code).toBe('free');
    });

    it('4. an existing subscription is never replaced or conflicted: free again is 409, and an enterprise attempt is refused (403) without changing the plan', async () => {
      const a = userA; const ctx = await tenant(a.userId, 'owner'); await ent.startSubscription(ctx, 'free');
      const before = await sub(ctx.tenantId);
      expect((await trial(ctx, a.token, { planCode: 'free' })).statusCode).toBe(409);
      expect((await trial(ctx, a.token, { planCode: 'enterprise' })).statusCode).toBe(403);
      expect(await sub(ctx.tenantId)).toEqual(before);
      expect((await history(ctx.tenantId)).length).toBe(1);
    });

    it('5. a foreign tenant cannot be started: the owner token with another tenant\'s headers is refused and that tenant gets nothing', async () => {
      const a = userA; await tenant(a.userId, 'owner'); const v = userB; const victim = await tenant(v.userId, 'owner');
      for (const plan of ['free', 'enterprise']) expect([401, 403, 404], plan).toContain((await trial(victim, a.token, { planCode: plan })).statusCode);
      expect(await sub(victim.tenantId)).toBeUndefined();
    });

    it('6. an unauthenticated request fails and creates nothing', async () => {
      const a = userA; const ctx = await tenant(a.userId, 'owner');
      const r = await app.inject({ method: 'POST', url: '/v1/billing/trial', headers: { 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId }, payload: { planCode: 'free' } });
      expect(r.statusCode).toBe(401); expect(await sub(ctx.tenantId)).toBeUndefined();
    });

    it('7. admin, member and viewer keep their restriction (403 for free AND enterprise) and create nothing', async () => {
      for (const role of ['admin', 'member', 'viewer']) {
        const a = userB; const ctx = await tenant(a.userId, role);
        for (const plan of ['free', 'enterprise']) expect((await trial(ctx, a.token, { planCode: plan })).statusCode, `${role}/${plan}`).toBe(403);
        expect(await sub(ctx.tenantId), role).toBeUndefined();
      }
    });

    it('8. eligibility cannot be bypassed by casing, whitespace, Unicode look-alikes, control characters, aliases or malformed payloads', async () => {
      const attacks: unknown[] = [
        'Enterprise', 'ENTERPRISE', ' enterprise', 'enterprise ', 'enterprise\n', 'enterprise\u0000', 'entеrprise', '​enterprise', 'enterprise​',
        'Free', 'FREE', ' free', 'free ', 'free\n', 'free\u0000', 'frеe', '​free', 'free​', 'free,enterprise', 'free;enterprise', 'free/../enterprise', 'free%00',
        ['free'], ['enterprise'], { planCode: 'free' }, { $ne: null }, 123, 0, true, false, null, '', 'x'.repeat(65),
      ];
      for (const value of attacks) {
        const a = userA; const ctx = await tenant(a.userId, 'owner');
        const r = await trial(ctx, a.token, { planCode: value });
        expect([400, 403], JSON.stringify(value)).toContain(r.statusCode);
        expect(await sub(ctx.tenantId), JSON.stringify(value)).toBeUndefined();
      }
      // a non-object body and extra, plan-looking properties never select a plan; the only way to a subscription is the exact allowlisted string
      for (const payload of [[], 'enterprise', 42, null]) {
        const a = userA; const ctx = await tenant(a.userId, 'owner');
        const r = await app.inject({ method: 'POST', url: '/v1/billing/trial', headers: { ...hdr(ctx, a.token), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
        expect([400, 403, 415], JSON.stringify(payload)).toContain(r.statusCode); expect(await sub(ctx.tenantId)).toBeUndefined();
      }
      const a = userA; const ctx = await tenant(a.userId, 'owner');
      const enterpriseId = (await admin.query(`SELECT id FROM billing.plans WHERE code = 'enterprise'`)).rows[0].id as string;
      const r = await trial(ctx, a.token, { planCode: 'free', plan: 'enterprise', planId: enterpriseId, plan_code: 'enterprise', trialDays: 3650, priceCents: 0, features: { apiAccess: true } });
      expect(r.statusCode).toBe(201); expect(r.json().plan.code).toBe('free'); expect(r.json().trialEndsAt).toBeNull();
      expect((await sub(ctx.tenantId))?.plan).toBe('free');
    });
  });

  describe('SF-2: no tenant can certify a payment', () => {
    it('1. an owner cannot submit paid, failed or pending: the operation does not exist (the route is gone), for any method, and nothing changes', async () => {
      const t = await payingTenant(); await ent.recordPaymentResult(t.ctx, 'failed', 'in_real_failure');
      const before = await sub(t.ctx.tenantId);
      for (const status of ['paid', 'failed', 'pending']) {
        for (const method of ['POST', 'PUT', 'PATCH'] as const) {
          const r = await app.inject({ method, url: '/v1/billing/payment-result', headers: hdr(t.ctx, t.token), payload: { status, externalInvoiceReference: 'in_forged' } });
          expect([404, 405], `${method} ${status}`).toContain(r.statusCode);
        }
      }
      expect(app.hasRoute({ method: 'POST', url: '/v1/billing/payment-result' })).toBe(false);
      expect(app.printRoutes()).not.toMatch(/payment-result/);
      expect(await sub(t.ctx.tenantId)).toEqual(before);
    });

    it('2-4. a forged success cannot overwrite the invoice reference, clear a grace period, or touch a suspended subscription', async () => {
      const g = await payingTenant(); await ent.recordPaymentResult(g.ctx, 'failed', 'in_real_failure');
      const sg = await payingTenant(); await ent.suspend(sg.ctx, 'billing_suspension');
      const beforeG = await sub(g.ctx.tenantId); const beforeS = await sub(sg.ctx.tenantId); const hg = await history(g.ctx.tenantId); const hs = await history(sg.ctx.tenantId);
      for (const [t, ref] of [[g, 'in_i_say_i_paid'], [sg, 'in_forged_on_suspended']] as const) {
        for (const body of [{ status: 'paid', externalInvoiceReference: ref }, { status: 'paid' }, { status: 'PAID' }, { status: 'paid ', externalInvoiceReference: ref }]) {
          const r = await app.inject({ method: 'POST', url: '/v1/billing/payment-result', headers: hdr(t.ctx, t.token), payload: body });
          expect(r.statusCode).toBe(404);
        }
      }
      const afterG = await sub(g.ctx.tenantId); const afterS = await sub(sg.ctx.tenantId);
      expect(afterG).toEqual(beforeG); expect(afterG).toMatchObject({ status: 'grace_period', payment_status: 'failed', invoice: 'in_real_failure' }); expect(afterG?.grace_period_ends_at).not.toBeNull();
      expect(afterS).toEqual(beforeS); expect(afterS).toMatchObject({ status: 'suspended', payment_status: 'unknown', invoice: null });
      expect(await history(g.ctx.tenantId)).toEqual(hg); expect(await history(sg.ctx.tenantId)).toEqual(hs); // history and audit evidence untouched
    });

    it('5-6. the signature-verified Stripe webhook still moves payment state, and a duplicate authenticated event is idempotent', async () => {
      const t = await payingTenant();
      const failed = stripeEvent('invoice.payment_failed', invoice(t.customer, t.subscription, 'in_stripe_failed'));
      expect((await webhook(failed)).json().status).toBe('applied');
      expect(await sub(t.ctx.tenantId)).toMatchObject({ status: 'grace_period', payment_status: 'failed', invoice: 'in_stripe_failed' });
      const paid = stripeEvent('invoice.paid', invoice(t.customer, t.subscription, 'in_stripe_paid'));
      expect((await webhook(paid)).json().status).toBe('applied');
      expect(await sub(t.ctx.tenantId)).toMatchObject({ status: 'active', payment_status: 'paid', invoice: 'in_stripe_paid' });
      const h = await history(t.ctx.tenantId); const o = await outboxCount(t.ctx.tenantId);
      expect((await webhook(paid)).json().status).toBe('duplicate'); expect((await webhook(failed)).json().status).toBe('duplicate');
      expect(await history(t.ctx.tenantId)).toEqual(h); expect(await outboxCount(t.ctx.tenantId)).toBe(o);
      expect(await sub(t.ctx.tenantId)).toMatchObject({ status: 'active', invoice: 'in_stripe_paid' });
    });

    it('7. cross-tenant: a tenant\'s forged HTTP attempt and a webhook for another customer never change a different tenant', async () => {
      const a = await payingTenant(userA); const b = await payingTenant(userB); await ent.recordPaymentResult(b.ctx, 'failed', 'in_b_real');
      const bBefore = await sub(b.ctx.tenantId);
      // A's owner tries B's headers: refused before anything; A's own forged attempt targets only A
      const r = await app.inject({ method: 'POST', url: '/v1/billing/payment-result', headers: hdr(b.ctx, a.token), payload: { status: 'paid', externalInvoiceReference: 'in_x' } });
      expect([401, 403, 404]).toContain(r.statusCode);
      // a genuine signed event for A's customer changes A only
      expect((await webhook(stripeEvent('invoice.payment_failed', invoice(a.customer, a.subscription, 'in_a_failed')))).json().status).toBe('applied');
      expect(await sub(a.ctx.tenantId)).toMatchObject({ status: 'grace_period', invoice: 'in_a_failed' });
      expect(await sub(b.ctx.tenantId)).toEqual(bBefore);
      // a signed event whose subscription belongs to the OTHER customer is refused and changes nobody
      const mismatch = stripeEvent('invoice.paid', invoice(b.customer, a.subscription, 'in_mismatch'));
      expect((await webhook(mismatch)).json().status).toBe('recorded');
      expect(await sub(b.ctx.tenantId)).toEqual(bBefore); expect((await sub(a.ctx.tenantId))?.invoice).toBe('in_a_failed');
    });

    it('8. missing or invalid provider authority fails closed: unsigned, wrongly signed, tampered, and an unconfigured endpoint change nothing', async () => {
      const t = await payingTenant(); await ent.recordPaymentResult(t.ctx, 'failed', 'in_real_failure');
      const before = await sub(t.ctx.tenantId); const h = await history(t.ctx.tenantId);
      const body = stripeEvent('invoice.paid', invoice(t.customer, t.subscription, 'in_would_be_forged'));
      expect((await webhook(body, { unsigned: true })).statusCode).toBe(400);
      expect((await webhook(body, { secret: 'whsec_' + 'NotTheRealSigningSecret1' })).statusCode).toBe(400);
      const signed = Stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(body), secret: WEBHOOK_SECRET });
      const tampered = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed }, payload: JSON.stringify({ ...body, id: pid('evt') }) });
      expect(tampered.statusCode).toBe(400);
      const bare = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
      try { expect((await webhook(body, { target: bare })).statusCode).toBe(503); } finally { await bare.close(); }
      expect(await sub(t.ctx.tenantId)).toEqual(before); expect(await history(t.ctx.tenantId)).toEqual(h);
    });

    it('9-10. history and audit stay consistent and the other lifecycle operations still work (read, lazy provision, suspend, reactivate, cancel)', async () => {
      const a = userA; const ctx = await tenant(a.userId, 'owner');
      const read = await app.inject({ method: 'GET', url: '/v1/billing/subscription', headers: hdr(ctx, a.token) });
      expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({ status: 'active', plan: { code: 'free' } }); // lazy free provisioning intact
      await ent.suspend(ctx, 'billing_suspension');
      expect((await sub(ctx.tenantId))?.status).toBe('suspended');
      await ent.reactivate(ctx, 'operator_reactivation');
      expect((await sub(ctx.tenantId))?.status).toBe('active');
      await ent.cancel(ctx, 'customer_request');
      expect((await sub(ctx.tenantId))?.status).toBe('canceled');
      expect((await history(ctx.tenantId)).map((h) => h.to_status)).toEqual(['active', 'suspended', 'active', 'canceled']);
      expect(app.hasRoute({ method: 'GET', url: '/v1/billing/subscription' })).toBe(true);
      expect(app.hasRoute({ method: 'POST', url: '/v1/billing/trial' })).toBe(true);
    });
  });
});
