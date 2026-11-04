/**
 * STRIPE-SBX-01: pure unit tests for the Stripe adapter (event -> provider-neutral command) and the exact-bytes signature verifier. No database, no network.
 */
import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { mapStripeEvent, mapStripeSubscriptionStatus, stripePayloadHash, STRIPE_PINNED_API_VERSION, STRIPE_SUPPORTED_EVENT_TYPES } from '../src/billing/stripe/StripeWebhookAdapter.js';
import { verifyStripeSignature } from '../src/billing/stripe/verifyStripeSignature.js';

const SECRET = 'whsec_' + 'UnitTestSecretValue123456';
const ev = (type: string, object: unknown): Stripe.Event => ({ id: 'evt_1', object: 'event', api_version: STRIPE_PINNED_API_VERSION, created: 1, livemode: false, type, data: { object } } as unknown as Stripe.Event);
const buf = (e: unknown) => Buffer.from(JSON.stringify(e));
const cmd = (type: string, object: unknown) => mapStripeEvent(ev(type, object), buf({})).command;

describe('STRIPE-SBX-01 adapter: Stripe event -> provider-neutral command', () => {
  it('is built against the API version the sandbox shows (stripe-node 23.1.0 pins 2026-10-28.endive)', () => {
    expect(STRIPE_PINNED_API_VERSION).toBe('2026-10-28.endive');
  });
  it('supports exactly the six approved sandbox events', () => {
    expect([...STRIPE_SUPPORTED_EVENT_TYPES].sort()).toEqual(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed']);
  });
  it('maps invoices to payment results carrying the Stripe invoice id; expanded customer objects and both subscription locations are understood', () => {
    expect(cmd('invoice.paid', { id: 'in_1', customer: 'cus_1', subscription: 'sub_1' })).toEqual({ kind: 'payment_result', providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1', status: 'paid', invoiceReference: 'in_1' });
    expect(cmd('invoice.payment_failed', { id: 'in_2', customer: { id: 'cus_2' }, parent: { subscription_details: { subscription: 'sub_2' } } }))
      .toEqual({ kind: 'payment_result', providerCustomerId: 'cus_2', providerSubscriptionId: 'sub_2', status: 'failed', invoiceReference: 'in_2' });
    expect(cmd('invoice.paid', { id: 'in_3', customer: 'cus_3' })).toMatchObject({ providerSubscriptionId: null });
  });
  it('maps subscription events and the checkout event', () => {
    expect(cmd('customer.subscription.created', { id: 'sub_1', customer: 'cus_1', status: 'active' })).toEqual({ kind: 'subscription_established', providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1' });
    expect(cmd('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'unpaid' })).toEqual({ kind: 'subscription_state_observed', providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1', state: 'unpaid' });
    expect(cmd('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled' })).toEqual({ kind: 'subscription_ended', providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1' });
    expect(cmd('checkout.session.completed', { id: 'cs_1', mode: 'subscription', customer: 'cus_1', subscription: { id: 'sub_1' } })).toEqual({ kind: 'checkout_completed', subscriptionMode: true, providerCustomerId: 'cus_1', providerSubscriptionId: 'sub_1' });
    expect(cmd('checkout.session.completed', { id: 'cs_1', mode: 'payment', customer: 'cus_1', subscription: null })).toMatchObject({ subscriptionMode: false, providerSubscriptionId: null });
  });
  it('maps Stripe statuses deliberately; anything else is unmapped (fail closed)', () => {
    for (const s of ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired']) expect(mapStripeSubscriptionStatus(s)).toBe(s);
    for (const s of ['paused', 'something_new', '', null, undefined, 5, {}]) expect(mapStripeSubscriptionStatus(s)).toBe('unmapped');
  });
  it('never reads metadata, client_reference_id, e-mail, names, products or prices', () => {
    const noisy = { id: 'in_9', customer: 'cus_9', subscription: null, metadata: { tenant_id: 'T', tenantId: 'T' }, client_reference_id: 'T', customer_email: 'a@b.c', customer_name: 'N', lines: { data: [{ price: { id: 'price_x', product: 'prod_x' } }] } };
    expect(cmd('invoice.paid', noisy)).toEqual({ kind: 'payment_result', providerCustomerId: 'cus_9', providerSubscriptionId: null, status: 'paid', invoiceReference: 'in_9' });
    expect(JSON.stringify(cmd('invoice.paid', noisy))).not.toMatch(/tenant|price|prod_|a@b|"N"/i);
  });
  it('unsupported types, missing references and malformed data become the unsupported command', () => {
    expect(cmd('customer.created', { id: 'cus_1' })).toEqual({ kind: 'unsupported' });
    expect(cmd('payment_intent.succeeded', { id: 'pi_1' })).toEqual({ kind: 'unsupported' });
    for (const o of [null, 'x', 5, [], {}, { id: 'in_1' }, { customer: 'cus_1' }]) expect(cmd('invoice.paid', o), JSON.stringify(o)).toEqual({ kind: 'unsupported' });
    expect(cmd('customer.subscription.created', { id: 'sub_1' })).toEqual({ kind: 'unsupported' });
  });
  it('the payload hash is the SHA-256 of the exact delivered bytes', () => {
    const raw = Buffer.from('{"a": 1}  \n');
    expect(stripePayloadHash(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(stripePayloadHash(Buffer.from('{"a":1}'))).not.toBe(stripePayloadHash(raw));
  });
});

describe('STRIPE-SBX-01 signature verification (exact raw bytes)', () => {
  const body = JSON.stringify({ id: 'evt_9', object: 'event', livemode: false, type: 'invoice.paid', data: { object: {} } });
  const header = (payload: string, secret = SECRET, timestamp?: number) => Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp !== undefined ? { timestamp } : {}) });
  it('accepts a valid signature over the exact bytes', () => {
    const r = verifyStripeSignature(Buffer.from(body), header(body), SECRET);
    expect(r.ok).toBe(true); if (r.ok) expect(r.event.id).toBe('evt_9');
  });
  it('refuses missing, empty, oversized and non-string headers as MISSING_SIGNATURE', () => {
    for (const h of [undefined, null, '', 'x'.repeat(2049), ['a'], 5]) expect(verifyStripeSignature(Buffer.from(body), h, SECRET)).toEqual({ ok: false, code: 'MISSING_SIGNATURE' });
  });
  it('refuses a wrong secret, a changed body, a stale timestamp and a garbage header as INVALID_SIGNATURE', () => {
    expect(verifyStripeSignature(Buffer.from(body), header(body, 'whsec_' + 'AnotherSecretValue12345'), SECRET)).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
    expect(verifyStripeSignature(Buffer.from(body + ' '), header(body), SECRET)).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
    expect(verifyStripeSignature(Buffer.from(body), header(body, SECRET, Math.floor(Date.now() / 1000) - 900), SECRET)).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
    expect(verifyStripeSignature(Buffer.from(body), 'not-a-signature-header', SECRET)).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
  });
  it('reports a validly signed non-JSON body as INVALID_PAYLOAD, with no error text', () => {
    const bad = '{ not json';
    const r = verifyStripeSignature(Buffer.from(bad), header(bad), SECRET);
    expect(r).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });
  });
});
