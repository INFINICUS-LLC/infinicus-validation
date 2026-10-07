# CS-01 — Zero evidence must not become a business conclusion (implementation note)

**Status:** implemented and validated locally on live PostgreSQL. Independent of the P0 sequence; no migration; no locked specification changed.
**Authority applied:** Layer Guidance & Cold-Start Standard v1.0 (§7: "NOT ENOUGH REAL DATA … Confidence: LOW"; never false certainty), audit finding CS-01 (`COLD_START_AND_DUAL_MODE_AUDIT.md`).

## The defect
A business with an empty event ledger gets an all-zero Digital Twin snapshot. `deterministicRecommendations` then told the owner "The business was profitable over the last 30 days ($0)" and "Churn rate is 0%, within a healthy range", with `low` risk, and the whole result entered the ADI → ABA chain as real recommendations. A tie (profit exactly 0) was also called "profitable".

## What changed
| Where | Change |
|---|---|
| `packages/workflow/src/twinEvidence.ts` (new, pure) | `assessTwinEvidence(twin)` reports, per area (financial, customers, team), whether any activity was recorded, and an overall `sufficient` / `partial` / `insufficient` with a truthful message. |
| `deterministicRecommendations` | A conclusion is drawn only for an area with recorded activity; an empty area produces no statement. Exact break-even is described as break-even, not "profitable". |
| `BusinessDecisionRecommendationService.recommend` | Returns `{ decisions, evidence }`. If nothing was recorded: no decisions, no LLM call, no ADI records created. If only some areas have data, the LLM prompt names the unknown areas and forbids claims about them. |
| `TwinComputationService` | The snapshot summary no longer reads "profit30d=0, churn=0%" for an empty ledger; it says insufficient data. |
| API | `POST /v1/businesses/:id/decision-recommendations` response gains an additive `evidence` object (`overall`, `financial`, `customers`, `team`, `message`). `decisions` is unchanged in shape. |

## Representation of the unknown state
`evidence.overall = "insufficient"` with the message *"Not enough real data yet. No sales, expenses, customer activity or team changes were recorded in the last 30 days, so no conclusions are drawn. Confidence: LOW. Record real activity to receive recommendations."* An area with no data is **unknown**, not zero, not good, not bad.

## Not done here (later blocks)
- UI rendering of the `evidence` state in the browser app and the Experience layer (DM-01/DM-02, CS-02..CS-05).
- A data-maturity level (CS-02), assumption-based initial Twin (CS-03/CS-04) and provenance labels (CS-05). `evidence` is the minimal truthful signal until those exist.
- The Twin API's own snapshot values are unchanged (still zeros for an empty ledger); only conclusions drawn from them are gated.

## Validation
Unit tests (11) and an API integration test against the real route and database. Regression proof: restoring the old behaviour (evidence ignored / no short-circuit / break-even called profitable) makes the unit tests fail, and makes the API test fail with three recommendations returned for an empty business.
