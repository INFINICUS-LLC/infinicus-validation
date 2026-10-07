# COLD_START_AND_DUAL_MODE_AUDIT — BUILD-ARCH-RECON-01, Phases 7 and 8

**Status:** AUDIT COMPLETE — **read-only**. No locked specification, code, schema or data was changed.
**Authority applied:** Layer Guidance & Cold-Start Standard v1.0 (§§5–8), Dual-Mode Experience Standard v1.0 (§§2–10), Master Manifest v1.0 §§13–17, locked ABA v1.0 §§26–28; authorisation E7 of 2026-10-07.
**Baseline:** `main` at `ad6440c`. Stack B (`infinicus-platform/`) is the target implementation (A1).
**Method / limits:** code and migration search across all file types (not only source), reading of the Twin and recommendation services, onboarding schemas and the persistence layer. Roughly 200 browser blocks were searched by pattern, not read in full. Nothing was run against production or a real tenant.

**Result in one line:** the architecture allows a cold start (the persistence layer even has assumption tables), but **the application does not implement it**, and one existing behaviour makes **false statements on a business with no data**. There is **no Guided/Professional mode at all**. No specification conflict was found; no CRITICAL finding.

---

## PHASE 7 — COLD-START AUDIT

### 7.1 Maturity levels

The Standard defines Level 0 (No Data) to Level 4 (Mature BI) and requires every layer to adapt behaviour and confidence to the level.

**Finding CS-02:** the word "maturity" appears in **no code or schema file** in the repository (searched every file type outside documentation). There is no data-maturity concept, field, calculation, API value or UI state. No layer can adapt to it.

### 7.2 The spec's check list

| Check (spec §12) | Result | Evidence |
|---|---|---|
| Startup can operate without historical data | **PARTIAL.** Onboarding, product/order/event writes and simulation run with no history. But outputs derived from the empty state are presented as facts (CS-01). | `packages/onboarding`, `routes/orders.ts`, `routes/bizops.ts` |
| Assumptions remain labeled | **NO.** No evidence/provenance label exists on Twin values, simulation results or recommendations in Stack B. The six classes (`ACTUAL, ASSUMPTION_BASED, BENCHMARK_BASED, ESTIMATED, FORECAST, SIMULATION`) appear only in PR #22's event ledger (unmerged, provisional). The browser UI carries only a generic notice that LLM output "may contain errors or assumptions". | grep of `apps`, `packages`, `index.html`; PR #22 review |
| Initial Twin can exist | **PARTIAL.** A Twin snapshot is created and published even with zero events, but it is built **only** from the BO event ledger, so it can never be an assumption-based initial model (CS-04). | `TwinComputationService.computeAndPublish` |
| Simulation can run assumption-based scenarios | **YES.** The simulation flow takes user-entered business-idea parameters with no history. Results are not labeled `SIMULATION`/`ASSUMPTION_BASED` (CS-05). | `POST /v1/businesses/:id/simulations`; `SimulationOrchestrationService` |
| BO can start real operation | **YES.** Orders, products, register sessions, events and operations intake work from an empty business. | `routes/*` |
| Assumptions transition to actual evidence | **NO.** There is no mechanism that retires, supersedes or compares an assumption when actuals arrive (CS-06). | no code path |
| BI matures gradually | **NOT EVALUABLE.** BI has no route or runtime wiring in Stack B (D3 C6, D4 C-04); no maturity gating exists. | D3/D4 |
| OM compares startup assumptions against reality | **NO.** The browser OM block set contains expected-vs-actual comparison, but nothing in Stack B uses it, and outcomes are typed notes (V-13). | D4 C-03 |
| CL learns from assumption error | **NO.** No server-side CL ingestion; browser CL records manual outcomes without an evidence class (V-15). | D3 SOT-04 |

### 7.3 Findings

| ID | Severity | Type | Finding | Evidence |
|---|---|---|---|---|
| **CS-01** | **HIGH** (user-visible) | **implementation defect** | **False certainty on zero data.** With an empty event ledger the Twin is computed as all zeros and is **validated and published as a normal snapshot**, with no evidence class and no data-sufficiency flag. The deterministic recommendation generator then states, for a business with no data: *"The business was profitable over the last 30 days ($0)"* (zero profit is treated as profitable), *"Churn rate is 0%, within a healthy range"*, and rates the actions `low` risk. Cold-Start §7 forbids false certainty ("NOT ENOUGH REAL DATA … Confidence: LOW"). The LLM prompt instructs "if the data doesn't support a strong recommendation, say so plainly", but the deterministic fallback (used whenever no API key is set or the call fails) has no such guard. | `TwinComputationService.ts:95–140` (no emptiness or basis check); `BusinessDecisionRecommendationService.ts` `deterministicRecommendations` (`profit30d < 0` else branch; `churnRatePct > 10` else branch) |
| **CS-02** | HIGH | incomplete implementation | **No data-maturity concept** (Levels 0–4) anywhere. | repository-wide search |
| **CS-03** | HIGH | incomplete implementation | **Onboarding captures identity only** (tenant, workspace, business legal name, trading name, code, industry, legal structure, business model). None of the Standard §5 cold-start inputs are collected: products and prices, expected costs, opening inventory, staff plan, supplier terms, rent and fixed expenses, operating hours, expected customer volume, branches, opening cash, benchmarks, owner assumptions. | `apps/api/src/schemas/onboarding.ts` |
| **CS-04** | MEDIUM | incomplete implementation | **Assumption capacity exists in the schema and repositories but nothing uses it.** `business_digital_twin.twin_assumptions` ("declared, observed, derived, inferred, or external assumption") and `simulation.simulation_scenario_assumptions` exist, with repository classes `TwinAssumptionConstraintRepository` and `SimulationScenarioRepository`. No workflow or API code writes assumptions, so an assumption-based initial Twin cannot be created. | migrations `0055`, `0065`; grep of `packages/workflow`, `apps/api` finds no caller |
| **CS-05** | MEDIUM | incomplete implementation | **No provenance labels** on Twin values, simulation results, recommendations or API responses (Manifest §15). PR #22 would add the six classes at the **event** level only. | grep; PR #22 review |
| **CS-06** | MEDIUM | incomplete implementation | **No assumption→actual loop** (assumption supersession, OM planned-vs-actual, CL assumption-error learning). Depends on the missing contracts V-12/V-13. | D4 |
| CS-07 | LOW | none (positive) | **No feature was found that incorrectly requires mature history to function.** The risk is the opposite: nothing stops mature-looking output from being produced on no history (CS-01). Individual browser analytics blocks (for example trend and forecast engines) naturally need history and were not assessed one by one. | scan |

**ABA link:** the locked ABA specification §§26–27 requires maturity-aware approval behaviour. That cannot be evaluated until a maturity level exists (CS-02) and it reinforces V-11.

---

## PHASE 8 — GUIDED / PROFESSIONAL MODE AUDIT

### 8.1 What the Standard requires

Same backend, calculations, models, state, contracts, permissions and audit trail in both modes; mode changes presentation depth only. Mode selector in the Experience shell, persisted across navigation. Mode ≠ cold-start state ≠ access authority. Every layer exposes **WHAT THIS LAYER DOES / LOOK FOR / WHAT TO DO / NEXT BEST ACTION**.

### 8.2 Results

| Check (spec §13) | Result | Evidence |
|---|---|---|
| Both modes use the same backend, calculations, models, state, contracts, permissions, audit | **TRIVIALLY TRUE, because no modes exist.** Every UI surface already talks to one backend (Stack B) for the lifecycle features. | DM-01 |
| Duplicated Guided/Professional business logic | **None found.** There is no Guided or Professional code to duplicate. | search for guided/professional (case-insensitive) in HTML, JS, TS, CSS |
| Every layer supports the four layer-guide elements | **NO.** None of the four elements appears in `index.html`, `dal.html`, `bol.html`, `theme.js`, `landing.html`, or in any block, bootstrap or API response. | search |
| Mode does not change authorization | **Not violated; not protected.** Nothing keys permissions to a mode, and no test exists to guarantee that stays true. | grep of permission code |
| Cold Start independent of mode (four valid combinations) | **NOT REPRESENTABLE.** There is neither a mode nor a cold-start state dimension (CS-02). | — |

### 8.3 Findings

| ID | Severity | Type | Finding |
|---|---|---|---|
| **DM-01** | MEDIUM | incomplete implementation | **No Guided/Professional mode exists** in the UI, API or any stored state: no selector in the Experience shell, no persistence, no mode-aware rendering. |
| **DM-02** | MEDIUM | incomplete implementation | **No Layer Guide** on any layer. "Next best action" exists only as the decision-recommendation engine (browser ADI-21 and the Stack B recommender); that is a business recommendation, not the layer-guide NBA that tells a user what to do next in the current layer and state. |
| DM-03 | LOW | incomplete implementation | **No guard against future mode-based privilege or logic drift.** When modes are built, an automated test must prove that the two modes yield identical values, calculations, recommendation source, approval state and outcome evidence (spec §22), and that mode never enters a permission decision. |
| DM-04 | LOW | positive | The Stack B API already returns one set of values per request, independent of presentation. A mode can be implemented purely in the Experience layer without duplicating calculations. |

---

## Cross-checks and conclusions

| Check | Result |
|---|---|
| Specification conflict | **None.** The Standards, the Manifest and the locked layer specs agree; the gaps are all in implementation. |
| CRITICAL finding | **None.** CS-01 is the only behaviour that currently produces incorrect statements to users; it is HIGH. |
| Locked specification changed | **No.** |
| Rulings respected | V-06 (CL fail closed), F4 (manual evidence classified as `manual_entry`, never verified) and SOT-01/L-1 are untouched by these audits. |

**Observation for the plan:** CS-01 is small and independent of every other item (an honest "not enough real data" result instead of invented advice). It is an active user-facing defect, so the plan proposes pulling it forward as an independent fix, **subject to your approval** (Phase 10, item P1-A).

**Next:** Phase 9 classification and Phase 10 plan (`ARCHITECTURE_RECONCILIATION_PLAN.md`, `ARCHITECTURE_MIGRATION_PLAN.md`).
