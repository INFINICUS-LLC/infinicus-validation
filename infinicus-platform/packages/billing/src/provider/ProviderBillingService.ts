/**
 * STRIPE-SBX-01: applies provider-neutral billing commands to the existing billing lifecycle. Provider-agnostic: it knows no provider event name, product or price.
 *
 *   claim (durable, atomic)  ->  resolve the TRUSTED customer link  ->  apply through EntitlementService  ->  finish the ledger row (processed | failed + fixed code)
 *
 * Tenant identity comes only from the trusted provider_customers link (never from the event's metadata, email or names). A subscription id is accepted only if it is
 * unlinked or linked to the SAME customer. The Stripe-style event ORDER is not assumed: customer.subscription.updated never overwrites the lifecycle blindly
 * (only canceled -> canceled and unpaid -> suspended change it; past_due never regresses a grace period), payment results reuse recordPaymentResult unchanged, and
 * anything that cannot be mapped is refused with a fixed code rather than inventing semantics.
 *
 * Effects are idempotent (recordPaymentResult / cancel / suspend are idempotent for a repeated status), so a crash between applying an effect and finishing the ledger
 * row is safe: the claim is re-taken after five minutes and re-applies the same effect.
 */
import { ProviderBillingRepository, InvalidSubscriptionTransitionError, SubscriptionNotFoundError, type TenantContext } from '@infinicus/database';
import { EntitlementService } from '../EntitlementService.js';
import type { ProviderBillingCommand, ProviderEventEnvelope, ProviderEventOutcome, ProviderResultCode } from './commands.js';

/** The system actor for provider-originated changes (the platform's nil-UUID convention); no user is impersonated. */
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const REFERENCE = /^[A-Za-z0-9_-]{1,255}$/;

type Applied = { status: 'APPLIED' | 'REFUSED'; code: ProviderResultCode; tenantId: string | null };
const applied = (code: ProviderResultCode, tenantId: string | null): Applied => ({ status: 'APPLIED', code, tenantId });
const refused = (code: ProviderResultCode, tenantId: string | null = null): Applied => ({ status: 'REFUSED', code, tenantId });

export class ProviderBillingService {
  constructor(
    private readonly links: ProviderBillingRepository = new ProviderBillingRepository(),
    private readonly entitlements: EntitlementService = new EntitlementService(),
  ) {}

  async process(envelope: ProviderEventEnvelope): Promise<ProviderEventOutcome> {
    const claim = await this.links.claimEvent(envelope.provider, envelope.eventId, envelope.eventType, envelope.payloadHash);
    if (claim.outcome === 'DUPLICATE') return { outcome: 'DUPLICATE' };
    if (claim.outcome === 'IN_PROGRESS') return { outcome: 'IN_PROGRESS' };
    if (claim.outcome === 'CONFLICT') return { outcome: 'CONFLICT' };

    let result: Applied;
    try {
      result = await this.apply(envelope.provider, envelope.command);
    } catch (error) {
      // Unexpected failure: record it as failed (so the next delivery re-claims it) and let the caller answer 5xx. Never record the error text.
      await this.links.finishEvent(envelope.provider, envelope.eventId, 'failed', 'INTERNAL_ERROR', null).catch(() => false);
      throw error;
    }
    await this.links.finishEvent(envelope.provider, envelope.eventId, result.status === 'APPLIED' ? 'processed' : 'failed', result.code, result.tenantId);
    return result.status === 'APPLIED' ? { outcome: 'APPLIED', code: result.code } : { outcome: 'REFUSED', code: result.code };
  }

  private async apply(provider: string, c: ProviderBillingCommand): Promise<Applied> {
    switch (c.kind) {
      case 'unsupported': return refused('UNSUPPORTED_EVENT_TYPE');
      case 'checkout_completed': return this.checkout(provider, c);
      case 'subscription_established': return this.established(provider, c.providerCustomerId, c.providerSubscriptionId);
      case 'payment_result': return this.payment(provider, c);
      case 'subscription_state_observed': return this.observed(provider, c.providerCustomerId, c.providerSubscriptionId, c.state);
      case 'subscription_ended': return this.observed(provider, c.providerCustomerId, c.providerSubscriptionId, 'canceled');
      default: return refused('UNMAPPED_PROVIDER_STATE');
    }
  }

  private async resolve(provider: string, providerCustomerId: string): Promise<{ ctx: TenantContext } | null> {
    if (!REFERENCE.test(providerCustomerId)) return null;
    const customer = await this.links.resolveCustomer(provider, providerCustomerId);
    return customer === null ? null : { ctx: { tenantId: customer.tenantId, workspaceId: customer.workspaceId, userId: SYSTEM_ACTOR } };
  }

  private async established(provider: string, customerId: string, subscriptionId: string): Promise<Applied> {
    if (!REFERENCE.test(customerId) || !REFERENCE.test(subscriptionId)) return refused('REFERENCE_INVALID');
    const customer = await this.resolve(provider, customerId);
    if (customer === null) return refused('CUSTOMER_UNLINKED');
    const outcome = await this.links.linkSubscription(provider, subscriptionId, customerId);
    if (outcome === 'LINKED') return applied('SUBSCRIPTION_LINKED', customer.ctx.tenantId);
    if (outcome === 'ALREADY_LINKED') return applied('SUBSCRIPTION_ALREADY_LINKED', customer.ctx.tenantId);
    return refused(outcome === 'MISMATCH' ? 'CUSTOMER_SUBSCRIPTION_MISMATCH' : 'CUSTOMER_UNLINKED', customer.ctx.tenantId);
  }

  private async checkout(provider: string, c: Extract<ProviderBillingCommand, { kind: 'checkout_completed' }>): Promise<Applied> {
    if (!c.subscriptionMode) return refused('CHECKOUT_MODE_UNSUPPORTED');
    if (c.providerCustomerId === null || c.providerSubscriptionId === null) return refused('CHECKOUT_REFERENCES_MISSING');
    if (!REFERENCE.test(c.providerSubscriptionId)) return refused('REFERENCE_INVALID');
    const customer = await this.resolve(provider, c.providerCustomerId);
    if (customer === null) return refused('CUSTOMER_UNLINKED');
    const link = await this.links.checkSubscriptionLink(provider, c.providerSubscriptionId, c.providerCustomerId);
    if (link === 'MISMATCH') return refused('CUSTOMER_SUBSCRIPTION_MISMATCH', customer.ctx.tenantId);
    // MATCH confirms an established relationship; UNLINKED waits for the subscription event. Neither writes billing state: checkout alone never grants anything.
    return applied(link === 'MATCH' ? 'CHECKOUT_CONFIRMED' : 'CHECKOUT_AWAITING_SUBSCRIPTION_EVENT', customer.ctx.tenantId);
  }

  private async payment(provider: string, c: Extract<ProviderBillingCommand, { kind: 'payment_result' }>): Promise<Applied> {
    if (!REFERENCE.test(c.invoiceReference) || (c.providerSubscriptionId !== null && !REFERENCE.test(c.providerSubscriptionId))) return refused('REFERENCE_INVALID');
    const customer = await this.resolve(provider, c.providerCustomerId);
    if (customer === null) return refused('CUSTOMER_UNLINKED');
    // an invoice's subscription must be unlinked (the customer is the trust anchor) or linked to this same customer
    if (c.providerSubscriptionId !== null && (await this.links.checkSubscriptionLink(provider, c.providerSubscriptionId, c.providerCustomerId)) === 'MISMATCH') {
      return refused('CUSTOMER_SUBSCRIPTION_MISMATCH', customer.ctx.tenantId);
    }
    try {
      await this.entitlements.recordPaymentResult(customer.ctx, c.status, c.invoiceReference);
    } catch (error) {
      if (error instanceof SubscriptionNotFoundError) return refused('NO_SUBSCRIPTION', customer.ctx.tenantId);
      throw error;
    }
    return applied(c.status === 'paid' ? 'PAYMENT_PAID_APPLIED' : 'PAYMENT_FAILED_APPLIED', customer.ctx.tenantId);
  }

  private async observed(provider: string, customerId: string, subscriptionId: string, state: Extract<ProviderBillingCommand, { kind: 'subscription_state_observed' }>['state']): Promise<Applied> {
    if (!REFERENCE.test(customerId) || !REFERENCE.test(subscriptionId)) return refused('REFERENCE_INVALID');
    if (state === 'incomplete' || state === 'incomplete_expired') return refused('INCOMPLETE_STATE_UNSUPPORTED');
    if (state === 'unmapped') return refused('UNMAPPED_PROVIDER_STATE');
    const customer = await this.resolve(provider, customerId);
    if (customer === null) return refused('CUSTOMER_UNLINKED');
    const link = await this.links.checkSubscriptionLink(provider, subscriptionId, customerId);
    if (link === 'MISMATCH') return refused('CUSTOMER_SUBSCRIPTION_MISMATCH', customer.ctx.tenantId);
    if (link === 'UNLINKED') return refused('SUBSCRIPTION_NOT_LINKED', customer.ctx.tenantId);
    const { ctx } = customer;
    // active / trialing / past_due are reconciliation only: payment results own the payment lifecycle, and past_due must not regress a grace period
    if (state === 'active' || state === 'trialing' || state === 'past_due') return applied('STATE_RECONCILED_NO_CHANGE', ctx.tenantId);
    try {
      if (state === 'canceled') { await this.entitlements.cancel(ctx, 'provider_subscription_canceled'); return applied('SUBSCRIPTION_CANCELED', ctx.tenantId); }
      await this.entitlements.suspend(ctx, 'provider_subscription_unpaid');
      return applied('SUBSCRIPTION_SUSPENDED', ctx.tenantId);
    } catch (error) {
      if (error instanceof SubscriptionNotFoundError) return refused('NO_SUBSCRIPTION', ctx.tenantId);
      if (error instanceof InvalidSubscriptionTransitionError) return refused('TRANSITION_NOT_ALLOWED', ctx.tenantId);
      throw error;
    }
  }
}
