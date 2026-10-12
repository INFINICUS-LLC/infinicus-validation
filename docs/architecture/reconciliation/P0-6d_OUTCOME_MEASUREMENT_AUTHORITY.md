# P0-6d — What OM can authoritatively observe for `inventory_reorder_policy_update@1`

Finding in one sentence: OM can verify that the policy value **changed** (an execution fact), but it cannot yet establish that the change **helped**, so every applied change stays `OUTCOME_PENDING` and every non-applied one is `OUTCOME_INCONCLUSIVE`. Confidence: about 90% — based on a repository survey, not on production data.

## 1. Why
Changing a reorder point/quantity changes a policy, not stock. Its first possible effect is on the next reorder-below-point evaluation; every business effect (fewer stock-outs, lower holding cost) needs a window of real demand and an argument that nothing else caused the movement. The repository has neither a governed window nor a causal-attribution method, and the data needed to price the effect is not yet reliable.

## 2. Per measurement
| Measurement | Source | Immediacy | Baseline | Window | Scope proof | Causal attribution | Authoritative now |
|---|---|---|---|---|---|---|---|
| Policy value now equals the requested value | BO execution evidence (`mutation.after`) via the BO read port | immediate | `mutation.before` in the same evidence | none needed | evidence scope = event scope = delivery scope | not required | **Yes — but it is an EXECUTION fact (EXECUTION_VERIFIED), not an outcome** |
| Stock-out frequency after the change | none governed | needs a window | none provable | **no owner-approved value** | same balance (item, warehouse) | unsupported | No -> OUTCOME_PENDING |
| Holding cost after the change | none governed | needs a window | none provable | no owner-approved value | same balance | unsupported | No -> OUTCOME_INCONCLUSIVE (unit cost and currency are not provable for existing data; data-capture blocks B/C open) |
| Reorder orders raised by the new policy | none governed | needs a window | none | no owner-approved value | purchase orders linked to the item | unsupported | No -> OUTCOME_PENDING (PO-to-item linkage is not reliable; data-capture block D open) |

The same table exists as data in `packages/outcome-monitoring-runtime/src/observationAuthority.ts`.

## 3. Rules that follow
1. OM never fabricates a pass. The only assignable outcome states are `OUTCOME_PENDING` and `OUTCOME_INCONCLUSIVE`; the database CHECK refuses `OBSERVED`, `VERIFIED` and `FAILED`, and the verification table is append-only.
2. `EXECUTION_VERIFIED` is never an outcome. Continuous Learning's gate requires `OUTCOME_VERIFIED` too.
3. Refused and failed executions are preserved as such and are never positive evidence.
4. No observation window, threshold or attribution method is invented in this block.

## 4. What would unblock real outcome measurement (owner decisions, not made here)
- An approved minimum observation window per action type, and a baseline definition.
- A causal-attribution rule (for example, no other policy change on the same balance in the window).
- Reliable demand history (real `issue` movements) and, for cost effects, the data-capture blocks (unit cost > 0, currency, PO-to-item linkage).
