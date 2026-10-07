# ARCHITECTURE_RECONCILIATION_PLAN — BUILD-ARCH-RECON-01, Phases 9 and 10

**Status:** PLAN — no implementation is started by this document. Every item below needs its own approval before work begins, except where an authorisation already exists (noted).
**Authority applied:** Master Architecture Guardrail → locked layer specs → standards → domain contracts → build specs → implementation. No locked specification is changed; where one is silent or conflicts, an amendment is requested, not made.
**Rulings in force:** V-01 release-blocking for ABA→BO; V-06 fail closed; V-04/V-05 remediation (not acceptable legacy); SOT-01 (no provider IDs as public identifiers); SOT-02 (deprecate, gated retirement, no new authority); L-1 (approval sufficiency by action policy / risk class); F4 (chain ADI → ABA → AuthorizedActionPackage → BO → ExecutionEvidence → OM → CL; no direct-call substitutes); D1 (PR #14 keeps 0171, PR #22 renumbers); E5 (production rate-limit values unresolved).

---

## PHASE 9 — CLASSIFICATION (one class per issue)

Vocabulary: KEEP · WRAP_WITH_CONTRACT · MOVE · SPLIT · MIGRATE · DEPRECATE · RENAME · REMOVE_DUPLICATION · ADD_GOVERNANCE_GATE · ADD_PROVENANCE · ADD_VERSIONING · BLOCKED_BY_ARCHITECTURE_DECISION.

### 9.1 Authorization, approval and execution chain

| ID | Sev. | Class | Action (summary) |
|---|---|---|---|
| V-01 | HIGH → CRITICAL when ABA→BO wired | **ADD_GOVERNANCE_GATE** | Approval authority is established externally (Business Administration), only *checked* at approval. `submitApprovalDecision` stops minting authority. Release-blocking. |
| V-11 | HIGH | **MIGRATE** | Add `risk_class`, `valid_until`, stale-decision fields to ADI/ABA data model by new migrations (never edit 0001–0170). Reconcile with locked ABA §§8, 11, 12 first. |
| C-11 | PROVISIONAL → confirmed by L-1 | **ADD_GOVERNANCE_GATE** | Same fix as V-01 (the orchestrator's self-assignment). Tracked once, under V-01. |
| V-02 | HIGH | **WRAP_WITH_CONTRACT** | Orchestrator stops writing two layers' tables in one request; generate rows from the validated handoff at each boundary. |
| C-01 / V-14 | HIGH / MEDIUM | **WRAP_WITH_CONTRACT** | Wire the six dormant validators in dependency order (below). Any validator found obsolete or conflicting is *reported*, not silently dropped. |
| C-02 / V-12 | HIGH | **BLOCKED_BY_ARCHITECTURE_DECISION** → unblocked by V-01/V-11 completion | `AuthorizedActionPackage` is built only after steps 1–4 of the V-01 order pass. |
| C-03 / V-13 | HIGH | **MIGRATE** | Introduce `ExecutionEvidence` (BO→OM) and `VerifiedOutcomeEvidence` (OM→CL) after C-02. Typed outcomes stay `manual_entry`, never verified. |
| V-15 | MEDIUM | **ADD_PROVENANCE** | Browser CL learning state carries evidence class; `manual_entry` is never promoted. |
| V-06 | HIGH (latent) | **ADD_GOVERNANCE_GATE** | CL fails closed: missing confidence / evidence class / review state ⇒ `insufficient_evidence`, never accepted. No `?? 0.7` defaults; human review default on at activation. CL not activated against production outcomes until enforced. |

### 9.2 Identity, credentials, legacy surface

| ID | Sev. | Class | Action |
|---|---|---|---|
| V-05 | MED–HIGH | **MIGRATE** | Remove the derived password and provider id from `localStorage`; server-side token exchange; non-breaking, feature-flagged, with rollback. |
| V-04 / C-12 | MEDIUM | **MIGRATE** | Tenant slug and contract identifiers use an INFINICUS-controlled principal id, not a provider-id fragment. Existing slugs are kept (no rename of live data); new ones use the new scheme. |
| V-17 / C-13 | MEDIUM (security) | **DEPRECATE** | Gated: legacy `/api/business/*` and `/api/auth/*` keep running, gain no new authority, retire only after the SOT-02 gates pass and explicit authorisation. |
| SOT-11 | LOW | **KEEP** | Stack A waitlist/feedback/nurture/parse-idea stay; port before any Stack A retirement. |

### 9.3 Source of truth and duplicates

| ID | Sev. | Class | Action |
|---|---|---|---|
| SOT-03 | HIGH | **BLOCKED_BY_ARCHITECTURE_DECISION** | Needs a ruling on which store is canonical for scenario outcomes (proposal: Stack B `simulation.*`; Supabase/localStorage become read caches). |
| SOT-04 | HIGH | **MIGRATE** | Server-side CL ingestion via the OM→CL contract, after V-06 and C-03. Browser CL stays as a cache until then. |
| SOT-05 | MEDIUM | **BLOCKED_BY_ARCHITECTURE_DECISION** | Entitlement/usage split (Supabase `profiles` vs Stack B `billing.*`): owner decision required. |
| SOT-06 | MEDIUM | **BLOCKED_BY_ARCHITECTURE_DECISION** | Legacy D1 data volume unknown; import-or-abandon is a business decision tied to SOT-02 gates. |
| SOT-07 | MEDIUM | **BLOCKED_BY_ARCHITECTURE_DECISION** | `platform.*` has no declared single owner; BO vs `business_operations.*` boundary needs a ruling. |
| V-08 / SOT-08 | MEDIUM | **REMOVE_DUPLICATION** | One writer path per BO table (`business_events`, `inventory_balances`, `purchase_orders`), decided after SOT-07. |
| V-07 / SOT-09 | MEDIUM | **WRAP_WITH_CONTRACT** | Replace BO's write to `data_acquisition.publication_deliveries` with a contract call or a BO-owned receipt. |
| SOT-10 | LOW | **DEPRECATE** | Unused `platform.*` foundation tables: mark deprecated; no drops (migrations are immutable). |
| SOT-12 / C-04 | MEDIUM | **WRAP_WITH_CONTRACT** | Add `CurrentOperationalState` and `AnalyticalEvidence` inputs to the Twin; BI evidence leg. |
| V-03 / C-05 | MEDIUM | **WRAP_WITH_CONTRACT** | Simulation flow references a Twin snapshot (`dt-to-sim`). Product-flow change: needs approval. |
| V-09 | MEDIUM | **REMOVE_DUPLICATION** | One canonical profit/burn-rate calculation (proposal: Stack B domain function); Stack A copies stay until cutover. |
| V-10 | MEDIUM | **REMOVE_DUPLICATION** | One simulation engine authority (proposal: `packages/simulation-engine`); the in-page engine is the legacy copy, kept until cutover. |
| V-16 | LOW | **KEEP** | Not scanned in depth; schedule a comparison before any change. |
| Root vs `infinicus-platform` duplicate blocks (C3) | — | **BLOCKED_BY_ARCHITECTURE_DECISION** | Proposal: platform copies = target, root = legacy deployed copy. Needs approval; no delete, move or silent sync. |

### 9.4 Contracts and events

| ID | Sev. | Class | Action |
|---|---|---|---|
| C-06 | MEDIUM | **ADD_VERSIONING** | Documented compatibility policy (window / adapter) instead of strict equality only. |
| C-07 | MEDIUM | **MIGRATE** | Derive idempotency keys from the business request, not `randomUUID()` per call. |
| C-08 | MEDIUM | **WRAP_WITH_CONTRACT** | Shared credential-key scan helper used by all nine contracts. |
| C-09 | LOW | **KEEP** | Consumer guards today; tighten the type later. |
| C-10 | LOW | **KEEP** | Do not rename; add a manifest-name mapping table. |
| E-01, E-02, E-03 | MEDIUM | **MIGRATE** | Closed for the ledger by PR #22 once renumbered and merged by its owner. |
| E-04, E-05 | MEDIUM | **WRAP_WITH_CONTRACT** | Define manifest events (`ACTION_AUTHORIZED`, `ACTION_EXECUTED`, `OUTCOME_VERIFIED`, …) together with C-02/C-03. |
| PM-1, PM-2, PM-3, PM-4 | pre-merge | **KEEP** (owner's change) | Hand-off in `PR22_HANDOFF_NOTE.md`. PR #22 is not modified by this reconciliation. |

### 9.5 Cold start and dual mode

| ID | Sev. | Class | Action |
|---|---|---|---|
| CS-01 | HIGH | **ADD_PROVENANCE** | Honest "NOT ENOUGH REAL DATA / confidence LOW" result instead of invented advice on empty data. Pull-forward proposed (P1-A). |
| CS-02 | HIGH | **ADD_VERSIONING** | Introduce the data-maturity Level 0–4 value (versioned enum), derived, never user-asserted. |
| CS-03 | HIGH | **MIGRATE** | Extend onboarding to capture cold-start inputs (additive, optional fields). |
| CS-04 | MEDIUM | **WRAP_WITH_CONTRACT** | Use existing `twin_assumptions` and `simulation_scenario_assumptions` through workflow/API. |
| CS-05 | MEDIUM | **ADD_PROVENANCE** | The six provenance labels on Twin, simulation and recommendation outputs. |
| CS-06 | MEDIUM | **MIGRATE** | Assumption→actual supersession and OM planned-vs-actual; depends on C-03. |
| CS-07 | LOW | **KEEP** | No feature requires history; nothing to change. |
| DM-01 / DM-02 | MEDIUM | **ADD_GOVERNANCE_GATE** | Guided/Professional mode and Layer Guide in the Experience layer only; a mode-equivalence test is the gate. |
| DM-03 | LOW | **ADD_GOVERNANCE_GATE** | Test that mode never enters a permission decision. |
| DM-04 | LOW | **KEEP** | Positive finding. |

**Classification summary:** no item is REMOVE, MOVE, SPLIT or RENAME-recommended now. Six items are BLOCKED_BY_ARCHITECTURE_DECISION (SOT-03, SOT-05, SOT-06, SOT-07, the duplicate blocks, and C-02/V-12 until V-01/V-11 complete). V-03 is classified WRAP_WITH_CONTRACT but its flow change needs approval.

---

## PHASE 10 — ORDERED PLAN

Each item is one reviewable change set. Nothing starts without approval of that item. Every item ends with validation (lint, typecheck, build, dependency scan, migration gate, grants, live-Postgres/RLS tests, image smoke where touched).

### P0 — Architecture safety (blocks everything that executes actions)

**V-01 / V-11 are the FIRST hard prerequisite; ABA→BO is not wired before step 6.** Mandatory order:

| Step | Work | Gate to pass before the next step |
|---|---|---|
| P0-1 | **Establish authoritative approval authority.** Assignments issued only by Business Administration (authenticated identity, role, tenant/business scope, permissions). `submitApprovalDecision` *checks* authority and never creates it. Remove the self-issue code path. | Test: a caller with no pre-existing assignment cannot approve; an assignment created in the same request is not honoured. |
| P0-2 | **Enforce action-risk policy.** Policy table/service maps action type → risk class → required approver role/threshold (L-1: one click is not universally sufficient). | Test per risk class; low-risk and high-risk paths differ as the policy says. |
| P0-3 | **Add `risk_class` / `valid_until` controls.** New migration(s) (next free number; never editing 0001–0170) plus stale-decision protection. First: a written reconciliation of the locked ABA §§8, 11, 12 requirements with the data model; any mismatch goes to the user as an amendment request. | Expired or stale decisions are rejected; migration gate and RLS tests on live Postgres. |
| P0-4 | **Validate authorization and audit behaviour.** Audit record on every approve/deny/expire; contract and end-to-end tests. | All tests green; audit trail complete. |
| P0-5 | **Implement and validate `AuthorizedActionPackage`** (versioned contract, validator, immutable recommendation/action reference, BO re-check before execution per ABA §16). | Contract tests; no direct ADI/ABA→BO call exists. |
| P0-6 | **Only then** allow ABA→BO execution wiring, behind a feature flag defaulting off. | Explicit approval to enable. |

**Guard now (small, independent, proposed):** a test that fails if any BO code path consumes `ApprovedAction` as execution authority. It keeps today's isolation from regressing before P0-6. *Needs approval.*

**P0-V06 — CL fail closed** (parallel to P0-1..4, independent of them): remove `?? 0.7` defaults in the 18 CL engines and the `Boolean(undefined)` review default; absent confidence/evidence class/review state ⇒ `insufficient_evidence`. CL stays disabled for production outcomes until verified evidence contracts (C-03), review requirements and confidence rules are enforced.

### P1 — Contract integrity

| Item | Work | Depends on |
|---|---|---|
| **P1-A** | **CS-01 independent fix:** `TwinComputationService` / `deterministicRecommendations` return "not enough real data, confidence LOW" on empty or insufficient ledgers. Small, user-visible. | Approval to pull forward |
| P1-B | Wire validators in dependency order: ADI→ABA (V-02), then ABA→OM, OM→CL, CL feedback, BI→DT, DT→SIM. Each goes into the orchestrator as a validation call with generated rows. | P0-1..4 for ADI→ABA and ABA→OM |
| P1-C | C-07 idempotency keys, C-08 shared credential scan, C-06 compatibility policy. | none |
| P1-D | C-03 `ExecutionEvidence` / `VerifiedOutcomeEvidence`; E-05 manifest events. | P0-5 |
| P1-E | V-15 evidence class on browser CL learning state (`manual_entry`). | none |
| P1-F | V-07 BO receipt instead of the cross-schema write. | none |

### P2 — Layer alignment

| Item | Work |
|---|---|
| P2-A | SOT-04 server-side CL ingestion (needs V-06, C-03). |
| P2-B | SOT-12 / C-04 BI evidence leg and `CurrentOperationalState` for the Twin; V-03 simulation references a Twin snapshot (needs approval of the flow change). |
| P2-C | V-09 / V-10 canonical profit, burn-rate and simulation authority. |
| P2-D | V-08 one writer per BO table (after SOT-07 ruling). |
| P2-E | SOT-03 canonical scenario store (after ruling). |

### P3 — Experience alignment

| Item | Work |
|---|---|
| **P3-A** | **Identity migration (V-05, V-04):** (1) INFINICUS-controlled principal id issued server-side; (2) server-side token exchange so no password/provider id is browser-readable; (3) SPA switches behind a feature flag, existing users migrate on next sign-in without breakage; (4) purge `inf_backend_account_v2` after successful migration; (5) rollback = flag off, old path intact until retired. |
| P3-B | CS-02/03/04/05/06 maturity levels, onboarding inputs, assumptions through the API, provenance labels, assumption→actual loop. |
| P3-C | DM-01/02/03 Guided/Professional mode and Layer Guide; mode-equivalence test. |

### P4 — Cleanup (all gated, nothing destructive without authorisation)

- **SOT-02 retirement checklist** for `/api/business/*` and `/api/auth/*`: Stack B replacement confirmed · dependent clients inventoried · data/SoT migration complete (SOT-06 ruling) · compatibility validation · production cutover plan · rollback path · explicit retirement authorisation. Until then: no new authority, no blocking.
- SOT-10 mark unused `platform.*` tables deprecated (no drops).
- Duplicate blocks (C3): classification only after approval; no mass-delete, move or silent sync.
- Zips are kept (C1 = NO).

### Items outside this plan's control

- **PR #25** (dependency fixes): awaiting manual merge by the user.
- **PR #23 / PR #14:** after PR #25 merges, update from `main`, regenerate lockfiles with pnpm 10.33.0, and re-validate from the refreshed heads (E2). PR #14 becomes ready for review only when all eight E4 conditions hold.
- **PR #22:** owner's change; see `PR22_HANDOFF_NOTE.md`.
- **E5:** production `RATE_LIMIT_MAX` and expected webhook volume are unresolved. 300/120 per 60 s stay classified as TEST DEFAULTS only.

---

## Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| 1 | Approve **P0-1** (approval-authority fix) as the first implementation block. | Yes, first. |
| 2 | Approve the small **BO-must-not-consume-ApprovedAction** guard test now. | Yes. |
| 3 | Approve **CS-01** (P1-A) as an independent early fix. | Yes: it states false facts to users today. |
| 4 | Rule on **SOT-03** (canonical scenario store). | Stack B `simulation.*`. |
| 5 | Rule on **SOT-05, SOT-06, SOT-07**. | Gather facts first (production row counts, plan data owner). |
| 6 | Approve proposed canonical copies for duplicate blocks (C3): platform = target, root = legacy. | Yes, classification only. |
| 7 | Approve the open V-03 flow change (simulation references a Twin snapshot). | Defer until P1-B and P2-B. |
| 8 | Provide E5 production values or confirm they stay unresolved. | Unresolved is acceptable; no invention. |
