import {
  PlanRepository, SubscriptionRepository, UsageRepository, SubscriptionNotFoundError,
  type TenantContext, type Subscription, type Plan, type UsageMetric, type PaymentStatus,
} from '@infinicus/database';
import { SubscriptionSuspendedError, SubscriptionCanceledError, FeatureNotEntitledError, CapabilityNotEntitledError } from './errors.js';
import { entitlementProfileFor, type Capability } from './capabilities.js';

export interface SubscriptionWithPlan {
  subscription: Subscription;
  plan: Plan;
}

/** How long a grace period lasts after a payment failure, before automatic suspension. */
const DEFAULT_GRACE_PERIOD_DAYS = 7;

/**
 * The single place that decides whether a tenant is allowed to do
 * something billing-gated — every check here is server-side and
 * fail-closed (an unexpected subscription state is treated as "not
 * entitled", never silently allowed). Route handlers call this instead
 * of inlining subscription/plan/usage logic (see
 * apps/api/src/plugins/billing.ts).
 */
export class EntitlementService {
  constructor(
    private readonly plans: PlanRepository = new PlanRepository(),
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
    private readonly usage: UsageRepository = new UsageRepository()
  ) {}

  async getSubscriptionWithPlan(ctx: TenantContext): Promise<SubscriptionWithPlan> {
    const subscription = await this.getOrCreateSubscription(ctx);
    const plan = await this.plans.getById(subscription.planId);
    return { subscription, plan };
  }

  /** Starts a tenant's first subscription. planCode defaults to 'free' (no card, no trial needed). */
  async startSubscription(ctx: TenantContext, planCode = 'free'): Promise<SubscriptionWithPlan> {
    const plan = await this.plans.getByCode(planCode);
    const subscription = await this.subscriptions.create(ctx, { planId: plan.id, trialDays: plan.trialDays });
    return { subscription, plan };
  }

  /**
   * Fail-closed: throws if the tenant's subscription is suspended or
   * canceled. 'trialing', 'active', 'past_due', and 'grace_period' are
   * all still functional states (past_due/grace_period are warnings, not
   * hard blocks — matching how most real billing systems keep service
   * running through a short payment-recovery window rather than cutting
   * a tenant off at the first failed charge). A tenant with NO
   * subscription row at all (never engaged with billing — e.g. every
   * tenant onboarded before this build existed) is lazily provisioned
   * onto the free plan on first check here rather than being blocked:
   * "no subscription yet" and "suspended" are different states, and only
   * the latter is a real billing failure this build should fail closed
   * on.
   */
  async enforceActiveSubscription(ctx: TenantContext): Promise<Subscription> {
    const subscription = await this.getOrCreateSubscription(ctx);
    if (subscription.status === 'suspended') throw new SubscriptionSuspendedError();
    if (subscription.status === 'canceled') throw new SubscriptionCanceledError();
    return subscription;
  }

  /**
   * Fail-closed capability gate (POS2-01). A suspended or canceled subscription throws the same errors as `enforceActiveSubscription` (402, same text),
   * so a route moved from the subscription gate to this one behaves identically; an unknown capability key or one the profile does not hold is refused.
   */
  async enforceCapability(ctx: TenantContext, capability: Capability): Promise<void> {
    const subscription = await this.enforceActiveSubscription(ctx);
    if (!entitlementProfileFor(subscription.status).capabilities.has(capability)) {
      throw new CapabilityNotEntitledError(String(capability));
    }
  }

  private async getOrCreateSubscription(ctx: TenantContext): Promise<Subscription> {
    try {
      return await this.subscriptions.getByTenant(ctx);
    } catch (err) {
      if (!(err instanceof SubscriptionNotFoundError)) throw err;
      try {
        const { subscription } = await this.startSubscription(ctx, 'free');
        return subscription;
      } catch {
        // Lost a race with a concurrent lazy-provision for the same
        // tenant (SubscriptionAlreadyExistsError) — the other caller
        // already created it; just read it back.
        return this.subscriptions.getByTenant(ctx);
      }
    }
  }

  async hasFeature(ctx: TenantContext, featureKey: string): Promise<boolean> {
    const { plan } = await this.getSubscriptionWithPlan(ctx);
    return plan.features[featureKey] === true;
  }

  /** Fail-closed feature gate: throws rather than returning false for the caller to (possibly) ignore. */
  async enforceFeature(ctx: TenantContext, featureKey: string): Promise<void> {
    if (!(await this.hasFeature(ctx, featureKey))) throw new FeatureNotEntitledError(featureKey);
  }

  /**
   * The single entry point for every metered, limited action: verifies
   * the subscription is active, resolves the plan's limit for `metric`,
   * and atomically increments usage — rejecting fail-closed (via
   * UsageRepository's own compensating-decrement logic, re-exported as
   * UsageLimitExceededError from @infinicus/database) if the plan's
   * limit would be exceeded. The limit key convention is
   * `${metric}PerMonth` in camelCase (e.g. simulation_runs ->
   * simulationRunsPerMonth) — see billing.plans.limits in migration 0150.
   */
  async recordUsageAndEnforceLimit(ctx: TenantContext, metric: UsageMetric, quantity = 1): Promise<number> {
    const { plan } = await this.getSubscriptionWithPlanAfterEnforcingActive(ctx);
    const limitKey = `${toCamelCase(metric)}PerMonth`;
    const limitValue = plan.limits[limitKey] ?? null;
    return this.usage.incrementAndCheck(ctx, metric, quantity, limitValue);
  }

  async getCurrentUsage(ctx: TenantContext, metric: UsageMetric): Promise<number> {
    return this.usage.getCurrent(ctx, metric);
  }

  /**
   * Records an external payment result and applies its lifecycle
   * consequence: 'paid' clears any grace period and (re)activates the
   * subscription; 'failed' starts (or restarts) a grace period and
   * leaves the subscription otherwise functional until the grace period
   * elapses (see the lifecycle-audit script for automatic suspension);
   * 'pending' updates payment_status only, no lifecycle change.
   */
  async recordPaymentResult(
    ctx: TenantContext, status: PaymentStatus, externalInvoiceReference: string | null = null
  ): Promise<Subscription> {
    const subscription = await this.subscriptions.getByTenant(ctx);
    await this.subscriptions.recordPayment(ctx, subscription.id, status, externalInvoiceReference);

    if (status === 'paid' && (subscription.status === 'grace_period' || subscription.status === 'past_due' || subscription.status === 'trialing')) {
      return this.subscriptions.transitionStatus(ctx, subscription.id, 'active', 'payment_succeeded', {
        gracePeriodEndsAt: null,
      });
    }
    if (status === 'failed' && (subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'past_due')) {
      const gracePeriodEndsAt = new Date(Date.now() + DEFAULT_GRACE_PERIOD_DAYS * 86_400_000);
      return this.subscriptions.transitionStatus(ctx, subscription.id, 'grace_period', 'payment_failed', { gracePeriodEndsAt });
    }
    return this.subscriptions.getByTenant(ctx);
  }

  async suspend(ctx: TenantContext, reason: string): Promise<Subscription> {
    const subscription = await this.subscriptions.getByTenant(ctx);
    return this.subscriptions.transitionStatus(ctx, subscription.id, 'suspended', reason);
  }

  async reactivate(ctx: TenantContext, reason: string): Promise<Subscription> {
    const subscription = await this.subscriptions.getByTenant(ctx);
    return this.subscriptions.transitionStatus(ctx, subscription.id, 'active', reason, { gracePeriodEndsAt: null, paymentStatus: 'paid' });
  }

  async cancel(ctx: TenantContext, reason: string): Promise<Subscription> {
    const subscription = await this.subscriptions.getByTenant(ctx);
    return this.subscriptions.transitionStatus(ctx, subscription.id, 'canceled', reason);
  }

  private async getSubscriptionWithPlanAfterEnforcingActive(ctx: TenantContext): Promise<SubscriptionWithPlan> {
    const subscription = await this.enforceActiveSubscription(ctx);
    const plan = await this.plans.getById(subscription.planId);
    return { subscription, plan };
  }
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
