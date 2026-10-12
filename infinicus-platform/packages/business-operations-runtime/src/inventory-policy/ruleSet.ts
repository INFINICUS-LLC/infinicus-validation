/**
 * Approved rule sets for `inventory_reorder_policy_update@1` (Block B2b).
 *
 * The ONLY rule-set version that exists is the owner-approved `inventory-reorder-policy/v1.0.0`
 * (docs/architecture/reconciliation/P0-5_B2_RULE_SET_inventory-reorder-policy_v1.0.0.md, section 12). Its values are owner-defined pre-launch
 * policy values and are NOT data-derived. A test compares every value below with the approval record so the code cannot drift from it.
 *
 * There is deliberately NO default version: callers must name one, and an unknown, draft or future version is refused. A caller can name a
 * version but can never supply thresholds. A parameter that is `undefined` means "unset" and makes its rule INDETERMINATE (`PARAMETER_UNSET`);
 * nothing here falls back to a default.
 */
/**
 * EVIDENCE_MAX_AGE of rule set `inventory-reorder-policy/v1.0.0` (owner-approved: 24 hours; B2c ruling 3): the oldest a BO evaluation may be
 * (measured on the database clock) and still be verified as evidence. This is the ONE definition; the verifier reads it through the
 * resolved rule set's `maxEvidenceAgeMs`. It is policy for this rule-set version only - not a global default for any other action type.
 */
export const INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export interface InventoryReorderRuleSet {
  readonly version: string;
  /** Percent of the current non-zero baseline (MAX_CHANGE_REORDER_POINT_PCT). */
  readonly maxChangeReorderPointPct?: number;
  readonly maxChangeReorderQuantityPct?: number;
  /** Policy cap on one implied order value, denominated in `orderValueCapCurrency`. */
  readonly orderValueCap?: number;
  readonly orderValueCapCurrency?: string;
  /** Percent of `orderValueCap` that one approval may add to the implied order value. */
  readonly maxChangeOrderValuePctOfCap?: number;
  /** Nominal policy cap on reorderPoint + reorderQuantity, in the item's own unit_of_measure. NOT physical capacity. */
  readonly maxImpliedStockUnits?: number;
  readonly leadTimeDays?: number;
  readonly safetyFactor?: number;
  readonly maxCoverDays?: number;
  /** Q-F1: whether an item with a zero (unset) baseline may be changed. v1.0.0: false. */
  readonly firstConfigurationAllowed?: boolean;
  /** Governance/methodology constants. */
  readonly demandWindowDays: number;
  readonly demandMovementTypes: readonly string[];
  readonly minDemandObservations: number;
  /** Oldest evaluation (database clock) that still verifies as evidence, in milliseconds (EVIDENCE_MAX_AGE). */
  readonly maxEvidenceAgeMs: number;
}

export const INVENTORY_REORDER_POLICY_RULE_SET_ID = 'inventory-reorder-policy';

export const INVENTORY_REORDER_POLICY_V1_0_0: InventoryReorderRuleSet = Object.freeze({
  version: 'inventory-reorder-policy/v1.0.0',
  maxChangeReorderPointPct: 25,
  maxChangeReorderQuantityPct: 25,
  orderValueCap: 5000,
  orderValueCapCurrency: 'USD',
  maxChangeOrderValuePctOfCap: 25,
  maxImpliedStockUnits: 500,
  leadTimeDays: 14,
  safetyFactor: 1.25,
  maxCoverDays: 90,
  firstConfigurationAllowed: false,
  demandWindowDays: 90,
  demandMovementTypes: Object.freeze(['issue']),
  minDemandObservations: 10,
  maxEvidenceAgeMs: INVENTORY_REORDER_POLICY_V1_MAX_EVIDENCE_AGE_MS,
});

/** Every approved version, keyed by its stored `rule_set_version` string. The registry is closed: nothing registers at runtime. */
const APPROVED: ReadonlyMap<string, InventoryReorderRuleSet> = new Map([[INVENTORY_REORDER_POLICY_V1_0_0.version, INVENTORY_REORDER_POLICY_V1_0_0]]);

export class RuleSetNotApprovedError extends Error {
  constructor(readonly requested: string, reason: string) {
    super(`Rule set "${requested}" is not an approved rule-set version: ${reason}`);
    this.name = 'ValidationError';
  }
}

/** Resolves an approved rule set by its exact version string. Unknown, draft, empty or future versions are refused; there is no default. */
export function resolveApprovedRuleSet(version: unknown): InventoryReorderRuleSet {
  if (typeof version !== 'string' || version.trim().length === 0) throw new RuleSetNotApprovedError(String(version), 'a rule-set version must be named explicitly (there is no default)');
  if (/draft/i.test(version)) throw new RuleSetNotApprovedError(version, 'a DRAFT version is never effective');
  const found = APPROVED.get(version);
  if (found === undefined) throw new RuleSetNotApprovedError(version, 'unknown or not yet approved');
  return found;
}

export const approvedRuleSetVersions = (): string[] => [...APPROVED.keys()];
