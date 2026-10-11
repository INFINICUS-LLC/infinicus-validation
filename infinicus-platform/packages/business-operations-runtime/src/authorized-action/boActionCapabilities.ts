/**
 * Business Operations' OWN capability registry for authorized-action packages (P0-5 Block 3e; owner ruling Q6).
 *
 * "BO can execute this" is a Business Operations fact; "this is a valid authorized action" is ABA's. BO owns
 * `inventory_balances.reorder_point` / `reorder_quantity`, but the current runtime does NOT yet prove a production execution adapter
 * for `inventory_reorder_policy_update@1`. Therefore NO action type is production-supported yet, and this registry is deliberately
 * empty: a package for that type can be received but is never executable here. The real adapter, and the entry that declares it, arrive
 * with P0-6. Tests inject their own registry through {@link explicitCapabilities}; nothing here is fabricated to make a check pass.
 */
import type { ActionCapabilityRegistry } from '@infinicus/handoff-contracts';

/** `code@schemaVersion` keys BO can execute in production. EMPTY until P0-6 implements a real execution adapter. */
export const PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string[] = Object.freeze([]);

export function explicitCapabilities(supported: readonly string[]): ActionCapabilityRegistry {
  const keys = new Set(supported);
  return { supports: (code, schemaVersion) => keys.has(`${code}@${schemaVersion}`) };
}

export const PRODUCTION_BO_CAPABILITIES: ActionCapabilityRegistry = explicitCapabilities(PRODUCTION_SUPPORTED_ACTION_TYPES);
