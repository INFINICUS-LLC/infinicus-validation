# SOURCE_OF_TRUTH_AUDIT — BUILD-ARCH-RECON-01, Phase 3 (D3)

**Status:** AUDIT COMPLETE — **read-only**. No application code, schema, specification or data was changed in this phase.
**Authority applied:** Master Manifest v1.0 §4 (truth per layer), §10–11 (ownership, no direct mutation), Layer Guidance & Cold-Start v1.0, Dual-Mode v1.0; authorisation of 2026-10-07 (A1 Stack B = target for all 9 layers, Stack A not retired by this build; A2/A3 domain classification only; domains never transfer layer ownership).
**Severity scale (spec §8):** CRITICAL (blocks reconciliation completion) / HIGH / MEDIUM / LOW.
**Headline:** **no CRITICAL finding by the evidence collected.** Two HIGH findings involve authorisation flow (SOT-01, SOT-02) and are flagged for your explicit severity decision before any later phase proposes a fix (§7).

---

## 0. Corrections to D1 and D2 (found while auditing)

Phase 3 evidence disproved parts of my earlier documents. Both have an Errata section added; the substance:

| Earlier statement | Correction | Evidence |
|---|---|---|
| D1 §1 / O-1: Stack B is "not wired to Stack A"; "no shared data path" | **Wrong.** The live SPA (`index.html`) already calls the production Stack B API (`https://api.infini-cus.com`, 35 `/v1/businesses/…` call sites, plus `/v1/auth/*`, `/v1/onboarding/*`) via `backendFetch`/`ensureBackendBusiness`. Stack A's `/api/business/*` D1 endpoints are **no longer called** by any HTML page. | `index.html:3481–3689`; grep of all six pages |
| D1 O-4 / §4 / §5.1: `data-acquisition-runtime` writes `tenancy` and `platform` tables | **Unconfirmed — retracted.** My original scan included test fixtures; a source-only multi-line scan finds **no** such writes. The `business-operations-runtime → data_acquisition.publication_deliveries` write **is** real (`BusinessIntakeService.ts:234–437`). | re-scan of `packages/data-acquisition-runtime/src` |
| D1 O-1 as the single architecture conflict | Replaced by the more precise picture in §1: **four** persistence/identity systems, not two stacks. | §1 |

---

## 1. Persistence systems actually in use

| ID | System | What it holds today | Written by | Read by | Status |
|---|---|---|---|---|---|
| P1 | **Stack B PostgreSQL** (`api.infini-cus.com`, Hetzner) | 19 schemas, ≈478 tables, RLS | `apps/api` → `packages/*` | same | **Authoritative target (A1)** |
| P2 | **Supabase** (`dxheognltijswhtpnndk.supabase.co`) | End-user auth (sign-up/in/reset), `profiles` (`plan`, `sim_count`), `simulations` (params + summary) via `increment_sim_count` RPC | SPA directly (`SUPA.from(...)`), `index.html:809–885` | SPA | **Live; not in any prior inventory** |
| P3 | **Cloudflare KV `INFINICUS_USERS`** | Legacy users/sessions; twin cache | `functions/api/auth/*`, `business/twin` | `account.html`/`landing.html` (`change-password` only) | Partly live |
| P4 | **Cloudflare D1 `INFINICUS_DB`** | `businesses`, `business_events`, `decision_memory` (legacy backend) | `functions/api/business/*` | same | **Deployed, no frontend caller**; may hold production data |
| P5 | **Cloudflare KV `INFINICUS_WAITLIST`** | Waitlist, nurture/feedback sends | `waitlist`, `nurture*`, `feedback` | same | Live; non-lifecycle |
| P6 | **Browser `localStorage`** | `infinicus_history`, `infinicus_scenarios`, `inf_cl_history_v1`, `infinicus_waitlist`, `infinicus_user` (plan, simCount, supaId), backend shadow-account credentials (`inf_backend_account_v2`) | SPA | SPA | Live |

Browser-global IIFE bundles (root `data-acquisition/` … `continuous-learning/`) also run in the SPA (`index.html:790–802`) with their own IndexedDB-style stores; their state is per-browser and not synchronised with P1.

---

## 2. Capability audit (spec §8 + authorisation D1)

Legend — **Layer** = lifecycle-layer owner (Manifest §4); **Domain** = platform-domain classification (A2/A3, classification only). *Canonical candidate* = where the truth should live per A1. "Shortcut" = direct-mutation shortcut found. All Stack B facts are from source; none was run against a live database.

### 2.1 Layer-truth capabilities

| # | Capability | Layer / Domain | Current writer → store (Stack A) | Current writer → store (Stack B) | Readers | Canonical candidate | Duplicate state | Authorization boundary | Shortcut | Migration need | Unresolved conflict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | User identity, sessions | — / BUSINESS ADMIN | `functions/api/auth/*` → P3 KV; Supabase Auth (P2) from SPA | `/v1/auth/*` → `identity.*` | SPA, API | Stack B `identity` **or** Supabase (undecided) | **3 stores** (P2, P3, P1); Stack B accounts are **derived**, not user-chosen | Supabase JWT in browser; Stack B bearer token | Shadow-account password derived client-side from `supaId` (SOT-01) | Decide identity provider; migrate or retire P3 | **SOT-01** |
| C2 | Business / tenant profile | BO (BO-02/03) / BUSINESS ADMIN | `business/manage` → D1 `businesses` | `/v1/onboarding`, `/v1/businesses` → `tenancy.*`, `platform.businesses` | SPA | Stack B | D1 `businesses` (legacy) vs `platform.businesses`/`tenancy.*` | tenant context + RLS | none | D1 import-or-archive decision | SOT-06 |
| C3 | Operational events, orders | **BO** / OPERATIONS+COMMERCE | `business/events` → D1 `business_events` | `/v1/…/events`, `/orders` → `business_operations.business_events`, `platform.orders` | BI, Twin, SPA | Stack B | D1 `business_events` (legacy, no new writes from SPA) | `bo:write`, idempotency key, subscription | none | legacy history only | SOT-06, SOT-08 |
| C4 | Operational masters (suppliers, inventory, assets, warehouses, employees, products) | **BO** / OPERATIONS+COMMERCE | — | `platform.*` (read by `OperationalCommandExecutor`) and `business_operations.*` | BO runtime, routes | Stack B | **BO truth split across two schemas** | `bo:*` | none found | none (classification) | SOT-07 |
| C5 | Prepared data / publication packages | **DAL** / DATA | `data-acquisition/` bundle (browser state) | `/v1/…/data-sources/*` → `data_acquisition.*` | BO intake | Stack B | browser-bundle state vs server | `da:*` | `BO` writes `data_acquisition.publication_deliveries` | none | SOT-09 |
| C6 | Analytical evidence / KPI summary | **BI** / INTELLIGENCE | `business/summary` (aggregates D1 events) | **no BI route**; `BusinessEventRepository.aggregate*` and `TwinComputationService` | SPA, Twin | Stack B `business_intelligence.*` | KPI aggregation lives in repository + Twin service, not BI | — | none | wire BI→Twin leg | SOT-12 |
| C7 | Modeled current state (Twin) | **BDT** / INTELLIGENCE | `business/twin` → KV cache | `/v1/…/twin` → `business_digital_twin.*` via DT lifecycle | SPA, SIM | Stack B | KV twin cache (P3, unused) | `dt:read/write` | Twin computed from BO ledger directly (acceptable per Manifest 8.3 only if BI evidence leg is added) | none | SOT-12 |
| C8 | Scenario outcomes | **SIM** / INTELLIGENCE | `/api/simulate` (stateless LLM) | `/v1/…/simulations` → `simulation.*` | SPA | Stack B | **Supabase `simulations` (P2) + localStorage `infinicus_history`/`scenarios` (P6)** written by the SPA independently | `sim:*` | none (writes are user-initiated, not mutation of ops state) | Backfill/stop dual-write | **SOT-03** |
| C9 | Recommended options | **ADI** / INTELLIGENCE | `decisions/recommend` → D1 `decision_memory` | `/v1/…/decision-recommendations` → `ai_decision_intelligence.*` | SPA | Stack B | D1 `decision_memory` (recommend+choice+outcome in one row) | `adi:*` | none | legacy history | SOT-06 |
| C10 | Authorized action | **ABA** / CONTROL LOOP | `record-choice` → `decision_memory.chosen` (boolean flag) | `…/choice` → ADI publication → ABA intake → review → `ApprovalDecision` → `ApprovedAction` | SPA, OM | Stack B | D1 flag vs ABA chain | `aba:write` **only** | **Lead L-1:** approval is created from a single user click under `aba:write`; no authority/threshold check (ABA-05/06 concepts) found in `BusinessDecisionRecommendationService` | none | L-1 (Phase 6) |
| C11 | Verified outcome | **OM** / CONTROL LOOP | `record-outcome` → `decision_memory.outcome` | `…/outcome`, `/outcomes` → ABA publication → OM intake → `OutcomeObservation` | SPA, CL | Stack B | D1 | `om:write` | none | legacy history | SOT-06 |
| C12 | Learning / calibration | **CL** / CONTROL LOOP | — | **no CL route**; `continuous_learning.*` schema unused by API | — | Stack B `continuous_learning.*` | **Browser CL state:** `INFINICUS.CL.runtime.registerLearningState` + `localStorage inf_cl_history_v1` (last 50 outcomes) | n/a | none (nothing activates models) | Server-side CL ingestion | **SOT-04** |

### 2.2 Cross-cutting capabilities

| # | Capability | Domain | Current writer → store | Canonical candidate | Duplicate state | Authorization boundary | Migration need |
|---|---|---|---|---|---|---|---|
| C13 | Subscription / plan / entitlement | BUSINESS ADMIN (A3) | Supabase `profiles.plan`, `sim_count`; Stack B `billing.*` + `requireActiveSubscription` | Stack B `billing` for subscription; **business financial truth stays FINANCE/BO** | Two entitlement sources; usage counter in Supabase RPC (SOT-05) | `platform:admin` for billing routes | Decide entitlement owner |
| C14 | Idempotency | cross-cutting (A3: DATA contract, enforced at each mutation boundary) | `api` schema + `idempotency` plugin on API writes | Stack B | none; **not applied** to event consumers or ABA execution paths yet (not evidenced) | `requireIdempotencyKey` on 40+ write routes | Phase 4/5 |
| C15 | Audit trail / event outbox | DATA / BUSINESS ADMIN | `audit`, `events` schemas | Stack B | none | — | none |
| C16 | Waitlist, feedback, nurture, email | EXPERIENCE | KV `INFINICUS_WAITLIST`, Resend | Stack A (no Stack B equivalent) | none | rate-limit, `NURTURE_BATCH_SECRET` | Only if Stack A is retired; **authoritative Stack A-only behavior** |
| C17 | Image → idea parsing | EXPERIENCE | Workers AI in `parse-idea` | Stack A (no Stack B equivalent) | none | rate-limit | Same as C16 |

**Authoritative data or behavior existing only in Stack A** (A1 requirement): D1 history (C2, C3, C9–C11 legacy rows, volume unknown); KV legacy users (P3); KV waitlist and feedback (C16); `parse-idea`, `send-email`, `nurture-batch`, `feedback` behavior (C16–C17); `/api/simulate` LLM analysis path (still called by `index.html:5136`); rate-limit helper. None may be removed until migrated or explicitly archived.

---

## 3. Findings

| ID | Severity | Finding | Evidence | Layer / Domain | Affects |
|---|---|---|---|---|---|
| **SOT-01** | **HIGH** (authorisation flow; becomes CRITICAL if `supaId` values are ever discoverable by third parties) | Stack B accounts for end users are *shadow accounts* whose email **and password** are SHA-256 of fixed labels plus the user's Supabase UUID, computed in the browser. The "password" is therefore not a secret: anyone who learns a user's Supabase `id` can reproduce it from public code and obtain a Stack B session and tenant access. Identity is also split across Supabase, KV and Stack B. | `index.html:3492–3530` (`deriveShadowAccountCredentials`), `3586–3617` (login/register fallback) | — / BUSINESS ADMIN | C1, every tenant route |
| **SOT-02** | **HIGH** (authorisation flow) | Legacy `/api/business/*`, `/api/auth/*` Pages Functions remain **deployed** (`_routes.json` includes `/api/*`) and trust a client-supplied `user_email` / `business_id` with no server-verified identity. The SPA no longer calls the `business/*` ones, so they provide no function but remain reachable. | `functions/api/business/*.js`; `docs/production-readiness/migrate-bizops-twin-decisions-backend.md` ("zero server-verified identity"); grep: no HTML caller | — / BUSINESS ADMIN | C2, C3, C9–C11 legacy data |
| **SOT-03** | **HIGH** | Scenario outcomes (SIM truth) are written to **three** stores by the SPA with no reconciliation: Supabase `simulations`, `localStorage`, and (via `/v1/…/simulations`) Stack B `simulation.*`. Supabase rows are summaries only (verdict, rev, profit, cash, surv…). | `index.html:872–885, 3648–3680, 6547` | SIM / INTELLIGENCE | C8 |
| **SOT-04** | **HIGH** | Continuous Learning evidence is held **only in the browser** (`inf_cl_history_v1`, `registerLearningState` with `confidence: null`). The server-side `continuous_learning` schema has no ingestion route; OM→CL handoff is not exposed. Learning evidence is therefore unversioned, unshared and lost on cache clear. No model or rule is modified by it (no CL-02 violation found). | `index.html:7975–8015` | CL / CONTROL LOOP | C12 |
| SOT-05 | MEDIUM | Entitlement and usage metering are split: Supabase `profiles.plan` / `sim_count` (client-read) vs Stack B `billing.*` and `requireActiveSubscription`. | `index.html:838–850`, `apps/api/src/plugins/billing.ts` | — / BUSINESS ADMIN | C13 |
| SOT-06 | MEDIUM | Legacy D1 data (`businesses`, `business_events`, `decision_memory`) exists only in Stack A. The migration doc chose a "clean cutover, no D1 import". Volume of production rows is **unknown** (not inspectable from this repo). | `migrate-bizops-twin-decisions-backend.md`, `schema.sql` | BO/ADI/ABA/OM | C2, C3, C9–C11 |
| SOT-07 | MEDIUM | BO operational truth is split across `platform.*` (suppliers, inventory_items, warehouses, assets, employees, orders…) and `business_operations.*`. The `platform` schema has no declared single owner. | `OperationalCommandExecutor.ts:36–42`, migrations | BO / OPERATIONS+COMMERCE | C3, C4 |
| SOT-08 | MEDIUM | Three BO tables have **two writer code paths**: `OperationalCommandExecutor` (`business-operations-runtime`) and `packages/database` repositories — `business_events`, `inventory_balances`, `purchase_orders`. Both are within BO, so no layer boundary is crossed, but invariants (e.g. inventory locking) can diverge. | scan of `apps`/`packages` source | BO / OPERATIONS | C3, C4 |
| SOT-09 | MEDIUM | `business-operations-runtime` inserts/updates `data_acquisition.publication_deliveries`, a table in DAL's schema. Plausibly a delivery acknowledgement, but it is a cross-layer write rather than a contract call. | `BusinessIntakeService.ts:234, 246, 345, 355, 437` | DAL↔BO / DATA | C5 |
| SOT-10 | LOW | `platform.decisions`, `approved_actions`, `outcomes`, `simulations`, `learning_items`, `metrics`, `operational_events` exist as foundation tables with **no code writers or readers** found, duplicating the schema surface of ADI/ABA/OM/SIM/CL. Dormant, but a future module could write them as a second source of truth. | grep of `apps`/`packages`; `docs/database-schema-map.md:38–40` | cross-layer | C9–C12 |
| SOT-11 | LOW | KV waitlist/feedback/nurture and `parse-idea` are Stack A-only. Non-lifecycle (EXPERIENCE) but must be kept or ported before any Stack A retirement. | `functions/api/*` | EXPERIENCE | C16, C17 |
| SOT-12 | MEDIUM | The Twin is computed straight from the BO event ledger; KPI aggregation exists in `BusinessEventRepository.aggregate*` and is consumed by `TwinComputationService`. There is **no BI route/evidence leg** into the Twin (Manifest §8.3 requires `CurrentOperationalState` + `AnalyticalEvidence`). Candidate duplicate analytical logic (Phase 6 §11.8). | `packages/workflow/src/TwinComputationService.ts:45–60`, `apps/api` routes | BDT/BI | C6, C7 |

**No finding meets the spec's CRITICAL bar on current evidence.** SOT-03 is the closest (duplicate writers of SIM truth); it stays HIGH because the extra copies are user-history summaries, not consumed as decision evidence anywhere found.

---

## 4. Investigation leads (ABA-19/20, CL-22) — read-only result

Per your authorisation these are leads only; nothing was modified.

| Lead | Finding | Result |
|---|---|---|
| **ABA-19** `Controlled-Action-Execution-Engine` | `execute()` requires a controlled-execution handoff with dry-run results and invokes an executor registered via `registerExecutor(adapterCode, fn)`. | **No `registerExecutor` call exists anywhere in the repository**, so ABA-19 cannot cause any external change today. No direct-mutation shortcut present; the future risk depends on what executors get registered. |
| **ABA-20** `Failure-Compensation-Rollback` | Coordinates rollback steps through its own store; consumes ABA-19 results. | No operational mutation found; **only the name and store usage were reviewed**, not every code path (Phase 6). |
| **CL-22** `Model-Rule-Policy-Deployment` | Template engine (same structure as other CL blocks) taking an `upstreamHandoff` with confidence/reliability and emitting a record/event. | No code that activates a model, rule or policy was found. **Not exhaustively read.** |
| **BO-23 / BO-24** (your A2 stop condition) | Take an `upstreamHandoff`, build a governed publication record with correlation/lineage and emit `bo.operational_events.publish` / `bo.operations_data.publish`; own only policy + publication records, **no transaction/inventory/payment tables**. | **They are contract/publication infrastructure, not operational truth.** DATA classification is permitted; the stop condition is **not** triggered. |
| **Related to ABA-19: Stack B decision "choice"** | Choosing a recommendation creates the `ApprovalDecision` and `ApprovedAction` automatically under `aba:write`. | Lead **L-1** for Phase 6: confirm that authority and approval thresholds (ABA-05/06) are enforced, or that a single user's click is the intended authority. |

Note on BO-21: classification left for Phase 9, as authorised.

---

## 5. Domain vs layer check (authorisation rule)

Every row in §2 keeps **layer ownership** from Manifest §4 independent of the domain tag. Domain tags used here are classification only; no capability's truth, contract or authorisation boundary was reassigned. BO remains the operational-truth layer even though its blocks are classified across COMMERCE/OPERATIONS/FINANCE (A2). Platform subscription billing is BUSINESS ADMIN; **business** receivables and financial records remain FINANCE/BO lifecycle truth (A3).

---

## 6. Migration requirements (not authorised; for Phase 10 planning)

| ID | Item | Type | Non-destructive first step |
|---|---|---|---|
| M-1 | Identity: choose the identity provider and replace derived shadow credentials | Decision + code | Inventory how many shadow accounts exist (needs production DB access you control) |
| M-2 | Legacy D1 data: export, then decide import vs archive | Data | Read-only export of D1 tables to a dated artifact |
| M-3 | Retire or gate legacy `/api/business/*` and KV auth | Config | Routing exclusion in `_routes.json` — reversible, but **requires your approval** |
| M-4 | SIM history: stop dual-write to Supabase/localStorage or mirror server-side | Code + data | Document which UI reads each store |
| M-5 | CL: server-side ingestion of OM→CL evidence; keep browser history as cache only | Code | Contract first (Phase 4) |
| M-6 | Entitlement owner (Supabase `profiles` vs Stack B `billing`) | Decision | none |
| M-7 | Single owner for `platform.*` tables | Decision/doc | none |
| M-8 | Port or keep Stack A-only behaviors (waitlist, feedback, parse-idea) | Decision | none |

No migration is performed or proposed for immediate execution. Stack A is **not** retired by anything in this document.

---

## 7. Stop-condition and escalation report

Per D2: stop and report before implementation on CRITICAL conflicts. None is CRITICAL by the stated scale, but two HIGH findings touch **authorization flow** and need your severity ruling before they are carried into the plan:

| Item | Why it needs your decision |
|---|---|
| SOT-01 | Whether `supaId` values are exposed anywhere (public share links, API responses, logs) decides HIGH vs CRITICAL. I cannot determine that from the repository. |
| SOT-02 | Disabling legacy endpoints is the lowest-risk fix but is a deployment change on the live site's hosting; needs explicit approval. |

Nothing has been changed for either. No locked specification was altered and none needs amendment on current evidence.

---

## 8. Completion status

| Required by authorisation | Status |
|---|---|
| current writer / reader / persistence system | Done (§1, §2) |
| canonical candidate, duplicate state | Done (§2) |
| Stack A / Stack B ownership | Done (§2; Stack A-only list in §2) |
| lifecycle-layer owner, platform-domain classification | Done (§2, §5) |
| authorization boundary | Done (§2); SOT-01/02 flagged |
| direct-mutation shortcuts | None confirmed; leads in §4 |
| migration requirement | Done (§6) |
| unresolved conflicts | SOT-01…SOT-12, §3 |

**Limits:** no live database or production D1/KV was inspected; row counts unknown. Per-table writer/reader/RLS for all ≈478 tables was **not** produced — only tables with code writers were analysed (370 found by scan); a full per-table matrix is deferred to the plan phase if you want it. Block internals (≈200 browser blocks) were not read except the leads above.

**Next phase:** Phase 4 — Contract Audit (D4 `CONTRACT_INVENTORY.md`).
