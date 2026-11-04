/**
 * STRIPE-SBX-01: the PROVIDER-NEUTRAL billing command vocabulary. A provider adapter (Stripe today) translates its own events into these; the billing core never sees a
 * provider event name, product, price or payload. Billing state is not entitlement is not a role: a command can only ask the existing EntitlementService to record a
 * payment result or to cancel / suspend a subscription - it cannot grant a capability.
 */
export type ProviderPaymentStatus = 'paid' | 'failed';

/** The provider-neutral subscription states an adapter may report. Anything the adapter cannot map arrives as 'unmapped' and is refused fail-closed. */
export type ProviderSubscriptionState =
  | 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'unmapped';

export type ProviderBillingCommand =
  /** A payment succeeded or failed for an invoice of a provider customer. Reuses EntitlementService.recordPaymentResult. */
  | { kind: 'payment_result'; providerCustomerId: string; providerSubscriptionId: string | null; status: ProviderPaymentStatus; invoiceReference: string }
  /** A provider subscription now exists for a provider customer. Establishes provider subscription IDENTITY only; never changes entitlement. */
  | { kind: 'subscription_established'; providerCustomerId: string; providerSubscriptionId: string }
  /** The provider reports the subscription's own state. Reconciliation: only terminal / escalation states change the lifecycle. */
  | { kind: 'subscription_state_observed'; providerCustomerId: string; providerSubscriptionId: string; state: ProviderSubscriptionState }
  /** The provider subscription ended (deleted). */
  | { kind: 'subscription_ended'; providerCustomerId: string; providerSubscriptionId: string }
  /** A hosted checkout completed. May CONFIRM an existing trusted relationship; never creates tenant authority. */
  | { kind: 'checkout_completed'; subscriptionMode: boolean; providerCustomerId: string | null; providerSubscriptionId: string | null }
  /** An event type this block does not handle (recorded and refused, never applied). */
  | { kind: 'unsupported' };

export interface ProviderEventEnvelope {
  provider: string;
  eventId: string;
  eventType: string;
  /** SHA-256 (lowercase hex) of the exact delivered bytes: the immutable identity of the delivery. */
  payloadHash: string;
  command: ProviderBillingCommand;
}

/** Fixed, closed result codes (stored in the ledger; never free text, never payload). */
export const PROVIDER_RESULT_CODES = [
  'PAYMENT_PAID_APPLIED', 'PAYMENT_FAILED_APPLIED', 'SUBSCRIPTION_LINKED', 'SUBSCRIPTION_ALREADY_LINKED', 'STATE_RECONCILED_NO_CHANGE', 'SUBSCRIPTION_CANCELED',
  'SUBSCRIPTION_SUSPENDED', 'CHECKOUT_CONFIRMED', 'CHECKOUT_AWAITING_SUBSCRIPTION_EVENT',
  'UNSUPPORTED_EVENT_TYPE', 'CUSTOMER_UNLINKED', 'SUBSCRIPTION_NOT_LINKED', 'CUSTOMER_SUBSCRIPTION_MISMATCH', 'NO_SUBSCRIPTION', 'TRANSITION_NOT_ALLOWED',
  'INCOMPLETE_STATE_UNSUPPORTED', 'UNMAPPED_PROVIDER_STATE', 'CHECKOUT_MODE_UNSUPPORTED', 'CHECKOUT_REFERENCES_MISSING', 'REFERENCE_INVALID', 'INTERNAL_ERROR',
] as const;
export type ProviderResultCode = (typeof PROVIDER_RESULT_CODES)[number];

/**
 * How a delivery ended, for the adapter's HTTP answer:
 *  APPLIED    processed with an effect or a deliberate no-effect reconciliation          -> acknowledge
 *  REFUSED    durably recorded as failed with a fixed code; will not succeed on retry     -> acknowledge (no silent loss: the ledger row is the record)
 *  DUPLICATE  already processed; nothing applied again                                    -> acknowledge
 *  IN_PROGRESS another attempt holds a fresh claim                                         -> ask the provider to retry
 *  CONFLICT   same event id arrived with a different type or body                          -> reject
 */
export type ProviderEventOutcome =
  | { outcome: 'APPLIED'; code: ProviderResultCode }
  | { outcome: 'REFUSED'; code: ProviderResultCode }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'CONFLICT' };
