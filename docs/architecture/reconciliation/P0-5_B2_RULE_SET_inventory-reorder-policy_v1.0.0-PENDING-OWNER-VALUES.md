# Rule set `inventory-reorder-policy-rules` — version 1.0.0 (policy-defined; AWAITING OWNER VALUES AND SIGNATURE)

Status: **policy-defined and complete in structure; NOT yet effective.** It becomes effective only when (1) every OWNER-SET value in
section 5 is filled by the owner and (2) the approval record in section 9 is signed in a reviewed commit on `main`. Until then the
evaluator (Block B2b, not started) has no effective rule set and every evaluation is `INDETERMINATE`.
Supersedes `P0-5_B2_RULE_SET_inventory-reorder-policy_v0.1.0-DRAFT.md` (kept unchanged as history).

Decision of record: **Dataset option C** — no representative production dataset exists yet. No commercial limit in this document is
derived from test fixtures, sparse sandbox rows, synthetic data or silent defaults. Synthetic data may be used to test *behaviour*,
never to set policy limits. A read-only profile re-run is authorized for when a representative real dataset exists; it may propose a
v1.1 (section 10).

Applies to `inventory_reorder_policy_update@1` (`reorderPoint`, `reorderQuantity`). Dimensions: CONSTRAINTS,
RESOURCE_REQUIREMENTS, COST, EXPECTED_OUTCOME. SIMULATION and REVERSIBILITY are out of scope (owner rulings).

## 1. Evaluation model

1. One evaluation row per dimension per exact subject `{actionType, target, finalParameters}`, written to
   `business_operations.inventory_policy_evaluations` with `rule_set_version = inventory-reorder-policy-rules/1.0.0`, the BO facts used
   (`inputs`, including every parameter value applied) and one finding per rule (`findings`).
2. **Result:** any rule FAILED → `FAILED`; else any rule INDETERMINATE → `INDETERMINATE`; else `PASSED`.
   FAILED = the needed data was present and a rule was violated. INDETERMINATE = a needed fact is missing, ambiguous, unproven, or an
   OWNER-SET parameter is unset. INDETERMINATE never passes.
3. **Unset parameter ⇒ INDETERMINATE** (`PARAMETER_UNSET`) for every rule that needs it. There are no defaults.
4. **Effectiveness:** the evaluator must refuse to evaluate, and the database must never receive, a `rule_set_version` that is not an
   approved, effective version. Only the currently approved version may verify evidence (Q-R9).
5. **Evidence age:** a verifier rejects a row whose `evaluated_at` is more than 24 hours old (already approved; lives in the verifier policy).
6. The evaluator reads Business Operations data only, in one tenant transaction, and mutates nothing.
7. Parameters live in one global, versioned value set inside this document's approved form (Q-R5); there are no per-business overrides in v1.

## 2. Approved methodological constants (already accepted; not commercial limits)

| Name | Value |
|---|---|
| `DEMAND_WINDOW_DAYS` | 90 |
| `DEMAND_MOVEMENT_TYPES` | `issue` |
| `MIN_DEMAND_OBSERVATIONS` | 10 |
| `EVIDENCE_MAX_AGE` | 24 hours |

## 3. Data-quality rulings applied

| Ruling | Effect in v1.0.0 |
|---|---|
| Cost `NULL` | INDETERMINATE (`UNIT_COST_MISSING`); no fallback to an older receipt |
| Cost currency not provable as equal to the declared currency | INDETERMINATE (`CURRENCY_NOT_PROVABLE`); the database default `USD` is never evidence |
| Stored zero reorder value | never treated as a deliberately configured value; see C4 |
| `capacity_units` | never used as physical-capacity evidence; the v1 gate is the owner-set policy cap only |
| Lead time | owner-declared; never derived from the purchase/receipt model |
| Currency | explicit `DECLARED_CURRENCY`; never inferred |

## 4. Rules

### 4.1 Target resolution (applies before any dimension)
- **T1** `target.kind` is `inventory_item`, else FAILED.
- **T2** `target.id` is a lowercase UUID (Q-R1), else FAILED (`TARGET_ID_NOT_UUID`). It must resolve to exactly one active
  `platform.inventory_items` row in the evaluation's tenant, workspace and business, else INDETERMINATE (`TARGET_UNRESOLVED`).
- **T3** The item has exactly one `inventory_balances` row; several → INDETERMINATE (`WAREHOUSE_AMBIGUOUS`); none → INDETERMINATE (`NO_BALANCE`) (Q-R2).

### 4.2 CONSTRAINTS
| Id | Rule | Outcome when not met |
|---|---|---|
| C1 | T1–T3 hold | as above |
| C2 | `finalParameters` has exactly `reorderPoint` and `reorderQuantity`, both finite non-negative numbers | FAILED |
| C3 | If `reorderPoint > 0` then `reorderQuantity > 0` | FAILED |
| C4 | Baseline = the current BO `reorder_point` / `reorder_quantity`. A baseline of `0` is treated as **unset**, not as a configured value. If either baseline is 0 the relative change bound is not computable → INDETERMINATE (`BASELINE_UNSET_OR_ZERO`), unless the owner enables the first-configuration option (Q-F1) | INDETERMINATE |
| C5 | With a non-zero baseline: relative change of each value ≤ `MAX_CHANGE_REORDER_POINT_PCT` / `MAX_CHANGE_REORDER_QUANTITY_PCT`, else FAILED. Either unset → INDETERMINATE | FAILED / INDETERMINATE |
| C6 | Informational: the proposal's original (`before`) values versus the baseline are recorded as drift; drift alone never fails | — |

### 4.3 RESOURCE_REQUIREMENTS — a **policy cap**, not a physical-capacity claim
| Id | Rule | Outcome |
|---|---|---|
| R1 | `reorderPoint + reorderQuantity ≤ MAX_IMPLIED_STOCK_UNITS`, in the item's `unit_of_measure` | FAILED; cap unset → INDETERMINATE |
| R2 | The finding records the item's `unit_of_measure` and states `basis: POLICY_CAP`. `capacity_units` is not read | — |

### 4.4 COST
| Id | Rule | Outcome |
|---|---|---|
| K1 | Unit cost = `unit_cost` of the most recent `receipt` movement of the item (by `occurred_at`, then id) (Q-R4). `NULL` → INDETERMINATE (`UNIT_COST_MISSING`); no receipt → INDETERMINATE (`NO_RECEIPT`); `unit_cost ≤ 0` → INDETERMINATE (`UNIT_COST_INVALID`) | INDETERMINATE |
| K2 | The cost's currency must be **provable** equal to `DECLARED_CURRENCY`. The movement table carries no currency column today, so this is not provable on current data → INDETERMINATE (`CURRENCY_NOT_PROVABLE`) until currency is captured explicitly (data-capture block) | INDETERMINATE |
| K3 | Implied order value `reorderQuantity × unit cost` ≤ `ORDER_VALUE_CAP` | FAILED; cap unset → INDETERMINATE |
| K4 | Implied order value change versus the baseline order value (`baseline reorder_quantity × unit cost`) ≤ `MAX_CHANGE_ORDER_VALUE_PCT`; baseline quantity 0 → INDETERMINATE | FAILED / INDETERMINATE |

Supplier `max_order_value` is not used (agreements are not linked to items).

### 4.5 EXPECTED_OUTCOME
Average daily demand `d` = sum of the magnitudes of `issue` movements over the last 90 days ÷ 90.
| Id | Rule | Outcome |
|---|---|---|
| E1 | At least 10 `issue` movements in the 90-day window | fewer → INDETERMINATE (`INSUFFICIENT_HISTORY`) |
| E2 | Stock-out guard: `reorderPoint ≥ d × LEAD_TIME_DAYS × SAFETY_FACTOR` | FAILED; either parameter unset → INDETERMINATE |
| E3 | Overstock guard: `reorderPoint + reorderQuantity ≤ d × MAX_COVER_DAYS` | FAILED; parameter unset → INDETERMINATE |
| E4 | Missing or too-thin history is never treated as zero demand: with E1 met, `d > 0` by construction; if `d` cannot be computed the result is INDETERMINATE (`NO_DEMAND_SIGNAL`) | INDETERMINATE |

`LEAD_TIME_DAYS` is owner-declared (Q-R6). Observed lead time is never derived.

## 5. OWNER-SET values (all required; none has a default)

| Parameter | Unit | Value (OWNER) |
|---|---|---|
| `DECLARED_CURRENCY` | ISO 4217 code | ______ |
| `MAX_CHANGE_REORDER_POINT_PCT` | percent of baseline | ______ |
| `MAX_CHANGE_REORDER_QUANTITY_PCT` | percent of baseline | ______ |
| `MAX_IMPLIED_STOCK_UNITS` (policy cap) | item units | ______ |
| `ORDER_VALUE_CAP` | `DECLARED_CURRENCY` | ______ |
| `MAX_CHANGE_ORDER_VALUE_PCT` | percent of baseline order value | ______ |
| `LEAD_TIME_DAYS` | days | ______ |
| `SAFETY_FACTOR` | multiplier | ______ |
| `MAX_COVER_DAYS` | days | ______ |
| Q-F1 first-configuration option | yes / no (default **no**) | ______ |

Q-F1: when a baseline is 0 (unset), allow the change bound to be skipped and rely on R1 and E2/E3 alone? Default **no** (conservative):
items with no configured policy then cannot receive a modified approval until a baseline is set. Owner decision.

Percentages instead of absolute changes keep one global value set meaningful across items of different scale (Q-R5).

## 6. What the stored row must contain
`subject` + `subject_digest` (shared helper); `rule_set_version`; `inputs`: resolved item and balance ids and values, window start/end,
demand count and sum, source movement id and cost, every parameter value applied; `findings`: `{ rule, outcome, reasonCode, observed, limit }`.

## 7. Consequence on current data (stated plainly)
- CONSTRAINTS and RESOURCE_REQUIREMENTS can PASS today (given owner values).
- **COST cannot PASS** until the cost-bearing receipt carries an explicit currency (K2) and a cost (K1) — the data-capture block.
- **EXPECTED_OUTCOME cannot PASS** until an item has ≥ 10 issue movements in 90 days.
- Therefore, until both are met, modified `inventory_reorder_policy_update@1` approvals cannot be captured. This is the intended
  fail-closed behaviour and matches dataset option C; plain approvals are unaffected.

## 8. Obligations on Block B2b (when authorized)
Golden cases at, just below and just above every limit; one INDETERMINATE case for each missing input and each unset parameter; zero
baseline cases (with Q-F1 off and on); refusal of an unapproved version; unit-cost NULL, zero, negative; currency unprovable; no BO
mutation (before/after counts); deterministic output; mutation proofs on every comparison and INDETERMINATE branch; no ABA table read.
Synthetic data is allowed here for behaviour only.

## 9. Approval record (owner)
Approved version string: `inventory-reorder-policy-rules/1.0.0`   Approved by: ______   Date: ______
All section-5 values filled: yes / no   Q-F1 chosen: ______
No evaluation row may be written under this rule set until this record is completed in a reviewed commit on `main`.

## 10. Re-run and revision
When a representative real dataset exists, a read-only profile re-run (anonymised or staging data, no PII, no writes) recalculates the
distributions, compares real data with these policy values, and may propose v1.1. An approved version is never edited; v1.1 is new.
