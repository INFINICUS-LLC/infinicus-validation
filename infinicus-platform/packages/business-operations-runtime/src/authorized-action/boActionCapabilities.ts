/**
 * Business Operations' OWN capability registry for authorized-action packages (P0-5 Block 3e; owner ruling Q6).
 *
 * "BO can execute this" is a Business Operations fact; "this is a valid authorized action" is ABA's. BO owns
 * `inventory_balances.reorder_point` / `reorder_quantity`, but the current runtime does NOT yet prove a production execution adapter
 * for `inventory_reorder_policy_update@1` before P0-6c; the adapter shipped there, and P0-6e declares the type here. Tests may inject their
 * own registry through {@link explicitCapabilities}; nothing here is fabricated to make a check pass.
 */
import type { ActionCapabilityRegistry } from '@infinicus/handoff-contracts';

/**
 * `code@schemaVersion` keys BO can execute in production. P0-6e registers exactly ONE: the first supported type, whose real adapter shipped
 * in P0-6c. This is capability only (key 1 of 3): it neither activates the type for any business, nor authorizes any action, nor bypasses
 * package validation, the BO claim, or the fresh authority check. An unlisted type stays fail-closed; there are no wildcards.
 */
export const PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string[] = Object.freeze(['inventory_reorder_policy_update@1']);

export function explicitCapabilities(supported: readonly string[]): ActionCapabilityRegistry {
  const keys = new Set(supported);
  return { supports: (code, schemaVersion) => keys.has(`${code}@${schemaVersion}`) };
}

export const PRODUCTION_BO_CAPABILITIES: ActionCapabilityRegistry = explicitCapabilities(PRODUCTION_SUPPORTED_ACTION_TYPES);
