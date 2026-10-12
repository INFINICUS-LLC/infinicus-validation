/**
 * What Outcome Monitoring can AUTHORITATIVELY observe about `inventory_reorder_policy_update@1` today (P0-6d, Block 5). Data, not logic.
 *
 * The finding that governs everything else: changing a reorder point/quantity changes a POLICY, not stock. The first thing it can alter is
 * the next reorder-below-point evaluation, and any downstream effect (fewer stock-outs, lower holding cost) needs a window of real demand
 * and a causal argument that this repository does not have. So OM can establish that the policy value changed (an execution fact it
 * verifies from evidence), but not - yet - that the change helped. No minimum observation window has an owner-approved value, and none is
 * invented here.
 *
 * Each entry names what a measurement would need. `authoritative: false` means OM must record OUTCOME_PENDING / OUTCOME_INCONCLUSIVE and
 * must never fabricate a pass.
 */
export interface MeasurementAuthority {
  measurement: string;
  /** Where the observation would come from; null when no governed source exists. */
  source: string | null;
  /** Whether the measurement is available immediately after execution or needs elapsed time. */
  immediacy: 'IMMEDIATE' | 'REQUIRES_WINDOW';
  /** Baseline the comparison would use; null when none is provable. */
  baseline: string | null;
  /** Observation window; null because no owner-approved value exists (never invented). */
  window: null;
  scopeProof: string;
  causalAttribution: 'UNSUPPORTED' | 'NOT_REQUIRED';
  authoritative: boolean;
  note: string;
}

export const INVENTORY_REORDER_POLICY_UPDATE_MEASUREMENTS: readonly MeasurementAuthority[] = Object.freeze([
  {
    measurement: 'policy value now equals the requested value',
    source: 'BO execution evidence (mutation.after) re-read through the BO evidence port',
    immediacy: 'IMMEDIATE', baseline: 'mutation.before in the same evidence', window: null,
    scopeProof: 'evidence identity scope equals the event scope equals the delivery scope', causalAttribution: 'NOT_REQUIRED', authoritative: true,
    note: 'This is an EXECUTION fact (EXECUTION_VERIFIED). It says the change happened, never that it helped.',
  },
  {
    measurement: 'stock-out frequency after the change',
    source: null, immediacy: 'REQUIRES_WINDOW', baseline: null, window: null,
    scopeProof: 'same balance (item, warehouse) in the same business', causalAttribution: 'UNSUPPORTED', authoritative: false,
    note: 'Needs an approved window, demand history and a causal argument against other changes. None exists: OUTCOME_PENDING.',
  },
  {
    measurement: 'holding cost after the change',
    source: null, immediacy: 'REQUIRES_WINDOW', baseline: null, window: null,
    scopeProof: 'same balance (item, warehouse) in the same business', causalAttribution: 'UNSUPPORTED', authoritative: false,
    note: 'Unit cost and currency are not provable for existing data (data-capture block C/B open). OUTCOME_INCONCLUSIVE until they are.',
  },
  {
    measurement: 'reorder orders raised by the new policy',
    source: null, immediacy: 'REQUIRES_WINDOW', baseline: null, window: null,
    scopeProof: 'purchase orders linked to the item', causalAttribution: 'UNSUPPORTED', authoritative: false,
    note: 'Purchase-order to inventory-item linkage is not reliable yet (data-capture block D). OUTCOME_PENDING.',
  },
] as const);

/** The action types Outcome Monitoring can verify an execution of. Execution verification only; it does not make any outcome measurable. */
export const OM_VERIFIABLE_ACTION_TYPES: readonly { code: string; schemaVersion: string }[] = Object.freeze([
  Object.freeze({ code: 'inventory_reorder_policy_update', schemaVersion: '1' }),
]);
