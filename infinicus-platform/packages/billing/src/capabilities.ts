/**
 * The application capability vocabulary and the entitlement profile (POS2-01). A capability is what a tenant may USE; it is derived from the tenant's
 * subscription state and is deliberately not a provider product name, a plan code or a price. Billing providers supply commercial subscription state;
 * INFINICUS decides capabilities here. Entitlement is also not a role and not a business policy: all three can be required for one action.
 *
 * Compatibility profile (the only profile that exists today): the platform has one subscription per tenant and no capability catalogue, so every
 * functional subscription (trialing, active, past_due, grace_period) holds every capability and a suspended or canceled one holds none. That is exactly
 * what `requireActiveSubscription` already decides, so wiring a route to `requireCapability` changes nothing for any tenant. Independent purchase of
 * POS Core and of intelligence is a later block (POS2-02) and needs owner decisions on the commercial model; nothing here prices or sells anything.
 */
export const CAPABILITIES = [
  'pos.core', 'pos.inventory', 'pos.multi_branch', 'pos.restaurant', 'pos.offline',
  'intelligence.explorer', 'intelligence.starter', 'intelligence.growth', 'intelligence.pro',
  'enterprise.custom_integrations', 'enterprise.custom_limits',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface EntitlementProfile {
  /**
   * `compatibility`: derived only from subscription state (see above), used while a tenant has no row in the entitlement store.
   * `store`: read from billing.entitlements; once a tenant has any row there, the store alone decides (a revoked or expired row means "no", never a fallback).
   */
  readonly basis: 'compatibility' | 'store';
  readonly capabilities: ReadonlySet<Capability>;
}

const FUNCTIONAL_STATUSES: ReadonlySet<string> = new Set(['trialing', 'active', 'past_due', 'grace_period']);

/** Pure and fail-closed: an unknown or non-functional status yields no capability at all. */
export function entitlementProfileFor(subscriptionStatus: string): EntitlementProfile {
  return { basis: 'compatibility', capabilities: FUNCTIONAL_STATUSES.has(subscriptionStatus) ? new Set(CAPABILITIES) : new Set() };
}

/**
 * The profile of a tenant that has entitlement rows. Fail closed: only capabilities in the vocabulary count, so an unknown key in the store grants nothing.
 */
export function entitlementProfileFromStore(effectiveCapabilities: readonly string[]): EntitlementProfile {
  return { basis: 'store', capabilities: new Set(effectiveCapabilities.filter(isCapability)) };
}

export const isCapability = (value: string): value is Capability => (CAPABILITIES as readonly string[]).includes(value);
