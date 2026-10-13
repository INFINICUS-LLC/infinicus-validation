# Rule set `inventory-reorder-policy` — version v1.1.0 — STATUS: APPROVED (owner ruling 3 of the AC-1 corrections, 2026-10-13; effective on merge to `main`)

Rule-set id: `inventory-reorder-policy`   Version: `v1.1.0`   Stored `rule_set_version` string: `inventory-reorder-policy/v1.1.0`
Supersedes: `v1.0.0` **for the production of proposals**. `v1.0.0` is immutable (its section 11) and stays approved so that evaluation evidence already produced under it still verifies; it defines no proposal policy, so nothing can be proposed from it.

## 1. What changes and why
Every evaluation value and rule of `v1.0.0` (sections 4-6 there) is **unchanged**. `v1.1.0` adds exactly one thing: the **proposal policy**, i.e. how a rule-compliant proposal is chosen from the set of parameter pairs the rules allow. Until now that choice (whole units, nearest to the current policy, which value yields when the combined cap binds) lived as an implementation decision of the AC-1 derivation. Owner ruling 3 requires that business-policy choices belong to the governed first-action rule set and that ADI "may implement governed policy" but "may not silently invent business policy". They are therefore recorded here and read from the rule set by the derivation; the derivation refuses (`RULE_SET_INCOMPLETE`) under any version that does not define them.

## 2. Proposal policy (new in v1.1.0)
| Key | Value | Meaning |
|---|---|---|
| `PROPOSAL_UNIT` | `1` | a proposed value is a whole number of the item's own unit of measure |
| `PROPOSAL_MAX_STEPS` | `1` | a proposal is ONE governed step: no value moves further than `MAX_CHANGE_REORDER_POINT` / `MAX_CHANGE_REORDER_QUANTITY` (25 %) allow. If no single step satisfies every rule, there is no proposal (staged proposals are not produced) |
| `PROPOSAL_SELECTION` | `NEAREST_FEASIBLE_TO_BASELINE` | among the pairs that satisfy every rule, the one closest to the current policy (the smallest change); ties round half up |
| `PROPOSAL_COMBINED_CAP_PRIORITY` | `REORDER_QUANTITY_YIELDS_FIRST` | when `reorderPoint + reorderQuantity` would exceed the combined cap (`MAX_IMPLIED_STOCK_UNITS` and the cover limit), the order quantity yields first (down to its lower bound), then the reorder point (never below the stock-out requirement) |

A proposal is produced only if the real evaluator returns PASSED on all four dimensions for it; it is never "rounded into compliance".

## 3. Values carried over unchanged from v1.0.0
`MAX_CHANGE_REORDER_POINT_PCT = 25`, `MAX_CHANGE_REORDER_QUANTITY_PCT = 25`, `ORDER_VALUE_CAP = 5000` (`ORDER_VALUE_CAP_CURRENCY = USD`), `MAX_CHANGE_ORDER_VALUE = 25 % of ORDER_VALUE_CAP`, `MAX_IMPLIED_STOCK_UNITS = 500`, `LEAD_TIME_DAYS = 14`, `SAFETY_FACTOR = 1.25`, `MAX_COVER_DAYS = 90`, `FIRST_CONFIGURATION_OPTION = NO`; constants `DEMAND_WINDOW_DAYS = 90`, `DEMAND_MOVEMENT_TYPES = issue`, `MIN_DEMAND_OBSERVATIONS = 10`, `EVIDENCE_MAX_AGE = 24 hours`. Simulation: `inventory_reorder_policy_update@1` => NOT_APPLICABLE (`NO_APPLICABLE_SIMULATION_MODEL`), unchanged. They remain owner-defined pre-launch policy values, not data-derived.

## 12. Owner approval record
Rule-set: `inventory-reorder-policy`
Version: `v1.1.0`
Status: **APPROVED**
Owner: INFINICUS LLC / Platform Owner
Source of approval: the owner's "AC-1 OWNER RULINGS / REQUIRED CORRECTIONS" message of 13 October 2026, ruling 3 ("move it into the existing governed first-action rule set"), recorded here without change of substance. It is effective once the commit recording it is merged to `main` by the owner.

Proposal policy:
  PROPOSAL_UNIT                    = 1
  PROPOSAL_MAX_STEPS               = 1
  PROPOSAL_SELECTION               = NEAREST_FEASIBLE_TO_BASELINE
  PROPOSAL_COMBINED_CAP_PRIORITY   = REORDER_QUANTITY_YIELDS_FIRST

Supersedes: v1.0.0 for proposal production only (v1.0.0 is not modified and remains approved for existing evidence)
Notes: no code path may choose any of the above itself; a rule set version without a proposal policy yields no proposal.
