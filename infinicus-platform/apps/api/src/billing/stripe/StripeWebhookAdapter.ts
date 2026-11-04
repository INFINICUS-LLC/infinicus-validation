/**
 * STRIPE-SBX-01: the Stripe provider adapter. The ONLY place that knows Stripe event names and payload shapes. It translates a signature-verified Stripe event into the
 * provider-neutral billing command that the billing core understands; it contains no billing lifecycle logic, no entitlement logic and no tenant resolution.
 *
 * Trust rules encoded here:
 *  - Only the six approved sandbox event types are mapped; every other type becomes 'unsupported' (recorded and refused, never applied).
 *  - Nothing is read from `metadata`, `client_reference_id`, e-mail or any display field. Tenant identity is resolved downstream from the trusted customer link only.
 *  - Stripe product / price / plan data is never read: a product name or price id is not architecture. The commercial mapping to entitlement is a later block (POS2-02).
 *  - A live-mode event is refused by the route before it gets here.
 */
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { ProviderBillingCommand, ProviderEventEnvelope, ProviderSubscriptionState } from '@infinicus/billing';

export const STRIPE_PROVIDER = 'stripe';
/** The six approved sandbox events. Nothing else is subscribed to or handled in this block. */
export const STRIPE_SUPPORTED_EVENT_TYPES = [
  'checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed',
] as const;
const SUPPORTED: ReadonlySet<string> = new Set(STRIPE_SUPPORTED_EVENT_TYPES);

/** The Stripe API version this adapter was written and verified against (stripe-node 23.1.0 pins it; the sandbox UI shows the same). */
export const STRIPE_PINNED_API_VERSION: string = Stripe.API_VERSION;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Stripe fields are an id string, or an expanded object carrying `id`. Anything else is "absent". */
const idOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : isObj(v) && typeof v.id === 'string' && v.id.length > 0 ? v.id : null);

export const stripePayloadHash = (rawBody: Buffer): string => createHash('sha256').update(rawBody).digest('hex');

/** Maps Stripe's own subscription status vocabulary to the provider-neutral one. Anything not listed (e.g. 'paused', or a future status) is 'unmapped' and refused. */
export function mapStripeSubscriptionStatus(status: unknown): ProviderSubscriptionState {
  switch (status) {
    case 'active': case 'trialing': case 'past_due': case 'canceled': case 'unpaid': case 'incomplete': case 'incomplete_expired': return status;
    default: return 'unmapped';
  }
}

/** The subscription an invoice belongs to: top-level `subscription` (older API versions) or `parent.subscription_details.subscription` (newer ones). */
function invoiceSubscriptionId(invoice: Obj): string | null {
  const direct = idOf(invoice.subscription);
  if (direct !== null) return direct;
  const parent = invoice.parent;
  return isObj(parent) && isObj(parent.subscription_details) ? idOf(parent.subscription_details.subscription) : null;
}

export function mapStripeEvent(event: Stripe.Event, rawBody: Buffer): ProviderEventEnvelope {
  const base = { provider: STRIPE_PROVIDER, eventId: event.id, eventType: event.type, payloadHash: stripePayloadHash(rawBody) };
  return { ...base, command: mapCommand(event) };
}

function mapCommand(event: Stripe.Event): ProviderBillingCommand {
  if (!SUPPORTED.has(event.type)) return { kind: 'unsupported' };
  const o: unknown = (event.data as { object?: unknown } | undefined)?.object;
  if (!isObj(o)) return { kind: 'unsupported' };
  const customer = idOf(o.customer);

  switch (event.type) {
    case 'checkout.session.completed':
      return { kind: 'checkout_completed', subscriptionMode: o.mode === 'subscription', providerCustomerId: customer, providerSubscriptionId: idOf(o.subscription) };
    case 'customer.subscription.created': {
      const id = idOf(o.id);
      return customer !== null && id !== null ? { kind: 'subscription_established', providerCustomerId: customer, providerSubscriptionId: id } : { kind: 'unsupported' };
    }
    case 'customer.subscription.updated': {
      const id = idOf(o.id);
      return customer !== null && id !== null ? { kind: 'subscription_state_observed', providerCustomerId: customer, providerSubscriptionId: id, state: mapStripeSubscriptionStatus(o.status) } : { kind: 'unsupported' };
    }
    case 'customer.subscription.deleted': {
      const id = idOf(o.id);
      return customer !== null && id !== null ? { kind: 'subscription_ended', providerCustomerId: customer, providerSubscriptionId: id } : { kind: 'unsupported' };
    }
    case 'invoice.paid': case 'invoice.payment_failed': {
      const invoiceId = idOf(o.id);
      return customer !== null && invoiceId !== null
        ? { kind: 'payment_result', providerCustomerId: customer, providerSubscriptionId: invoiceSubscriptionId(o), status: event.type === 'invoice.paid' ? 'paid' : 'failed', invoiceReference: invoiceId }
        : { kind: 'unsupported' };
    }
    default: return { kind: 'unsupported' };
  }
}
