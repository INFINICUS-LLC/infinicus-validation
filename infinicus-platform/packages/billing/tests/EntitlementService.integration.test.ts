/**
 * Live PostgreSQL 16 integration tests for BUILD-28's EntitlementService —
 * the single server-side enforcement point for subscription status,
 * feature gating, and usage-limit checks.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced)
 *   ADMIN_DATABASE_URL — infinicus_test_admin (BYPASSRLS, fixture setup)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, UsageLimitExceededError, type TenantContext } from '@infinicus/database';
import { EntitlementService } from '../src/EntitlementService.js';
import { SubscriptionSuspendedError, SubscriptionCanceledError, FeatureNotEntitledError, CapabilityNotEntitledError } from '../src/errors.js';

const run = !!process.env.DATABASE_URL;

let adminPool: Pool;

async function makeTenantCtx(label: string): Promise<TenantContext> {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await adminPool.query(
    `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`,
    [tenantId, `Entitlement Test ${label}`, `entitlement-${label}-${suffix}`]
  );
  await adminPool.query(
    `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`,
    [workspaceId, tenantId, `Entitlement Test WS ${label}`, `entitlement-ws-${label}-${suffix}`]
  );
  return { tenantId, workspaceId, userId: randomUUID() };
}

describe.runIf(run)('EntitlementService — live PostgreSQL', () => {
  const service = new EntitlementService();

  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await adminPool.end();
    await closePool();
  });

  it('starts a free subscription by default and it is immediately active (no trial)', async () => {
    const ctx = await makeTenantCtx('free-default');
    const { subscription, plan } = await service.startSubscription(ctx);
    expect(plan.code).toBe('free');
    expect(subscription.status).toBe('active'); // free plan has trialDays 0
  });

  it('starts a pro subscription in trialing status with a trial end date', async () => {
    const ctx = await makeTenantCtx('pro-trial');
    const { subscription, plan } = await service.startSubscription(ctx, 'pro');
    expect(plan.code).toBe('pro');
    expect(subscription.status).toBe('trialing');
    expect(subscription.trialEndsAt).not.toBeNull();
  });

  it('lazily provisions a free-plan subscription for a tenant that never engaged with billing, instead of blocking it', async () => {
    const ctx = await makeTenantCtx('lazy-provision');
    // No startSubscription() call — this tenant has no subscription row at all.
    const subscription = await service.enforceActiveSubscription(ctx);
    expect(subscription.status).toBe('active');
    const { plan } = await service.getSubscriptionWithPlan(ctx);
    expect(plan.code).toBe('free');
  });

  it('concurrent first-time enforceActiveSubscription calls for the same tenant do not race into duplicate subscriptions', async () => {
    const ctx = await makeTenantCtx('lazy-provision-race');
    const results = await Promise.all(Array.from({ length: 10 }, () => service.enforceActiveSubscription(ctx)));
    const subscriptionIds = new Set(results.map((s) => s.id));
    expect(subscriptionIds.size).toBe(1); // every call resolved to the same, single subscription row
  });

  it('enforceActiveSubscription passes for trialing/active but throws for suspended/canceled', async () => {
    const ctx = await makeTenantCtx('lifecycle');
    await service.startSubscription(ctx, 'free');
    await expect(service.enforceActiveSubscription(ctx)).resolves.toBeDefined();

    await service.suspend(ctx, 'test_suspension');
    await expect(service.enforceActiveSubscription(ctx)).rejects.toThrow(SubscriptionSuspendedError);

    await service.reactivate(ctx, 'test_reactivation');
    await expect(service.enforceActiveSubscription(ctx)).resolves.toBeDefined();

    await service.cancel(ctx, 'test_cancellation');
    await expect(service.enforceActiveSubscription(ctx)).rejects.toThrow(SubscriptionCanceledError);
  });

  it('enforceCapability behaves exactly like enforceActiveSubscription for a known capability, and refuses an unknown one (POS2-01)', async () => {
    const ctx = await makeTenantCtx('capability');
    await service.startSubscription(ctx, 'free');
    await expect(service.enforceCapability(ctx, 'pos.core')).resolves.toBeUndefined();
    await expect(service.enforceCapability(ctx, 'intelligence.pro')).resolves.toBeUndefined();   // compatibility profile: no capability catalogue yet
    await expect(service.enforceCapability(ctx, 'pos.nope' as never)).rejects.toThrow(CapabilityNotEntitledError);

    await service.suspend(ctx, 'test_suspension');
    await expect(service.enforceCapability(ctx, 'pos.core')).rejects.toThrow(SubscriptionSuspendedError);
    await service.reactivate(ctx, 'test_reactivation');
    await expect(service.enforceCapability(ctx, 'pos.core')).resolves.toBeUndefined();
    await service.cancel(ctx, 'test_cancellation');
    await expect(service.enforceCapability(ctx, 'pos.core')).rejects.toThrow(SubscriptionCanceledError);
  });

  it('a tenant with no subscription row is lazily provisioned and holds the capability, as with the subscription gate (POS2-01)', async () => {
    const ctx = await makeTenantCtx('capability-lazy');
    await expect(service.enforceCapability(ctx, 'pos.core')).resolves.toBeUndefined();
  });

  it('gates features by plan: free lacks apiAccess, pro has it', async () => {
    const freeCtx = await makeTenantCtx('feature-free');
    await service.startSubscription(freeCtx, 'free');
    expect(await service.hasFeature(freeCtx, 'apiAccess')).toBe(false);
    await expect(service.enforceFeature(freeCtx, 'apiAccess')).rejects.toThrow(FeatureNotEntitledError);

    const proCtx = await makeTenantCtx('feature-pro');
    await service.startSubscription(proCtx, 'pro');
    expect(await service.hasFeature(proCtx, 'apiAccess')).toBe(true);
    await expect(service.enforceFeature(proCtx, 'apiAccess')).resolves.toBeUndefined();
  });

  it('enforces the free plan\'s simulationRunsPerMonth limit (20) fail-closed', async () => {
    const ctx = await makeTenantCtx('usage-limit');
    await service.startSubscription(ctx, 'free');

    const afterNineteen = await service.recordUsageAndEnforceLimit(ctx, 'simulation_runs', 19);
    expect(afterNineteen).toBe(19);
    const afterTwenty = await service.recordUsageAndEnforceLimit(ctx, 'simulation_runs', 1);
    expect(afterTwenty).toBe(20);

    await expect(service.recordUsageAndEnforceLimit(ctx, 'simulation_runs', 1)).rejects.toThrow(UsageLimitExceededError);
    expect(await service.getCurrentUsage(ctx, 'simulation_runs')).toBe(20); // rejected attempt not persisted
  });

  it('does not allow metered usage at all once the subscription is suspended', async () => {
    const ctx = await makeTenantCtx('usage-suspended');
    await service.startSubscription(ctx, 'free');
    await service.suspend(ctx, 'test_suspension');
    await expect(service.recordUsageAndEnforceLimit(ctx, 'simulation_runs', 1)).rejects.toThrow(SubscriptionSuspendedError);
  });

  it('enterprise plan has no usage limit (unlimited)', async () => {
    const ctx = await makeTenantCtx('unlimited');
    await service.startSubscription(ctx, 'enterprise');
    const result = await service.recordUsageAndEnforceLimit(ctx, 'reasoning_runs', 999_999);
    expect(result).toBe(999_999);
  });

  it('a failed payment moves an active subscription into grace_period with a real end date; a subsequent successful payment reactivates it', async () => {
    const ctx = await makeTenantCtx('payment-lifecycle');
    await service.startSubscription(ctx, 'free');

    const afterFailure = await service.recordPaymentResult(ctx, 'failed', 'ext-invoice-001');
    expect(afterFailure.status).toBe('grace_period');
    expect(afterFailure.paymentStatus).toBe('failed');
    expect(afterFailure.gracePeriodEndsAt).not.toBeNull();
    expect(afterFailure.gracePeriodEndsAt!.getTime()).toBeGreaterThan(Date.now());

    const afterSuccess = await service.recordPaymentResult(ctx, 'paid', 'ext-invoice-002');
    expect(afterSuccess.status).toBe('active');
    expect(afterSuccess.paymentStatus).toBe('paid');
    expect(afterSuccess.gracePeriodEndsAt).toBeNull();
  });

  it('a pending payment updates payment_status without changing the lifecycle status', async () => {
    const ctx = await makeTenantCtx('payment-pending');
    const { subscription: before } = await service.startSubscription(ctx, 'free');
    const after = await service.recordPaymentResult(ctx, 'pending');
    expect(after.status).toBe(before.status); // unchanged
    expect(after.paymentStatus).toBe('pending');
  });
});

describe.skipIf(run)('EntitlementService — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
