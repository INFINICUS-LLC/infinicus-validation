# AC-1 — ADI structured recommendation producer for `inventory_reorder_policy_update@1`

Status: implemented on branch `feat/ac1-adi-reorder-recommendation-producer` (DRAFT PR). Repository support only: **no migration, no deployment, no live database touched, no activation, no backfill.** Owner rulings applied: C-1 (governed `NOT_APPLICABLE` simulation satisfies the requirement for this action; no simulation fabricated), C-2 (Criterion D requires a real structured ADI producer; fixture-only is insufficient), C-3/C-4 (not touched). Production track remains parked (#114).
Architecture layer: ADI (Intelligence domain). Completion criterion closed: **D**; materially advances **M**.

## 1. Source / evidence survey (Block 1)
| # | Question | Finding (repository evidence) |
|---|---|---|
| 1 | Inventory operational truth | `platform.inventory_items` (status, unit of measure) and `business_operations.inventory_balances` (quantity, `reorder_point`, `reorder_quantity`, `reorder_policy_state`); BO is the only writer of the reorder fields (final audit; 0196). |
| 2 | Stock / demand / movement evidence | `business_operations.inventory_movements` (append-only; `issue` rows = demand; `receipt` rows carry `unit_cost` + `unit_cost_currency`). Read by `InventoryPolicyFactsRepository.loadSnapshot` (one consistent tenant snapshot, database clock). |
| 3 | Reorder policy current state | the item's single balance (`reorder_point`, `reorder_quantity`), with Block E's `reorder_policy_state` (UNSET/CONFIGURED). |
| 4 | Evaluator inputs from data-capture A–E | item + balance, latest receipt cost and currency (Block B positive cost, Block C currency), 90-day issue demand (≥ 10 observations), business-scoped declared currency (0185). Receipt write path and PO-line linkage (Blocks A/D) improve cost/receipt data but are not read by this rule set. |
| 5 | BI / BDT evidence | **None specific to reorder.** `layers/business-intelligence` and `layers/business-digital-twin` are placeholders; `TwinComputationService` models inventory delta only. The authoritative evidence for this action is therefore BO's read-only facts snapshot (the same one the BO evaluator reads). Recorded as an observation, not a conflict: BI/BDT add nothing the rule set consumes. |
| 6 | Reusable evaluator | `evaluateInventoryReorderPolicy` (pure; rule set `inventory-reorder-policy/v1.0.0`, owner-approved 2026-10-11). Reused as the verification oracle; its rules are not copied. |
| 7 | Existing structured ADI recommendation contract | **None.** `adi-to-aba.ts` (BUILD-14) carries narrative only (summary, rationales, steps, confidence, risks, evidence references). The machine-readable action existed only as a caller-supplied `proposedParameters` in ABA's capture. Extended additively (section 4). |
| 8 | Free-text generator | `BusinessDecisionRecommendationService` / `deterministicRecommendations` (burn rate, churn, pricing; optionally LLM-assisted). **Not appropriate** for numeric operational parameters: it emits no action, target or parameters. It is left unchanged and unused by this producer. |
| 9 | Missing data to derive reorderPoint/Quantity | None missing in the repository. At runtime the derivation needs: an active item, exactly one balance with non-zero baseline (rule set `FIRST_CONFIGURATION_OPTION = NO`), ≥ 10 issue movements in 90 days, a receipt with a positive unit cost in the business's declared currency (USD for the v1 cap), a declared currency. Absent any of these, **no recommendation** is produced (the pre-launch state of a real business will often be exactly this). |
| 10 | Operates without inventing business facts? | **Yes.** Every number is a BO fact or an owner-approved rule-set value; lead time, safety factor, cover days, caps and change limits are the owner-defined pre-launch policy values of the rule set (stated as such in the proposal). |

## 2. Ownership (Block 2)
ADI produces: action type, target, proposed parameters, evidence references, rationale, confidence, metadata. ADI does **not** approve, authorize, mutate BO, build an AuthorizedActionPackage, bypass ABA or write reorder fields. `ReorderPolicyRecommendationProducer` (`packages/workflow/src`) writes only ADI's own question/case/recommendation/rationale rows through the existing ADI repositories in one tenant transaction. It imports no BO, ABA or event code.

## 3. Logic (Block 4): A — deterministic / rule-driven
No LLM, no statistical model, no randomness. `deriveCompliantReorderPolicy` (BO runtime, read-only, pure) evaluates the **current** policy with the real evaluator:
1. Evidence missing/ambiguous/unusable (any INDETERMINATE) → no recommendation (`EVIDENCE_UNAVAILABLE`, reason codes named). Inactive item → `ITEM_NOT_ACTIVE`. Already compliant on all four dimensions → `POLICY_ALREADY_COMPLIANT`.
2. Otherwise it derives the **smallest whole-unit single governed step** satisfying every rule: stock-out guard, cover limit, policy cap, ±25 % change bounds, order-value cap and increase limit. The pair closest to the baseline inside the feasible region; the order quantity yields first when the pair would break the combined cap.
3. The candidate is **verified** with the same evaluator: only four `PASSED` dimensions are ever returned. If no single step can satisfy the rules → `NO_COMPLIANT_SINGLE_STEP` (nothing partial is proposed).
`ReorderPolicyDerivationService` loads the facts through the existing read-only repositories and writes nothing. ADI reaches it only through the structural port `ReorderPolicyDeriverPort`, joined in `apps/api/src/reorderPolicyRecommendationComposition.ts` (the only place that imports both).
Soundness and completeness are cross-checked against exhaustive search over 200 generated scenarios (`inventoryPolicyDerive.test.ts`).

## 4. Structured contract (Block 3)
`adi-proposed-action/1` (`packages/handoff-contracts/src/adi-proposed-action.ts`): actionType, target, proposedParameters, currentState reference, evidence references (sha256 digest of the exact fact set), reasoning, confidence, constraints, provenance (producer, version, method, rule-set version, timestamp). Stored as ONE rationale (`proposed_action`) of the recommendation version: no second recommendation model, no migration. The validator is fail-closed and checks against the canonical action registry (no invented type, target kind or parameter). Confidence is honest: `RULE_COMPLIANCE` with no numeric probability, because a deterministic rule yields compliance, not a forecast. The existing narrative ADI→ABA handoff is unchanged.
Risk and validity are authored by ADI with the existing P0-3 helpers: risk class `medium` (bounded step, but it changes purchasing; the deterministic floor and ABA's tier policy still apply) and time-sensitive until the evidence expires (the rule set's 24 h `EVIDENCE_MAX_AGE`).

## 5. Simulation (Block 5)
Governed `NOT_APPLICABLE` (`NO_APPLICABLE_SIMULATION_MODEL`), per C-1 and the canonical contract. No simulation run is created or attached (asserted: zero `simulation_runs` for the business).

## 6. ABA handoff (Block 6)
`AbaAuthoringService.recordCapture` now reads the structured proposal of the action's source recommendation (`AdiProposedActionSource`). **Where one exists, the captured original proposal must equal it exactly** (`PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION`, refused before anything is stored). ABA still owns the decision, the modification and the final parameters; the capture's `proposed` half now provably is ADI's proposal. A malformed or duplicated stored proposal is an error, never ignored. Package issuance and execution are unchanged.

## 7. Entry point
`POST /v1/businesses/:businessId/inventory-items/:itemId/reorder-policy-recommendation` — `adi:write`, active subscription, `Idempotency-Key`, tenant context from authentication. 201 = produced and published; 200 = `NO_RECOMMENDATION` with a named code (nothing persisted).

## 8. Real end-to-end proof (Block 7) and fail-closed tests (Block 8)
`apps/api/tests/ac1-adi-first-action.e2e.test.ts` (11 tests, real PostgreSQL, production `buildApp`, real worker): BO facts → producer route → structured recommendation → ABA review → approve-with-modification (BO evaluation evidence) → capture (ADI proposal preserved as `proposed`, ABA final differs) → package → activation → worker → BO claim/execution under fresh authority → ExecutionEvidence + executed event → OM `EXECUTION_VERIFIED` / `OUTCOME_PENDING`, `learningEligibility` false. No recommendation fixture is used. Negative paths: thin history, stale (out-of-window) demand, undeclared currency, unset baseline, no receipt, already compliant, cross-business / unknown item, foreign business (404), authn/idempotency, unsupported action type and schema version, impossible/NaN/negative values, target mismatch, unverified derivation, missing evidence, wrong rule set, deriver failure, mid-persistence failure (whole transaction rolled back), a forged/different/extra-parameter capture, and the O-4 case below.

## 9. Findings carried to the owner (no architecture was changed)
- **O-4 consequence — approving the ADI proposal as proposed is not executable.** BO's ruling O-4 refuses a plain approval (`NO_BASELINE_EVIDENCE`: no authoritative "state at authorization time"); only an approve-with-modification carries BO evaluation evidence as the compare-and-set baseline. Proven: the plain-approval chain is issued and BO REFUSES it, balance untouched. The principal proof therefore has the approver modify the proposal. Whether an unmodified ADI proposal should become executable (for example by accepting a BO evaluation of the final = proposed parameters as the baseline) is a contract/ruling change for the owner; nothing was adapted here.
- **Enforcement is not yet mandatory.** A source recommendation WITHOUT a structured proposal (narrative-only or legacy) can still be captured with caller-supplied parameters, as before; enforcement applies where ADI recorded a proposal. Making the structured proposal mandatory for this action type would break the many fixture-based tests and is an owner decision (recommended once legacy fixtures migrate).
- **BI/BDT** hold no reorder-specific evidence; the producer's evidence is BO's read-only facts snapshot, joined at the composition root.
- **Rule-set values are owner-defined pre-launch policy values**, not data-derived (stated in every proposal); the producer's single-step rule and `medium` risk authoring are this block's design and need owner review.
- Rationales written in one transaction share `created_at`; the history view reads the earliest rationale, so ties now resolve toward the human-readable narrative (`listRationalesForVersions` tie-break).

## 10. Not done (Block 11)
No second action type, no general AI/chat feature, no LLM involvement, no deployment, no live migration, no activation, no change to CL, no new simulation, no change to BO execution, no browser identity remediation, no parked production work.

## 11. Files
New: `handoff-contracts/src/adi-proposed-action.ts`; `business-operations-runtime/src/inventory-policy/{derive,ReorderPolicyDerivationService}.ts`; `workflow/src/{ReorderPolicyRecommendationProducer,ProposedActionSource}.ts`; `apps/api/src/{reorderPolicyRecommendationComposition.ts,routes/reorderPolicyRecommendation.ts,schemas/reorderPolicyRecommendation.ts}`; tests (contract, derivation, source, E2E, architecture guards). Changed: `AbaAuthoringService` (capture check), `InventoryPolicyEvaluationService` (digest builder exported), `DecisionRecommendationRepository` (`listRationalesByCode`, rationale tie-break), `database/src/index.ts` (one export), `app.ts` (route), `handoff-contracts`/`workflow`/BO-runtime index exports, `authorizedPackageChain.ts` test kit (additive).

## 12. Future extension
Second action types need their own canonical contract, rule set and producer (new programme). A calibrated model may later supply `CALIBRATED_PROBABILITY` confidence under the same contract.
