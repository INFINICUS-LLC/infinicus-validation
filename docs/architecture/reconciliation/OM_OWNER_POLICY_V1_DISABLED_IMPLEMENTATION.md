# OM measurement owner policy v1 — disabled implementation

Base: `main` at `8f31028`. Status: **conditional policy accepted; no positive verdict authorization**. The owner policy was compared with the locked OM specification and Master Architecture Guardrail. Both require actual post-action evidence, supported attribution, BO source ownership and a closed OM → CL gate until a governed verified outcome exists. No frozen-spec amendment is made.

## Implementation by decision

| Decision | Implemented and verified in this branch | Remaining architecture or authority gate |
| --- | --- | --- |
| M1 sales evidence | Existing M1A per-order and M2A window readers inspect BO facts read-only, scoped by tenant/workspace/business; exact nonnegative stored money conversion and duplicate/change checks exist. | BO has no immutable database-issued sale completion event, posted refund event/time/link or append-only reversal/correction history. Existing credit-note status cannot prove a posted refund. BO/POS owner must approve source changes; never fill absent values with zero. No net-sales calculator is authorized. |
| M2 periods | New pure policy computes seven complete UTC days before and after the effective date. At midnight, periods meet at execution. Mid-day execution uses the prior seven full days ending at 00:00 before execution and the next seven full days beginning at 00:00 after the effective date; the gap is explicit. Invalid input or altered boundaries is INCONCLUSIVE. | Continuous BO source coverage and resolved corrections cannot be proven until M1 source is fixed. The current M2A review is always nonauthoritative. |
| M3 criterion | New pure candidate uses signed integer minor units and exact `observed * 100 >= baseline * 110` for an inclusive 10% increase. Baseline <= 0, missing amounts or incomplete sources are INCONCLUSIVE. Below 10% is only an advisory signal, never FAILED. | Approved revenue calculation/version, source completeness and authoritative observation are absent. Failure criterion remains separately unapproved. |
| O1 observation | Existing OM-MEASURE-7 refusal remains closed; no new writer. | Legacy observation/version tables lack the governed execution, source digest, service authorization and supersession binding, and their decided rows are not fully immutable. Owner must approve the O1 schema/identity contract before changes. |
| A1 attribution | Existing refusal requires PASS and the inventory-specific confounder review remains conservative. No revenue PASS is inferred. | No approved complete revenue confounder source inventory, causal PASS rule, assessor authority or append-only assessment version. The conditional policy specifies required fields but not an affirmative causal method. |
| P1 human approval | Existing refusal checks candidate actor separation; no positive approval path is added. | Canonical ABA/tenancy model has no approved outcome-verification permission mapping or finalization-time proof. No permission name was invented. Owner must approve binding and audit semantics. |

`RevenuePolicyCandidate` exports `REVENUE_POLICY_AUTHORIZATION_ENABLED = false`, `proposedRevenuePeriods`, and `assessRevenuePolicyCandidate`. Every result is `authoritative: false`, `verdictAllowed: false`, `OUTCOME_INCONCLUSIVE` with permanent authority blockers. The `MEETS_10_PERCENT` or `BELOW_10_PERCENT` signal is arithmetic rehearsal only. It has no database client, writer, route, verdict transition, action executor or learning sink. Caller-provided completeness flags cannot promote an outcome.

## Explicit conflicts and next approvals

M1 needs a BO-owned schema and POS-coordinated writer decision for immutable sale/refund/correction records. O1 needs a governed observation binding and real immutable history. A1 needs affirmative causal method and complete sources beyond a checklist. P1 needs a canonical permission decision; generic `om:admin`, `aba:admin` and `bo:admin` cannot be assumed. These conflicts block dependent architectural changes despite conditional policy approval. Separate owner ratification and review are required for each proposed schema/permission change and for any future positive-verdict gate.

No production migration/deployment, CL learning, automatic execution, merge, or frozen-contract change is part of this block.

## Verification evidence

- Outcome-monitoring runtime typecheck and focused tests: 27 passed. Negative cases cover invalid UTC input, altered/nonconsecutive period boundaries, incomplete source, missing/fractional amounts, zero/negative baseline, and below-threshold results. Input mutation from 11,000 to 10,999 minor units changes the advisory signal at the exact 10% boundary while the verdict remains closed. Large integer values exercise exact arithmetic without floating point.
- Disposable PostgreSQL 16, full repository migrations and limited application role: M1A and M2A integration suites passed 11/11. They cover tenant/workspace/business isolation, duplicate completion, currency mismatch, partial/full/cancelled credits, source update changing the digest, and open windows. The source-update case is mutation evidence of current BO history weakness.
- A pre-existing M1A test initially failed because equal-date credits are ordered by ID rather than insertion. Its assertion now compares the amounts without assuming order; the affected suite passed on rerun. Runtime source behavior was unchanged.
- Lint on the new policy module and `git diff --check` passed. GitHub CI is pending a review PR.
