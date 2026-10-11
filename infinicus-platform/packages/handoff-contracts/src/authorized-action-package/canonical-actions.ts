// Canonical ABA action vocabulary (P0-5 Block 3d; owner ruling G-1 refined).
//
// The MEANING of an action type (its target kinds, parameters, governance impact and applicability) is platform /
// shared-contract truth and lives here, versioned. A workspace's `action_type_definitions` row (migration 0178) is an
// activation / governance record for a code and version: it must equal the canonical contract and may never redefine it.
// The issuer compares the two and refuses on any divergence.
//
// Applicability is deliberately fail-closed: no governed field and no validity bound is NOT_APPLICABLE_ALLOWED until the
// owner rules otherwise (an unlisted rule is REQUIRED).

import { InMemoryActionTypeRegistry } from './action-types';
import type { ActionTypeContract, ActionTypeRegistry } from './action-types';
import { canonicalize } from './canonical';

/** Owner ruling 1 (code ruled snake_case in 3d so it fits the aap/1 and 0178 code pattern): BO inventory policy values, both numeric, min 0. */
export const INVENTORY_REORDER_POLICY_UPDATE_V1: ActionTypeContract = Object.freeze({
  code: 'inventory_reorder_policy_update',
  schemaVersion: '1',
  targetKinds: Object.freeze(['inventory_item']),
  parameters: Object.freeze({
    reorderPoint: Object.freeze({ type: 'number', required: true, min: 0 }),
    reorderQuantity: Object.freeze({ type: 'number', required: true, min: 0 }),
  }),
  governanceImpact: Object.freeze({
    reorderPoint: Object.freeze(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'EXPECTED_OUTCOME'] as const),
    reorderQuantity: Object.freeze(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const),
  }),
  applicability: Object.freeze({}),
} as ActionTypeContract);

/** Every canonical action contract the platform defines. Adding one is a reviewed code change, never workspace data. */
export const CANONICAL_ACTION_TYPES: readonly ActionTypeContract[] = Object.freeze([INVENTORY_REORDER_POLICY_UPDATE_V1]);

export function canonicalActionTypeRegistry(contracts: readonly ActionTypeContract[] = CANONICAL_ACTION_TYPES): ActionTypeRegistry {
  return new InMemoryActionTypeRegistry(contracts);
}

/**
 * True when a workspace-stored definition is exactly the canonical contract (order-independent canonical comparison).
 * The stored row carries no canonical-only fields, so equality is over the six contract members.
 */
export function actionTypeMatchesCanonical(stored: ActionTypeContract, canonical: ActionTypeContract): boolean {
  const pick = (c: ActionTypeContract): unknown => ({
    code: c.code, schemaVersion: c.schemaVersion, targetKinds: [...c.targetKinds].sort(), parameters: c.parameters,
    governanceImpact: Object.fromEntries(Object.entries(c.governanceImpact).map(([k, v]) => [k, [...v].sort()])),
    applicability: c.applicability,
  });
  try { return canonicalize(pick(stored)) === canonicalize(pick(canonical)); } catch { return false; }
}
