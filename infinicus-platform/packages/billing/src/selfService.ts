/**
 * SEC-BILL-02A (SF-1): the plans a tenant may start for itself through the PUBLIC self-service route (POST /v1/billing/trial).
 *
 * Eligibility is a SERVER-SIDE policy, never a property of what the client names. The list is code, reviewed and versioned, not configuration a request or environment can
 * widen. It is deliberately minimal and fail-closed: until a commercial policy is approved by the owner only the free plan (no payment, no trial, no privileged limits or
 * features) may be started this way. Every other plan - enterprise (negotiated, unlimited), pro (paid, 14-day trial) and any plan added later - is started only by a trusted
 * internal / commercial process through `EntitlementService.startSubscription`.
 *
 * Matching is EXACT (case, whitespace and Unicode are significant): no normalisation, alias or prefix rule exists to bypass. Adding a plan here is an owner decision.
 */
export const SELF_SERVICE_PLAN_CODES: readonly string[] = Object.freeze(['free']);

export function isSelfServicePlanCode(value: unknown): value is string {
  return typeof value === 'string' && SELF_SERVICE_PLAN_CODES.includes(value);
}
