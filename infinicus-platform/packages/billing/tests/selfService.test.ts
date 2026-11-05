/**
 * SEC-BILL-02A (SF-1): the self-service plan policy and its enforcement point, with stub repositories (no database). The point under test: a refused plan is refused BEFORE
 * any plan lookup or subscription write, and every refusal is the same error.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@infinicus/database';
import { EntitlementService } from '../src/EntitlementService.js';
import { PlanNotSelfServiceError } from '../src/errors.js';
import { SELF_SERVICE_PLAN_CODES, isSelfServicePlanCode } from '../src/selfService.js';

const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333' };
const freePlan = { id: 'plan-free', code: 'free', trialDays: 0 };

function make() {
  const plans = { getByCode: vi.fn(async (code: string) => ({ ...freePlan, code })) };
  const subscriptions = { create: vi.fn(async () => ({ id: 'sub-1' })) };
  const service = new EntitlementService(plans as never, subscriptions as never, {} as never, {} as never);
  return { service, plans, subscriptions };
}

describe('SELF_SERVICE_PLAN_CODES', () => {
  it('is exactly the free plan, frozen: nothing privileged, paid or negotiated is self-service', () => {
    expect([...SELF_SERVICE_PLAN_CODES]).toEqual(['free']);
    expect(Object.isFrozen(SELF_SERVICE_PLAN_CODES)).toBe(true);
    expect(() => (SELF_SERVICE_PLAN_CODES as string[]).push('enterprise')).toThrow();
  });
  it('matches EXACTLY: casing, padding, look-alikes, control characters, aliases and non-strings are all refused', () => {
    expect(isSelfServicePlanCode('free')).toBe(true);
    for (const v of ['Free', 'FREE', ' free', 'free ', 'free\n', 'free\u0000', 'frеe', '​free', 'free​', 'free,enterprise', 'enterprise', 'pro', '', 'f', 'fre', 'freee',
      undefined, null, 0, 1, true, false, {}, [], ['free'], { toString: () => 'free' }, Symbol('free')]) {
      expect(isSelfServicePlanCode(v), String(typeof v === 'symbol' ? 'symbol' : JSON.stringify(v))).toBe(false);
    }
  });
});

describe('EntitlementService.startSelfServiceSubscription', () => {
  it('refuses every non-allowlisted plan with ONE error, before any plan lookup or subscription write', async () => {
    for (const code of ['enterprise', 'pro', 'unknown-plan', 'Enterprise', 'free ', '', 123, null, {}, ['free']]) {
      const { service, plans, subscriptions } = make();
      const err = await service.startSelfServiceSubscription(ctx, code).catch((e: unknown) => e);
      expect(err, String(JSON.stringify(code))).toBeInstanceOf(PlanNotSelfServiceError);
      expect((err as Error).message).toBe('This plan cannot be started through self-service');
      expect(plans.getByCode).not.toHaveBeenCalled(); expect(subscriptions.create).not.toHaveBeenCalled();
    }
  });
  it('starts the free plan (explicit or default) through the normal path: plan looked up, then one subscription created from that plan', async () => {
    for (const call of [(s: EntitlementService) => s.startSelfServiceSubscription(ctx, 'free'), (s: EntitlementService) => s.startSelfServiceSubscription(ctx)]) {
      const { service, plans, subscriptions } = make();
      await call(service);
      expect(plans.getByCode).toHaveBeenCalledTimes(1); expect(plans.getByCode).toHaveBeenCalledWith('free');
      expect(subscriptions.create).toHaveBeenCalledTimes(1); expect(subscriptions.create).toHaveBeenCalledWith(ctx, { planId: 'plan-free', trialDays: 0 });
    }
  });
  it('the trusted internal startSubscription is unchanged (it can still start any plan: provisioning and commercial processes are not public routes)', async () => {
    const { service, plans } = make();
    await service.startSubscription(ctx, 'enterprise');
    expect(plans.getByCode).toHaveBeenCalledWith('enterprise');
  });
});
