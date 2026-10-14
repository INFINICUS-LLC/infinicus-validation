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

/**
 * Owner ruling D3D-1: the simulation reference is REQUIRED for every canonical action type unless its `code@schemaVersion` is listed
 * here. The rule is per type and version and is never generalized; a future type states its own governed applicability.
 *
 * B2c amendment (owner ruling, 2026-10-11; docs/architecture/reconciliation/P0-5_B2c_SIMULATION_NOT_APPLICABLE_AMENDMENT.md): exactly
 * `inventory_reorder_policy_update@1` may carry a governed NOT_APPLICABLE simulation reference, and only with the canonical reason
 * {@link SIMULATION_NOT_APPLICABLE_REASON_CODE}, because no Simulation model evaluates inventory reorder policy. Absence of a
 * simulation reference is never NOT_APPLICABLE; every other type keeps the D3D-1 requirement.
 */
export const SIMULATION_NOT_APPLICABLE_REASON_CODE = 'NO_APPLICABLE_SIMULATION_MODEL';

export const SIMULATION_NOT_APPLICABLE_ALLOWED: ReadonlySet<string> = Object.freeze(new Set<string>([
  `${INVENTORY_REORDER_POLICY_UPDATE_V1.code}@${INVENTORY_REORDER_POLICY_UPDATE_V1.schemaVersion}`,
])) as ReadonlySet<string>;

/**
 * AC-1 corrections (owner ruling 2): action types whose ABA authoring path REQUIRES a valid structured `adi-proposed-action/1` stored on the
 * source recommendation. Narrative-only recommendations and caller-supplied "proposals" are not an authoritative production path for them.
 * Per `code@schemaVersion`, exactly like the simulation allowance above: it is never global and a future type states its own requirement.
 */
export const STRUCTURED_ADI_PROPOSAL_REQUIRED: ReadonlySet<string> = Object.freeze(new Set<string>([
  `${INVENTORY_REORDER_POLICY_UPDATE_V1.code}@${INVENTORY_REORDER_POLICY_UPDATE_V1.schemaVersion}`,
])) as ReadonlySet<string>;

/**
 * AC-2 Block 7: action types whose structured ADI proposal must cite the governed Business Intelligence evidence AND the Business Digital Twin state it was
 * derived from (one reference each, bound to the same fact digest), so the principal path never rests on an ad-hoc Business Operations snapshot. Per
 * `code@schemaVersion`, never global; a future type states its own requirement.
 */
export const BI_BDT_EVIDENCE_REQUIRED: ReadonlySet<string> = Object.freeze(new Set<string>([
  `${INVENTORY_REORDER_POLICY_UPDATE_V1.code}@${INVENTORY_REORDER_POLICY_UPDATE_V1.schemaVersion}`,
])) as ReadonlySet<string>;

/**
 * AC-2 (owner ruling 1): the BASE risk class of an action type is canonical action-type governance, defined exactly here and nowhere else.
 * Per `code@schemaVersion`, never global; a type with no entry has no base class (its risk stays whatever the P0-2/P0-3 evidence supports,
 * and unclassified is treated as high). Consumers: the ADI risk derivation takes it as a deterministic FLOOR input (ADI does not classify),
 * and the ABA issuance policy refuses a package whose persisted recommendation risk is below it. Contextual risk (persisted profiles,
 * generator level, authorised human raise) can only raise the result above this floor.
 */
export type CanonicalBaseRiskClass = 'low' | 'medium' | 'high' | 'critical';
export const CANONICAL_BASE_RISK_CLASS: ReadonlyMap<string, CanonicalBaseRiskClass> = Object.freeze(new Map<string, CanonicalBaseRiskClass>([
  [`${INVENTORY_REORDER_POLICY_UPDATE_V1.code}@${INVENTORY_REORDER_POLICY_UPDATE_V1.schemaVersion}`, 'medium'],
])) as ReadonlyMap<string, CanonicalBaseRiskClass>;
export const canonicalBaseRiskClass = (code: string, schemaVersion: string): CanonicalBaseRiskClass | null => CANONICAL_BASE_RISK_CLASS.get(`${code}@${schemaVersion}`) ?? null;

/**
 * Why a governed NOT_APPLICABLE simulation reference is refused for this action type, or null when it is permitted. Used by every
 * writer and by the issuance policy so the rule cannot drift: the type must be listed AND the reason code must be exactly canonical.
 */
export function simulationNotApplicableProblem(
  allowed: ReadonlySet<string>, actionCode: string, schemaVersion: string, reason: { code?: unknown } | undefined,
): string | null {
  if (!allowed.has(`${actionCode}@${schemaVersion}`)) {
    return `${actionCode}@${schemaVersion} requires a simulation run reference; NOT_APPLICABLE is not permitted`;
  }
  if (!reason || reason.code !== SIMULATION_NOT_APPLICABLE_REASON_CODE) {
    return `a NOT_APPLICABLE simulation reference for ${actionCode}@${schemaVersion} must carry the reason code ${SIMULATION_NOT_APPLICABLE_REASON_CODE}`;
  }
  return null;
}

export const actionTypeKey = (code: string, schemaVersion: string): string => `${code}@${schemaVersion}`;

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
