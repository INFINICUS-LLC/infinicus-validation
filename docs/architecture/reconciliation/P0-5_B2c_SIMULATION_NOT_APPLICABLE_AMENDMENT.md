# P0-5 B2c — Architecture amendment: governed Simulation NOT_APPLICABLE for `inventory_reorder_policy_update@1`

Status: owner-authorised amendment (B2c authorization and rulings, 11 October 2026). Narrow by design.

1. **Affected action:** `inventory_reorder_policy_update` schemaVersion `1`, and nothing else.
2. **Previous state:** Simulation reference required; `SIMULATION_NOT_APPLICABLE_ALLOWED` was empty (owner ruling D3D-1), so NOT_APPLICABLE was refused.
3. **Amended state:** the Simulation reference may be a governed `NOT_APPLICABLE` for this action type and version.
4. **Canonical reason (exact, case-sensitive):** `NO_APPLICABLE_SIMULATION_MODEL` (`SIMULATION_NOT_APPLICABLE_REASON_CODE`).
5. **Rationale:** no Simulation model evaluates inventory reorder policy, so no Simulation run can provide relevant scenario evidence.
6. **Compensation:** the Business Operations `EXPECTED_OUTCOME` evaluation (rule set `inventory-reorder-policy/v1.0.0`, E1–E3) supplies the action-relevant operational evaluation required for a Level-2 modified approval; all four BO dimensions must verify.
7. **Scope:** no other action type is affected. The set is per `code@schemaVersion`; a future type or version states its own applicability.
8. **Future:** if an authoritative inventory Simulation model is introduced, a separately authorised policy/contract revision may remove the exemption.

## Implementation (single definition, no parallel vocabulary)
`packages/handoff-contracts/src/authorized-action-package/canonical-actions.ts`:
- `SIMULATION_NOT_APPLICABLE_ALLOWED` = exactly `{ 'inventory_reorder_policy_update@1' }` (frozen);
- `SIMULATION_NOT_APPLICABLE_REASON_CODE = 'NO_APPLICABLE_SIMULATION_MODEL'`;
- `simulationNotApplicableProblem(allowed, code, schemaVersion, reason)` — null only when the type is listed AND the reason code is exactly canonical.

Both gates use that helper, so they cannot drift: `AbaAuthoringService.authorBoundaries` (authoring) and `packageIssuancePolicy` (issuance, refusal `SIMULATION_REQUIRED`).

## What this does NOT change
- Simulation stays required (D3D-1) for every other type and version; there is no global optionality.
- Absence of a simulation reference is never converted to NOT_APPLICABLE (the field remains mandatory and governed: `VALUE` or `NOT_APPLICABLE`).
- A `VALUE` reference is still verified as a real, in-scope, completed run; an unrelated run is not required and does not substitute for the governed state.
- No database change: migration 0179 already accepts any governed NOT_APPLICABLE; the type/reason gate lives in the contract and the two ABA writers above.
