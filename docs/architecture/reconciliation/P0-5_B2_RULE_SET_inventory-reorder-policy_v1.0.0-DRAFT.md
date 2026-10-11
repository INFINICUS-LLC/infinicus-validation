# Rule set `inventory-reorder-policy` — version v1.0.0 — STATUS: DRAFT (owner approval required)

Rule-set id: `inventory-reorder-policy`   Version: `v1.0.0`   Stored `rule_set_version` string: `inventory-reorder-policy/v1.0.0`
Supersedes: the `0.1.0-DRAFT` working draft (kept unchanged as history). No earlier *approved* version exists.

This document is **documentation and policy preparation only.** It is not effective, contains no code, and was not approved by its
author. It becomes effective only when the owner completes section 12 in a reviewed commit on `main`. Until then Block B2b (evaluator)
has no effective rule set and every evaluation is `INDETERMINATE`.

## 1. Decision of record

- **Dataset option C.** INFINICUS is pre-launch and no representative business dataset exists. The first production rule set is
  **policy-defined, not data-derived.** No value here is calibrated from test fixtures, sparse sandbox rows, synthetic data or silent
  database defaults. Synthetic data may be used later to test *behaviour*, never to set policy limits.
- Every value in section 5 is **NON-DATA-DERIVED**. A "proposal" is an owner-policy proposal with its consequence and its fail-closed
  behaviour stated. Where a number would be arbitrary (a currency amount or a stock quantity, which depend on the owner's business
  scale), no number is proposed; a policy source is named and the parameter stays unset (fail-closed) until the owner sets it.
- No code may be written from a value that is not approved.

## 2. Approved principles

| Ruling | Content |
|---|---|
| Q-R1 | `target.id` is the inventory item UUID only |
| Q-R2 | Several warehouses for the same item ⇒ INDETERMINATE |
| Q-R3 | RESOURCE_REQUIREMENTS = owner policy cap on `reorderPoint + reorderQuantity`; a POLICY CAP, not a physical-capacity claim |
| Q-R4 | Unit cost = the most recent qualifying receipt movement |
| Q-R5 | One global owner-approved value set |
| Q-R6 | Lead time is owner-declared |
| Q-R8 | One explicitly declared business currency |
| Q-R9 | Verification accepts only the currently approved version |
| Constants | `DEMAND_WINDOW_DAYS = 90`, `DEMAND_MOVEMENT_TYPES = issue`, `MIN_DEMAND_OBSERVATIONS = 10`, `EVIDENCE_MAX_AGE = 24 hours` (governance/methodology, already approved) |

## 3. Evaluation model

1. One evaluation row per dimension per exact subject `{actionType, target, finalParameters}` in
   `business_operations.inventory_policy_evaluations`, with `rule_set_version`, the BO facts used (`inputs`, including every parameter
   value applied) and one finding per rule (`findings`).
2. **Result:** any rule FAILED ⇒ `FAILED`; else any rule INDETERMINATE ⇒ `INDETERMINATE`; else `PASSED`. FAILED = the needed data was
   present and a rule was violated. INDETERMINATE = a needed fact is missing, ambiguous or unproven, or an OWNER-SET parameter is unset.
   Only `PASSED` may ever qualify as verified evidence.
3. **Unset parameter ⇒ INDETERMINATE** (`PARAMETER_UNSET`). There are no defaults.
4. The evaluator reads Business Operations data only, in one tenant transaction, and mutates nothing.
5. **Evidence age:** a verifier rejects a row whose `evaluated_at` is more than 24 hours old. The number lives in the verifier policy.
6. **Versioning:** see section 11.

## 4. Data-quality rulings applied

| Ruling | Effect in v1.0.0 |
|---|---|
| `unit_cost` NULL | INDETERMINATE (`UNIT_COST_MISSING`); no fallback to an older receipt |
| Cost currency not provable equal to `DECLARED_CURRENCY` | INDETERMINATE (`CURRENCY_NOT_PROVABLE`); the database default `USD` is never proof |
| Stored zero reorder value | not treated as a deliberate configuration; baseline 0 = unset (rule C4) |
| `capacity_units` | never read; no physical-capacity claim |
| Lead time | owner-declared `LEAD_TIME_DAYS`; observed lead time is never derived |
| Currency | explicit `DECLARED_CURRENCY`; never inferred from defaults |

## 5. Rule-set values (all NON-DATA-DERIVED; none is effective until section 12 is signed)

Classification: **G** = governance/methodology, **C** = commercial policy. "Business-specific later" = can become per-business under a
future versioned configuration block (v1 is one global set, Q-R5). Confidence = my confidence that the *proposal is a sensible
conservative starting point*, not that it is right for your business.

| # | Key | Proposed value | Unit | Class | Rationale | Risk if too low | Risk if too high | Behaviour if absent | Business-specific later | Confidence | Evidence basis |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `MAX_CHANGE_REORDER_POINT` | 25 | percent of current (non-zero) baseline | C | Limits one approval to a moderate move; larger shifts take staged, separately evaluated approvals | Legitimate seasonal adjustments need several approvals | One approval can swing stock thresholds sharply | Rule C5 INDETERMINATE (`PARAMETER_UNSET`) | yes | 40% | purely policy-defined |
| 2 | `MAX_CHANGE_REORDER_QUANTITY` | 25 | percent of current (non-zero) baseline | C | Same reasoning for order size | Same as above | A large order-size jump passes in one step | Rule C5 INDETERMINATE | yes | 40% | purely policy-defined |
| 3 | `ORDER_VALUE_CAP` | **no number proposed** | `DECLARED_CURRENCY` per order | C | An amount depends on the owner's scale. Policy source to use: the owner's existing single-purchase approval limit | A low cap blocks ordinary replenishment | A high cap stops protecting cash | Rule K3 INDETERMINATE | yes | n/a | OWNER DECISION REQUIRED; no evidence |
| 4 | `MAX_CHANGE_ORDER_VALUE` | 25 | percent of `ORDER_VALUE_CAP` (absolute increase in implied order value) | C | Expressed against the cap so it scales with the owner's cap; independent of the quantity bound (a percent-of-baseline form would only repeat rule C5) | Small value changes blocked | A big absolute jump passes if the cap is high | Rule K4 INDETERMINATE | yes | 35% | purely policy-defined; requires value 3 |
| 5 | `MAX_IMPLIED_STOCK_UNITS` | **no number proposed** | item units (`unit_of_measure`) | C | A policy cap on `reorderPoint + reorderQuantity`. Policy source: the largest stock position the owner will hold for one item | Blocks normal stock levels | The cap stops binding | Rule R1 INDETERMINATE | yes (per item class) | n/a | OWNER DECISION REQUIRED; no evidence |
| 6 | `LEAD_TIME_DAYS` | 14 | days, owner-declared | C | Illustrative starting declaration; replace with the slowest regular supplier's quoted lead time | Too short: the stock-out guard passes reorder points that are too low | Too long: legitimate reorder points fail | Rule E2 INDETERMINATE | yes (per supplier/item) | 25% | purely policy-defined; **not derived from purchase history** |
| 7 | `SAFETY_FACTOR` | 1.25 | multiplier | G/C | Requires reorder point to exceed demand during lead time by 25% | A factor near 1 allows no buffer | A large factor makes the guard fail ordinary policies | Rule E2 INDETERMINATE | yes | 40% | purely policy-defined (rule of thumb, not statistical) |
| 8 | `MAX_COVER_DAYS` | 90 | days of average demand | C | Never hold more than one demand window of cover under the policy (anchored on `DEMAND_WINDOW_DAYS`) | Normal stock policies fail the overstock guard | Overstock passes | Rule E3 INDETERMINATE | yes | 40% | purely policy-defined |
| 9 | `DECLARED_CURRENCY` | **no proposal** | ISO 4217 code | C | A currency is a fact about the owner's business; a guess would be an inference from defaults, which is prohibited | n/a | n/a | Rules K2/K3/K4 INDETERMINATE | maybe (per business) | n/a | OWNER DECISION REQUIRED |
| 10 | `FIRST_CONFIGURATION_OPTION` (Q-F1) | `no` | yes/no | C | Items with an unset (zero) baseline cannot be changed through a governed modification until a baseline is set | `no`: unconfigured items cannot get modified approvals | `yes`: the relative change bound is skipped for them | C4 INDETERMINATE | no | 60% | purely policy-defined |

Constants (governance/methodology, already approved): `DEMAND_WINDOW_DAYS = 90`, `DEMAND_MOVEMENT_TYPES = issue`,
`MIN_DEMAND_OBSERVATIONS = 10`, `EVIDENCE_MAX_AGE = 24 hours`.

**Fail-closed summary if the owner declines to set a value:** the dependent rule returns `INDETERMINATE`; the dimension can never reach
`PASSED`; modified approvals for `inventory_reorder_policy_update@1` stay uncapturable. Nothing unsafe is ever approved by default.

## 6. Rule logic

### 6.1 Target resolution (precondition of every dimension)
- T1 `target.kind` is `inventory_item`, else FAILED (`TARGET_KIND_INVALID`).
- T2 `target.id` is a lowercase UUID, else FAILED (`TARGET_ID_NOT_UUID`); it resolves to exactly one inventory item in the
  evaluation's tenant, workspace and business, else INDETERMINATE (`TARGET_UNRESOLVED`); the resolved item id equals `target.id`
  (the evaluated item is the exact subject).
- T3 The item has exactly one inventory balance. Several ⇒ INDETERMINATE (`WAREHOUSE_AMBIGUOUS`); none ⇒ INDETERMINATE (`NO_BALANCE`).

### 6.2 CONSTRAINTS
- **Required inputs:** resolved item (status), its single balance (current `reorder_point`, `reorder_quantity`), `finalParameters`,
  parameters 1, 2 and 10.
- **PASS:** T1–T3 hold; item `status` is `active`; `finalParameters` has exactly `reorderPoint` and `reorderQuantity`, both finite and
  ≥ 0; if `reorderPoint > 0` then `reorderQuantity > 0`; the baseline is non-zero for both values (or parameter 10 is `yes`) and each
  relative change is ≤ its limit.
- **FAILED:** item not active; `finalParameters` malformed, extra or missing keys, negative or non-finite; `reorderPoint > 0` with
  `reorderQuantity = 0`; a relative change above its limit.
- **INDETERMINATE:** target unresolved or ambiguous; no balance or several; a baseline of 0 (unset) while parameter 10 is `no`
  (`BASELINE_UNSET_OR_ZERO`); parameter 1 or 2 unset. Informational only (never fails): the proposal's `before` values versus the
  current baseline are recorded as drift.

### 6.3 RESOURCE_REQUIREMENTS — policy cap only
- **Required inputs:** `finalParameters`, the item's `unit_of_measure`, parameter 5.
- **PASS:** `reorderPoint + reorderQuantity ≤ MAX_IMPLIED_STOCK_UNITS`. The finding states `basis: POLICY_CAP`.
- **FAILED:** the sum exceeds the cap.
- **INDETERMINATE:** target unresolved; parameter 5 unset; **any path that would need physical-capacity evidence** (`capacity_units`
  is never read and no physical-capacity claim is ever made).

### 6.4 COST
- **Required inputs:** the most recent `receipt` movement of the item (by `occurred_at`, then id) and its `unit_cost`; proof of its
  currency; parameters 3, 4, 9; the baseline `reorder_quantity`.
- **PASS:** a receipt exists; `unit_cost` is non-null and > 0; its currency is **provably equal** to `DECLARED_CURRENCY`; the implied
  order value `reorderQuantity × unit_cost` ≤ `ORDER_VALUE_CAP`; the increase over the baseline order value
  (`baseline reorder_quantity × unit_cost`) is ≤ `MAX_CHANGE_ORDER_VALUE` % of `ORDER_VALUE_CAP`.
- **FAILED:** implied order value above the cap; increase above the change limit.
- **INDETERMINATE:** no receipt (`NO_RECEIPT`); `unit_cost` NULL (`UNIT_COST_MISSING`); `unit_cost ≤ 0` (`UNIT_COST_INVALID`);
  currency unproven or different (`CURRENCY_NOT_PROVABLE` — on current data **always**, because movements carry no currency); baseline
  quantity 0; parameter 3, 4 or 9 unset.
- **Supplier cap:** a supplier agreement's `max_order_value` is used only if an authoritative item-to-supplier link can be *proven*.
  None exists in the schema, so no supplier cap is applied and none is invented; the finding records `SUPPLIER_CAP_NOT_RESOLVABLE`
  (informational, never INDETERMINATE).

### 6.5 EXPECTED_OUTCOME
Average daily demand `d` = sum of the magnitudes of `issue` movements in the last 90 days ÷ 90.
- **Required inputs:** the item's `issue` movements in the window (count and sum); parameters 6, 7, 8.
- **PASS:** at least 10 `issue` movements in the window; `reorderPoint ≥ d × LEAD_TIME_DAYS × SAFETY_FACTOR`; and
  `reorderPoint + reorderQuantity ≤ d × MAX_COVER_DAYS`.
- **FAILED:** reorder point below the stock-out requirement; total stock policy above the cover limit.
- **INDETERMINATE:** fewer than 10 observations (`INSUFFICIENT_HISTORY`); target unresolved; parameter 6, 7 or 8 unset. Missing history is
  never treated as zero demand.

## 7. Simulation ruling

| Action type | Simulation applicability | Canonical reason |
|---|---|---|
| `inventory_reorder_policy_update@1` | **NOT_APPLICABLE** (governed) | `NO_APPLICABLE_SIMULATION_MODEL` |

- Applies to this action type and version only. It is not generalized to any other action type.
- No unrelated completed Simulation run is attached to satisfy package validation.
- The BO EXPECTED_OUTCOME evaluator (this rule set, section 6.5) is the relevant evidence path.
- Implementation (the canonical-contract applicability change and the issuer/authoring use of it) is **not done here**; it belongs to
  B2c/B2d. It will add the type to the contract's simulation-not-applicable allowance, which is one reviewed, tested contract change.

## 8. What each stored row must contain
`subject` + `subject_digest` (shared helper); `rule_set_version = inventory-reorder-policy/v1.0.0`; `inputs`: resolved item and balance
ids and values, window start/end, demand count and sum, source movement id and cost, every parameter value applied;
`findings`: `{ rule, outcome, reasonCode, observed, limit }`.

## 9. Data-quality limitations (explicit)
1. **Zero versus unset:** `reorder_point` and `reorder_quantity` default to 0 and every system-created balance starts at 0/0; the
   schema cannot tell a deliberate zero from a default. Rule C4 treats a baseline of 0 as unset.
2. **No receipt writer:** nothing writes `purchase_receipts`; purchase-order lines are never written.
3. **Optional `unit_cost`:** accepted as any finite number (including zero or negative) and never required.
4. **No currency on movements:** cost currency is unprovable; COST cannot PASS on current data.
5. **Weak supplier/item linkage:** agreements reference a supplier only; purchase lines reference products; the product-to-item link is optional.
6. **No capacity-unit semantics:** `capacity_units` has no unit, dimension or compatibility with inventory units.
7. **No observed lead-time path:** lead time is owner-declared only.
8. **Thin demand history:** pre-launch; EXPECTED_OUTCOME cannot PASS until an item has at least 10 issue movements in 90 days.

## 10. Follow-up data-capture block (RECORDED, NOT IMPLEMENTED; separately authorization required)
1. `purchase_receipt` persistence and write path (with lines) through the DAL→BO intake path.
2. Mandatory or governed unit cost on qualifying receipt movements.
3. Explicit currency on cost-bearing inventory movements and receipts.
4. Reliable purchase order ↔ receipt ↔ inventory item linkage.
5. An explicit distinction between a configured zero and an unset/default reorder value.
Constraints: preserve DAL ingestion ownership, BO operational truth, and no duplicate source of truth. Design: see
`DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md` (#77).

## 11. Versioning rules
- An approved version is **immutable**. Corrections or changes are a **new version** (`v1.0.1`, `v1.1.0`); history is never overwritten.
- Each version records its effective date and its owner approval (section 12).
- Verification accepts **only the current approved version**; evidence produced under a superseded version no longer verifies unless a
  future explicit compatibility rule says otherwise.
- A version string containing `DRAFT`, or any version without a completed approval record on `main`, is not effective: the evaluator
  must refuse to run and no evaluation row may be written under it.
- Supersession: a new version names the version it supersedes; at most one version is current.
- A read-only profile re-run is authorized for when a representative real dataset exists; it may propose v1.1.

## 12. Owner approval record
Rule-set: `inventory-reorder-policy`
Version: `v1.0.0`
Status: **DRAFT** (becomes APPROVED only when completed by the owner)
Effective date: ______
Owner: ______
Approval date: ______
Approved values: key 1 ____  2 ____  3 ____  4 ____  5 ____  6 ____  7 ____  8 ____  9 ____  10 ____
Simulation applicability ruling: `inventory_reorder_policy_update@1` ⇒ NOT_APPLICABLE, reason `NO_APPLICABLE_SIMULATION_MODEL` (recorded in section 7; confirm: yes / no)
Currency: ______
Notes: ______
Supersedes: none
