# ARCHITECTURE_VIOLATIONS — BUILD-ARCH-RECON-01, Phase 6 (D5)

**Status:** SCAN COMPLETE — analysis only. No locked specification, source of truth, contract or authorization boundary was changed, and nothing was repaired in this phase.
**Authority applied:** Master Manifest v1.0 §10–11 (ownership, no-direct-mutation); locked ABA v1.0 §§8, 11, 12, 16; authorisation of 2026-10-07 including the authoritative rulings below.
**Baseline:** `main` `ad6440c` (Stack B code and the root Stack A bundles). PR #14 (webhook) and PR #22 (BUILD-33) are noted where relevant and are not baseline.
**Method / limits:** targeted source reading and grep for each of the eight spec classes (§11.1–11.8). Roughly 200 browser blocks were scanned by pattern, not read in full. Nothing was run against production.

## Rulings applied (these replace the earlier PROVISIONAL markers)

| Ruling | Effect on this audit |
|---|---|
| **SOT-01 = NO** | Provider (Supabase/auth) user identifiers must not be exposed to third parties as public business identifiers; external contracts use INFINICUS-controlled stable identifiers. Where code exposes them it is a **migration/remediation finding**; no destructive migration is required now. |
| **SOT-02 = YES, not now** | Legacy `/api/business/*` is to be deprecated and ultimately blocked/removed, **only after** the retirement gates pass (Stack B replacement confirmed, dependent clients inventoried, data migrated, compatibility validated, cutover plan, rollback path, explicit authorization). Until then it may stay operational but **must gain no new architectural authority**. |
| **L-1 = NO** | One click is **not** universally sufficient. ABA approval is valid only if: authenticated principal, current identity, required role, tenant/business scope, action-specific permission, current authorization state, immutable recommendation/action reference, audit record, policy/risk requirements. Sufficiency is set by **action policy / risk class**; low-risk may allow one authorized interaction, higher risk may need step-up, maker-checker or multi-party approval. |
| **F4** | The intended chain stays ADI → ABA → `AuthorizedActionPackage` → BO execution → `ExecutionEvidence` → OM → CL. Missing contracts are **implementation gaps**, not a reason to change the architecture, and must not be replaced by direct calls or informal payloads. The six dormant handoff validators must be classified and wired to their locked contracts, or reported obsolete/conflicting. Manual outcome notes may remain only if classified `manual_entry`; CL must not treat unverified outcomes as authoritative learning evidence. |

## Violation type vocabulary

`implementation defect` · `incomplete implementation` · `duplicate source of truth` · `unauthorized direct mutation` · `contract bypass` · `authorization bypass` · `stale/legacy implementation` · `specification conflict`

**Specification conflicts found: none.** The locked ABA spec (§8 role- and policy-controlled approval with thresholds; §11 stale-decision protection; §12 valid-until; §16 BO re-checks before execution) and the Master Manifest are consistent with the L-1 and F4 rulings. Every item below is an implementation gap against an unchanged specification.

**Unauthorized direct mutation found: none** (see §11.2, §11.3, §11.5).

---

## 1. Summary by scan class

| Class | Result |
|---|---|
| 11.1 Simulation-first BI | No BI dependency on Simulation output. The *product flow* is simulation-first (V-03). |
| 11.2 AI direct operational mutation | **None.** ADI and the workflow orchestrator write only ADI/ABA/OM/DT records; no BO table is written. |
| 11.3 Simulation mutation | **None.** The simulation engine is pure compute; simulation and orchestration code issue no SQL writes to operational tables. |
| 11.4 Twin as transaction store | **None.** The Twin is derived from the BO ledger and not read back as a transaction source. |
| 11.5 OM direct execution | **None** found in Stack B or the OM bundle (the only "rollback" strings are in the OM-25 assembly/deployment engine). |
| 11.6 CL silent mutation | **No activation or overwrite found**, but **fail-open governance defaults** (V-06). |
| 11.7 Cross-domain private table access | Contract-bypass writes: V-02, V-07, V-08. |
| 11.8 Duplicate calculation logic | V-09, V-10. |
| Rulings SOT-01 / SOT-02 / L-1 / F4 | V-01, V-04, V-05, V-11–V-14. |

---

## 2. Findings

Severity follows spec §8: **CRITICAL** blocks reconciliation completion; none of the findings below is CRITICAL today (reasoning in §3).

### 2.1 Authorization (L-1)

| ID | Severity | Scan class | Type | Finding | Evidence |
|---|---|---|---|---|---|
| **V-01** | **HIGH today; becomes CRITICAL when ABA→BO is wired** | 11.2 / ruling L-1 | **authorization bypass** (implementation defect) | **Approver authority is self-issued.** `DecisionWorkflowService.submitApprovalDecision` *creates* an approver assignment, `createVersion`s it and transitions it to `active` for the `approverUserId` it is given, then records and approves the decision in the same call. `startChoiceReview` passes the caller's own `ctx.userId` and a generated `assignmentCode`. The only gate is the route permission `aba:write`. Against the L-1 conditions: authenticated principal ✓, tenant/business scope ✓ (context and route); **required role ✗, action-specific permission ✗** (generic `aba:write` only), **current authorization state ✗** (created on demand), **policy/risk requirement ✗** (no risk class or threshold anywhere), immutable recommendation reference partial (recommendation id passed to `createAction`), audit record partial (decision rows exist; whether the `audit` schema captures them was not verified). Click count is effectively the whole authorization. | `DecisionWorkflowService.ts:165–168`; `BusinessDecisionRecommendationService.ts` `startChoiceReview`; route `POST …/decision-recommendations/:id/choice` guard `aba:write` |
| **V-02** | HIGH | 11.7 | **contract bypass** | The orchestrator writes **two layers' tables in one request** for ADI→ABA and again for ABA→OM (publication packages, intake receipt/acceptance, review, decision, approved action, monitoring plan, monitored action, observation) by calling repositories directly. The typed handoff validators for these legs are never invoked (D4 C-01). | `BusinessDecisionRecommendationService.ts` `startChoiceReview`, `recordChoiceOutcome`; D4 §3 |
| **V-11** | HIGH | ruling L-1 / locked ABA §§11–12, §8 | **incomplete implementation** | **The data model cannot express what the locked ABA spec requires.** No `valid_until`/expiry column on any ADI/ABA/decision table (searched all 170 migrations; `valid_until`/`expires_at` appear only on unrelated tables), no action risk class or required-approver field on ABA tables, and no stale-decision check ("Twin state changed after recommendation") in the approval path. Without them approval sufficiency cannot be decided by action policy. | migration search; `DecisionWorkflowService`/`BusinessDecisionRecommendationService` have no stale/expiry/risk handling |

**Why V-01 is not CRITICAL today:** the `ApprovedAction` it produces has **no execution consumer**: only OM monitoring records reference it, no `AuthorizedActionPackage` exists (V-12), and no Business Operations code reads ABA output, so no operational effect can follow. This is a **latent** authorization defect. It must be corrected **before** the ABA→BO leg is built; otherwise it becomes an ABA bypass with real effect. **STOP-AND-REPORT status:** this is reported here, nothing was changed, and no later phase will wire the ABA→BO contract on top of it.

### 2.2 Identity (SOT-01)

| ID | Severity | Type | Finding | Evidence |
|---|---|---|---|---|
| **V-04** | MEDIUM | **implementation defect** → migration/remediation | **Provider ID fragment used as a business identifier.** The tenant slug is built as `'demo-' + supaId.slice(0, 8) + '-' + stamp`, so the first 8 characters of the Supabase user ID travel into the INFINICUS tenant record and anything that displays or exports the slug. Contradicts "must not be exposed as public business identifiers". | `index.html:3627` |
| **V-05** | **MEDIUM–HIGH** | **implementation defect** (credential handling) → migration/remediation | **The derived backend password and the provider ID sit in `localStorage` in plaintext** (`inf_backend_account_v2` holds `{ supaId, email, password }`), readable by any script that runs in the page origin. The page loads third-party scripts (Google tag, jsDelivr-hosted Supabase client). The scheme also makes the provider ID the *only* secret behind the Stack B login: password and email are SHA-256 of fixed labels plus `supaId`, computable in the browser from public code. The SOT-01 ruling says the ID must not leak; this design makes any leak a full Stack B account takeover and keeps the ID in a store third-party scripts can read. Remediation direction (no destructive migration required now): stop deriving credentials from a provider ID; bind identity server-side (verify the provider token on the API and issue an INFINICUS-controlled stable principal id); keep tokens out of script-readable storage. | `index.html:3523–3535, 3594–3596`; `saveBackendAccount()` |

### 2.3 Contract and execution chain (F4)

| ID | Severity | Type | Finding | Evidence |
|---|---|---|---|---|
| **V-12** | HIGH | **incomplete implementation** | **`AuthorizedActionPackage` (ABA→BO) does not exist.** Business Operations has no consumer of ABA output; its command executor is fed by DAL publications. Not to be replaced by direct calls or informal payloads (ruling F4). | D4 C-02 |
| **V-13** | HIGH | **incomplete implementation** | **`ExecutionEvidence` (BO→OM) and `VerifiedOutcomeEvidence` (OM→CL) do not exist.** The observation is created from caller text with `evidenceType: 'manual_entry'`, which is the allowed classification for manual evidence. It is **not** equivalent to verified execution evidence, and nothing carries it to server-side CL. | `recordChoiceOutcome`; D4 C-03 |
| **V-14** | MEDIUM | **incomplete implementation** → classification required | **Six dormant handoff validators** (`BI→DT`, `DT→SIM`, `ADI→ABA`, `ABA→OM`, `OM→CL`, `CL feedback`). **Preliminary classification: WIRE per the locked contracts; none is determined obsolete or conflicting.** I compared names, versions and required fields at the structural level only; a field-by-field comparison against each locked layer specification is deferred to Phase 9 and may reclassify any of them. Dependency order: ADI→ABA must follow V-01/V-11, and ABA→OM follows V-12. | D4 C-01 |
| **V-03** | MEDIUM | **contract bypass** | The product flow is **simulation-first**: `POST /v1/businesses/:id/simulations` runs DAL→SIM→ADI with no BI evidence and no Twin snapshot (D4 C-04, C-05), although the BI and Twin layers exist. BI itself does not depend on Simulation output. | `SimulationOrchestrationService.ts`; `routes/businesses.ts` |
| **V-15** | MEDIUM | **implementation defect** | **Browser CL registers a manual outcome without carrying its evidence class.** `clRegisterRealOutcome` registers `registerLearningState({ state: 'received', confidence: null, reliability: null })` from a typed note. It is correctly non-committal, but the learning state does not record `manual_entry`, and the runtime counts it in its diagnostics. Under the F4 ruling the classification must be explicit, and CL must not treat it as authoritative. | `index.html` `clRegisterRealOutcome` |

### 2.4 Governance defaults (§11.6)

| ID | Severity | Type | Finding | Evidence |
|---|---|---|---|---|
| **V-06** | HIGH (latent) | **implementation defect** | **CL-22 fails open.** The deployment policy defaults to `minimumConfidence 0.5`, `minimumReliability 0.5` and `requireHumanReview = false`, and the engine substitutes `confidence ?? 0.7` and `reliability ?? 0.7` when none is supplied. A package with **no** confidence or reliability therefore passes (0.7 ≥ 0.5) and is marked `accepted` with no human review. The same `?? 0.7` fallback appears in **18 CL engines**. CL-22 only records a status and hands off to CL-23; no model or rule is activated anywhere in the code, so there is no silent mutation today. But governed-learning evidence is being synthesised from defaults, which conflicts with the F4 ruling that unverified outcomes must not become authoritative learning. Applies to both the root and platform copies of the block. | `continuous-learning/INFINICUS-CL-22*/src/engine/engine.js:14–22`, `model/policy.js:13–15` |

### 2.5 Cross-boundary writes and duplicated logic

| ID | Severity | Scan class | Type | Finding | Evidence |
|---|---|---|---|---|---|
| **V-07** | MEDIUM | 11.7 | **contract bypass** | `business-operations-runtime` inserts and updates `data_acquisition.publication_deliveries`, a table in DAL's schema (D3 SOT-09). Plausibly a delivery acknowledgement; it should be a contract call or a BO-owned receipt. | `BusinessIntakeService.ts:234–437` |
| **V-08** | MEDIUM | 11.7 | **duplicate source of truth** | BO operational truth is split between `platform.*` and `business_operations.*`; three BO tables have two writer paths (D3 SOT-07, SOT-08). Within one layer, so no boundary is crossed. | D3 |
| **V-09** | MEDIUM | 11.8 | **duplicate source of truth** | **Profit and burn-rate logic is implemented in four places:** Stack A `summary.js:144` and `twin.js:123–124`, Stack B `BusinessEventRepository.ts:192` (burn rate), and `TwinComputationService.ts:115` (30-day profit, from the repository's revenue and spend aggregates). Analytical KPIs belong to BI; here the Twin service computes one and BO's repository another. **Proposed authority: BI for derived KPIs, BO repositories for raw operational aggregates, Twin consumes BI evidence.** | files cited |
| **V-10** | MEDIUM | 11.8 | **duplicate source of truth + stale/legacy** | **Two simulation engines:** the browser page's in-page engine (`monteCarlo()` and related code in `index.html`) and `packages/simulation-engine/src/monteCarlo.ts`, which says it is "Ported verbatim from index.html's monteCarlo()". Results are persisted in three places (D3 SOT-03). **Proposed authority: `packages/simulation-engine`; the page copy is legacy until cutover.** | `monteCarlo.ts:14` |
| **V-16** | LOW | 11.8 | not scanned in depth | Decision confidence and outcome status exist in the browser ADI/OM blocks, the Stack B deterministic generator, and Stack A `decisions.js`. A full comparison was not done. | — |

### 2.6 Legacy (SOT-02)

| ID | Severity | Type | Finding | Evidence |
|---|---|---|---|---|
| **V-17** | MEDIUM (security, existing) | **stale/legacy implementation** | Legacy `/api/business/*` and `/api/auth/*` remain deployed and trust client-supplied `user_email` / `business_id`. **Ruling: deprecate now, retire only after the gates pass; they must gain no new authority.** **Not blocked, not changed.** This audit adds the retirement-gate checklist to the plan phase and records that no new feature may be built on these endpoints. | D3 SOT-02 |

---

## 3. Severity decisions and STOP-AND-REPORT check

| Standing-rule condition | Result |
|---|---|
| CRITICAL involving source of truth, layer ownership, domain boundary | none |
| **Authorization flow / ABA bypass** | **V-01 reported** (HIGH, latent). Not CRITICAL only because nothing consumes the result. **No fix attempted; nothing may be wired on top of it until corrected.** |
| Event/handoff or data contract | missing and bypassed contracts reported (V-02, V-12–V-14); no two files define the same contract |
| Direct mutation, duplicate canonical writer | none (V-08 and V-09 are duplicates within a layer or derived values) |
| Simulation mutation, ADI direct execution | none |
| OM evidence mutation | none |
| **CL self-modification or ungoverned calibration** | none activated; **V-06 fail-open defaults** reported |
| **Specification conflict** | **none**; no STOP on this ground |

## 4. Reconciliation direction (for Phase 9/10, not decided here)

| ID | Direction | Vocabulary |
|---|---|---|
| V-01, V-11 | Derive approval from an action-policy/risk model: assignments issued by Business Administration, checked (not created) at approval, with risk class, thresholds, valid-until and stale checks in the data model. **Prerequisite for any ABA→BO wiring.** | MIGRATE |
| V-02, V-14 | Call the validated handoff at each boundary; generate publication/intake rows from the validated payload; wire the six validators in dependency order. | WRAP WITH CONTRACT |
| V-12, V-13 | Introduce `AuthorizedActionPackage`, then `ExecutionEvidence` / `VerifiedOutcomeEvidence`, each with its own version and validator. | MIGRATE |
| V-04, V-05 | Server-side identity binding with INFINICUS-controlled ids; remove secrets from script-readable storage. No destructive migration now. | MIGRATE |
| V-06 | Fail closed: absent confidence/reliability must yield `insufficient_evidence`; human review default on for activation. | KEEP (behavior), fix defaults |
| V-07 | Replace the cross-schema write with a contract call or BO-owned receipt. | WRAP WITH CONTRACT |
| V-09, V-10 | Assign the authorities proposed above; keep legacy copies until cutover. | SPLIT / DEPRECATE |
| V-15 | Add `manual_entry` evidence class to learning state; never promote it. | MIGRATE |
| V-17 | Keep running; add retirement-gate checklist; no new authority. | DEPRECATE (gated) |

---

## 5. Completion status

| Spec item (§11) | Status |
|---|---|
| 11.1–11.8 scanned | Done; limits as stated |
| Each violation classified by type | Done (§2) |
| True specification conflict | None found |
| Reconciliation without changing locked specifications | Maintained |

**Next:** Phase 7 — Cold-Start audit (D-series) and Phase 8 — Guided/Professional mode audit.
