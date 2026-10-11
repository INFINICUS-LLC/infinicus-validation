# Rule set `inventory-reorder-policy-rules` — version 0.1.0-DRAFT (for OWNER approval)

Status: **DRAFT. Not approved. Not executable.** Produced for owner review as the prerequisite of Block B2b. It contains no code and no
migration. Every number marked **OWNER-SET** is deliberately blank: I have not invented business limits. A "Proposal" is a
non-binding suggestion with a stated basis; the owner may accept, change or discard it.

Applies to: canonical action `inventory_reorder_policy_update@1` (parameters `reorderPoint`, `reorderQuantity`). Dimensions:
CONSTRAINTS, RESOURCE_REQUIREMENTS, COST, EXPECTED_OUTCOME. REVERSIBILITY and SIMULATION are out of scope (owner rulings).

## 1. How a rule set is used

1. The B2b evaluator evaluates exactly one dimension per evaluation row, applying only that dimension's rules to one exact subject
   `{actionType, target, finalParameters}`.
2. It writes the row to `business_operations.inventory_policy_evaluations` (B2a) with `rule_set_version`, the BO facts used
   (`inputs`), and one entry per rule (`findings`).
3. **Result derivation (all dimensions):** any rule FAILED → `FAILED`; else any rule INDETERMINATE → `INDETERMINATE`; else `PASSED`.
   - `FAILED` = the data needed was present and a rule was violated.
   - `INDETERMINATE` = a required fact is missing, ambiguous, in an unknown unit, or the history is too short. It never passes.
4. **Version discipline:** an approved version is immutable; any change is a new version. The evaluator MUST refuse to run, and the
   database MUST NEVER receive, a `rule_set_version` containing `DRAFT`. A verifier accepts only the versions the owner lists as
   currently acceptable (recommended: the current approved version only).
5. **Evidence age** (owner ruling Q4): the verifier rejects a row whose `evaluated_at` is more than 24 hours before verification.
   This number lives in the verifier policy, not in the evaluation row.
6. The evaluator reads Business Operations data only, in one tenant transaction, and mutates nothing.

## 2. Facts Business Operations actually holds (from the schema)

| Fact | Source | Caveat found in the schema |
|---|---|---|
| Item identity | `platform.inventory_items` (`id`, `sku` citext, `unit_of_measure`, `status`, optional `product_id`) | The canonical target `id` is an opaque string today |
| Current policy and stock | `business_operations.inventory_balances` per (item, warehouse): `quantity_on_hand`, `quantity_reserved`, `quantity_available`, `reorder_point`, `reorder_quantity`, `last_movement_at` | One balance per warehouse; the subject names no warehouse |
| Demand and unit cost history | `inventory_movements` (`movement_type`, `quantity`, `unit_cost`, `occurred_at`) | Quantity sign is derived from the movement type in code (magnitude is stored); `unit_cost` carries **no currency** |
| Purchasing | `purchase_orders` (`order_date`, `expected_date`, `po_status`), `purchase_order_line_items` (`product_id`, `quantity`, `received_qty`, `unit_price`) | Lines link to `platform.products`, not to inventory items; the item link exists only through `inventory_items.product_id` when set |
| Supplier limits | `supplier_agreements` (`max_order_value`, `currency_code`, `discount_rate`) | **No link from an agreement to an item or product** |
| Storage capacity | `storage_locations.capacity_units`, `warehouse_zones.capacity_units` (both nullable) | Per bin or zone, **no unit, no dimension, no item-footprint model**; no code in the repository reads it |

## 3. Target resolution (applies before any dimension)

- **T1** `target.kind` must be `inventory_item`.
- **T2** `target.id` must resolve to exactly one active `platform.inventory_items` row in the evaluation's tenant, workspace and
  business. Zero or more than one match → `INDETERMINATE` with reason `TARGET_UNRESOLVED` / `TARGET_AMBIGUOUS`.
- **T3** Warehouse: if the item has exactly one `inventory_balances` row, that balance is the baseline. If it has several, the
  evaluation is `INDETERMINATE` (`WAREHOUSE_AMBIGUOUS`) unless the owner defines an aggregate rule (question Q-R2).

## 4. CONSTRAINTS (structural validity; no business thresholds except the change bound)

| Id | Rule | Missing/odd input |
|---|---|---|
| C1 | T1–T3 hold | INDETERMINATE |
| C2 | `finalParameters` contains exactly `reorderPoint` and `reorderQuantity`, both finite non-negative numbers | FAILED |
| C3 | If `reorderPoint > 0` then `reorderQuantity > 0` (a reorder point with a zero order quantity can never replenish) | FAILED |
| C4 | Each change from the BO baseline is within `MAX_CHANGE_REORDER_POINT` and `MAX_CHANGE_REORDER_QUANTITY` | baseline absent → INDETERMINATE; bound unset → INDETERMINATE |
| C5 | Informational only: the proposal's original (`before`) values versus the current BO baseline are recorded as drift; drift alone never fails | — |

OWNER-SET: `MAX_CHANGE_REORDER_POINT`, `MAX_CHANGE_REORDER_QUANTITY` — absolute units, relative percent, or both (Proposal: express as
a relative percent of the baseline with an absolute floor for small baselines; no number proposed because it is business-dependent).

## 5. RESOURCE_REQUIREMENTS

**Under v0.1.0 this dimension cannot return PASSED.** Physical capacity has no unit, no dimension and no item-footprint model, and
no code reads it. Per owner ruling Q8: capacity absent, or present with unknown or incompatible unit semantics → `INDETERMINATE`
(`CAPACITY_UNMODELLED`). I will not invent conversions.

Owner options (Q-R3):
- **A (recommended for v1):** adopt a *policy* limit instead of physical capacity: **R1** `reorderPoint + reorderQuantity ≤
  MAX_IMPLIED_STOCK_UNITS` (OWNER-SET, in the item's `unit_of_measure`), plus **R2** the item's unit of measure is recorded. This
  states plainly that it is a policy cap, not a physical-capacity check.
- **B:** keep INDETERMINATE until a canonical capacity model (`capacity_value`, `capacity_unit_code`, `capacity_dimension`) and an
  item-footprint model exist (separate block). Modified approvals then cannot be captured until then.

## 6. COST

| Id | Rule | Missing/odd input |
|---|---|---|
| K1 | Unit cost = unit cost of the most recent `receipt` movement for the item (owner may choose weighted average, Q-R4) | none → INDETERMINATE (`NO_UNIT_COST`) |
| K2 | Currency is known and single: the business has exactly one currency, or the cost is in the owner-declared currency | unknown → INDETERMINATE (`CURRENCY_UNKNOWN`); `unit_cost` has no currency column |
| K3 | Implied order value `reorderQuantity × unit cost` ≤ `ORDER_VALUE_CAP` | cap unset → INDETERMINATE |
| K4 | Implied order value change versus baseline order value within `MAX_CHANGE_ORDER_VALUE` | baseline cost absent → INDETERMINATE |

Supplier `max_order_value` is **not** used in v0.1.0 because supplier agreements are not linked to items. OWNER-SET:
`ORDER_VALUE_CAP`, `MAX_CHANGE_ORDER_VALUE`. Where per-business values live (the schema has no configuration table) is Q-R5.

## 7. EXPECTED_OUTCOME (history-based; the only dimension that needs demand data)

Definitions (all OWNER-SET unless a proposal is shown):
- `DEMAND_WINDOW_DAYS` (Proposal: 90, basis: a common planning window; owner may choose another).
- `DEMAND_MOVEMENT_TYPES` (Proposal: `issue`; `transfer_out`, `write_off` and `adjustment` are excluded because they are not customer
  demand. Owner decides.)
- `MIN_DEMAND_OBSERVATIONS` (Proposal: 10 demand movements in the window; below it, history is too thin to judge.)
- Average daily demand `d` = sum of the magnitudes of demand movements in the window ÷ `DEMAND_WINDOW_DAYS`.

| Id | Rule | Missing/odd input |
|---|---|---|
| E1 | At least `MIN_DEMAND_OBSERVATIONS` demand movements exist in the window | fewer → INDETERMINATE (`INSUFFICIENT_HISTORY`) |
| E2 | Stock-out guard: `reorderPoint ≥ d × LEAD_TIME_DAYS × SAFETY_FACTOR` | lead time unknown → INDETERMINATE |
| E3 | Overstock guard: `reorderPoint + reorderQuantity ≤ d × MAX_COVER_DAYS` | `MAX_COVER_DAYS` unset → INDETERMINATE |
| E4 | `d = 0` with enough history means no demand: E2 passes, E3 follows `MAX_COVER_DAYS` as 0 cover and FAILS any positive stock policy | — |

Lead time (Q-R6): the repository can only derive it from purchase orders and receipts linked to the item through
`inventory_items.product_id`. Options: **(a)** observed lead time from purchase history (needs a minimum number of completed
receipts, OWNER-SET); **(b)** an owner-declared `LEAD_TIME_DAYS` per rule set. Without either, E2 is INDETERMINATE.
OWNER-SET: `LEAD_TIME_DAYS` or the observed-lead-time rule, `SAFETY_FACTOR`, `MAX_COVER_DAYS`.

## 8. What the stored row must contain (so a verifier can re-derive it)

- `subject` and `subject_digest` (shared helper `computeGovernanceSubjectDigest`).
- `rule_set_version` = this document's approved version string, for example `inventory-reorder-policy-rules/1.0.0`.
- `inputs`: resolved item and balance ids and values, window start/end, demand movement count and sum, movement types used, unit cost
  and its source movement id, every OWNER-SET parameter value applied.
- `findings`: one object per rule `{ rule, outcome, reasonCode, observed, limit }`.

## 9. Obligations on B2b (test plan)

Golden cases per rule at, just below and just above every limit; one INDETERMINATE case per missing input listed above; a refused
DRAFT or unknown version; no mutation of any BO table (counts before/after); deterministic output for identical facts; mutation proofs
on each comparison operator and each INDETERMINATE branch; the evaluator never reads an ABA table.

## 10. Owner decisions required before this becomes version 1.0.0

| # | Decision | My recommendation |
|---|---|---|
| Q-R1 | Is `target.id` the inventory item uuid, the SKU, or either? | uuid only; ABA authoring validates it at capture (a B2c change) |
| Q-R2 | Several warehouses for one item: refuse (INDETERMINATE) or define an aggregate? | INDETERMINATE for v1 |
| Q-R3 | RESOURCE_REQUIREMENTS: option A (policy cap) or B (wait for a capacity model)? | A, clearly labelled a policy cap |
| Q-R4 | Unit cost: last receipt or weighted average? | last receipt (simpler, verifiable) |
| Q-R5 | Where do per-business limits live? | one global value set in this document for v1; per-business overrides need a later configuration block |
| Q-R6 | Lead time: observed from purchase history or owner-declared? | owner-declared for v1 (history is unlikely to be rich enough) |
| Q-R7 | The OWNER-SET values in sections 4–7 | owner to set; I will not invent them |
| Q-R8 | Currency: single declared currency per business? | yes, declared in the rule set until `unit_cost` carries a currency |
| Q-R9 | Accepted versions at verification | the current approved version only |

## 11. Approval record (to be completed by the owner)

Approved version string: ______  Approved by: ______  Date: ______  Parameter values attached: ______

No evaluation row may be written under this rule set until this block is completed.
