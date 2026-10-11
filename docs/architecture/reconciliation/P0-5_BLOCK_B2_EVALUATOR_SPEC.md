# P0-5/P0-6 preparation — Block B2: BO-owned inventory policy evaluator (SPECIFICATION ONLY)

Status: specification for owner review. **No code, no migration allocated.** Owner direction (Block B survey, ruling 2): Option A, a
Business Operations (BO) owned evaluator. Builds on B1 (`GovernanceEvidenceVerifier` port, merged in #72).

## 1. Purpose

Make a modified `inventory_reorder_policy_update@1` approval capturable with **authoritative** evidence: for CONSTRAINTS,
RESOURCE_REQUIREMENTS, COST and EXPECTED_OUTCOME, a BO component evaluates the modified `reorderPoint` / `reorderQuantity` against
BO's own operational truth, records the evaluation immutably, and ABA verifies the recorded evaluation through the B1 port. ABA never
reads BO tables; BO never reads ABA tables.

## 2. Ownership and boundaries

```
BO (business-operations-runtime)               apps/api composition root                ABA (workflow)
 InventoryPolicyEvaluationService  ◄──calls──  BoGovernanceEvidenceVerifier  ──implements──► GovernanceEvidenceVerifier (B1 port)
   reads: BO inventory/purchasing tables only    (thin adapter, no logic of its own)         depends on the port only
   writes: its own append-only evaluation row
```

- The evaluator is read-only on operational data (no inventory mutation, no movement, no event emission, no outbox).
- The adapter lives in the composition root so neither layer imports the other. The BO isolation guard stays: BO imports no ABA /
  workflow / approval code. BO may import the shared contract (`handoff-contracts`), as it already does.
- The evaluator does not call ABA and holds no approval authority. It is evidence, not authorization.

## 3. Evaluation record (BO-owned; needs migration 0182 — to be allocated at implementation time)

`business_operations.inventory_policy_evaluations` — append-only, RLS forced on tenant + workspace, database clock, no UPDATE/DELETE/
TRUNCATE (same guard pattern as 0180/0181):

| Column | Meaning |
|---|---|
| id, tenant_id, workspace_id, business_id | identity and scope |
| inventory_item_id (+ warehouse_id if the balance is per warehouse) | the target the evaluation covers |
| dimension | CONSTRAINTS \| RESOURCE_REQUIREMENTS \| COST \| EXPECTED_OUTCOME |
| subject_digest | SHA-256 of the canonical `{actionType, target, finalParameters}` evaluated (binds the evidence to exact values) |
| result | PASSED \| FAILED \| INDETERMINATE (only PASSED can ever be verified) |
| rule_set_version | the owner-approved rule set applied (see Q1) |
| inputs | jsonb snapshot of the BO facts used (balance, movement window, open purchase orders, costs) |
| findings | jsonb: per-rule outcome and reason, for audit |
| evaluated_at | database clock, millisecond UTC |
| requested_by_user_id, correlation_id | audit |

The evidence reference ABA persists is `{ kind: "bo_inventory_policy_evaluation", id }`. The adapter verifies: the row exists in the
caller's tenant/workspace/business (RLS), dimension matches, `result = PASSED`, `subject_digest` equals the digest of the request
subject, and the evaluation is not older than the allowed age (Q4). It returns `VERIFIED { evaluatedAt, authoritativeSource:
{ layer: "BO", component: "inventory-policy-evaluator" }, sourceVersion: rule_set_version }`.

## 4. Evaluation rules — what BO can honestly compute

The contract states no numeric thresholds exist (D-2). BO has these facts today: `inventory_balances` (on hand, reserved,
available, current reorder point and quantity), `inventory_movements` (receipts, issues, unit cost), `purchase_orders` (order and
expected dates, status), `supplier_agreements` (max order value, discount), `supplier_performance_scores`, `storage_locations` /
`warehouse_zones`. Proposed deterministic, threshold-parameterised rules:

- **CONSTRAINTS:** the item and balance exist, are active and unambiguous in scope; values are within canonical bounds; the new
  quantity does not exceed the supplier agreement's `max_order_value` at last known unit cost; no cross-field contradiction.
- **RESOURCE_REQUIREMENTS:** the implied maximum stock (reorder point + reorder quantity) fits the recorded storage capacity, **if
  capacity is recorded**; otherwise INDETERMINATE (never a silent PASS).
- **COST:** implied order value at last known unit cost, versus the agreement cap and the owner-set maximum change (Q1).
- **EXPECTED_OUTCOME:** projected days of cover and stock-out / overstock risk from trailing issue velocity, compared with the
  owner-set bounds (Q1).

Any rule whose inputs are missing returns INDETERMINATE, which fails closed. The rule set is code-versioned and recorded on every row.

## 5. Freshness and ordering — a defect found in B1 that B2 must fix

The aap/1 validator requires an evaluation to be **after** the modification. B1 stamps `modifiedAt` at capture time, so a real
evaluation made before capture would always look stale. Recommended fix (no change to P0-1..P0-4 facts): take `modifiedAt` from the
**decision's recorded modification time** (`approval_decision_modifications.created_at`, written when the approver decided), then require
`modifiedAt ≤ evaluatedAt ≤ capture time`. Resulting flow: decide with modifications → evaluate (BO) → capture (ABA verifies) → owner →
boundaries → issue.

## 6. Triggering the evaluation

A BO-owned route (proposed) `POST /v1/businesses/:businessId/inventory-policy-evaluations`, body: action type, target, proposed final
parameters; returns the four evaluation references. Permission is an owner ruling (Q5): reuse `bo:write` (the evaluation is a BO
record) or add none. No new permission without a ruling. The route is idempotent and audited; it never mutates operational data.

## 7. Simulation (still open — a P0-6 blocker)

D3D-1 makes a simulation reference mandatory for this type. B1 verifies the reference is a real, in-scope, completed run, but the
only engine is a new-venture cash-flow Monte Carlo that cannot evaluate a reorder policy, and no ADI↔Simulation lineage exists.
Options (Q6): (i) keep D3D-1 and build an inventory simulation model in the Simulation layer (large, separate block); (ii) amend
D3D-1 for this type so the simulation reference may be a governed NOT_APPLICABLE while the BO evaluation covers EXPECTED_OUTCOME
(one canonical-contract change: add the type to `SIMULATION_NOT_APPLICABLE_ALLOWED`); (iii) keep the current "any completed run"
check and accept that it is a reference, not an evaluation. Recommendation: (ii), because linking an unrelated run is theatre.

## 8. Implementation breakdown (each its own authorized block)

1. **B2a** — migration 0182 (evaluation table), repository, RLS/append-only tests, mutation proofs.
2. **B2b** — `InventoryPolicyEvaluationService` with the owner-approved rule set; unit and live tests; no mutation of operational data.
3. **B2c** — `BoGovernanceEvidenceVerifier` adapter, composition-root registration, route, `modifiedAt` source fix, B1 tests re-pointed
   at the real verifier, BO and ABA isolation guards extended.
4. **B2d** — end-to-end Level 2 modified-approval authoring (still no execution), then P0-6 planning.

## 9. Owner questions (with recommendations)

- **Q1 Rule set and thresholds:** who supplies the numeric bounds (maximum reorder-point change, cover-days range, cost cap
  policy)? Recommendation: a small owner-approved, versioned rule-set document before B2b; until then, evaluations return
  INDETERMINATE and nothing is capturable (safe).
- **Q2 INDETERMINATE:** treat as fail closed (recommended).
- **Q3 Evaluate plain approvals too?** The contract does not require it. Recommendation: no.
- **Q4 Maximum evidence age** between evaluation and capture. Recommendation: 24 hours, owner may tighten.
- **Q5 Permission** for the evaluation route. Recommendation: `bo:write`, no new permission.
- **Q6 Simulation requirement** (section 7). Recommendation: option (ii).
- **Q7 `modifiedAt` source** (section 5). Recommendation: take it from the decision's recorded modification time.
- **Q8 Capacity data:** `warehouse_zones` and `storage_locations` carry a nullable `capacity_units`, so capacity is optional per
  location, in units that may not match an item's stock unit. Where it is not recorded RESOURCE_REQUIREMENTS is INDETERMINATE.
  Recommendation: confirm the unit semantics before B2b; do not invent capacity.

## 10. Stop conditions for the implementation blocks

0182 already allocated; the rule set is not approved; an evaluator would need to read ABA tables or mutate BO operational data; a
route would require caller-provided results or times; the Simulation question forces a locked-spec change not yet authorized.

## 11. Not in scope

ABA→BO transport, `ACTION_AUTHORIZED`, BO execution adapter, claims, inventory mutation, ExecutionEvidence, production capability
registration, live Supabase apply, P0-6.
