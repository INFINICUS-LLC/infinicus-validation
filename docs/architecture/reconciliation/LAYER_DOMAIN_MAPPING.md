# LAYER_DOMAIN_MAPPING — BUILD-ARCH-RECON-01, Phase 2 (D2)

**Status:** MAP COMPLETE — proposals only. Nothing moved or renamed. Every ownership choice below is **PROPOSED** and needs approval before it drives a migration.
**Inputs:** `ARCHITECTURE_INVENTORY.md` (D1), Master Manifest §§4–7, Locked specs by name.
**Rule applied (spec §7.1):** each significant component gets **one** primary domain; genuinely cross-domain components get one authoritative owner plus contracts. Domain ≠ layer (Manifest §6), so domains and layers are mapped separately.
**Stack naming:** **A** = static site + Cloudflare Functions (repo root); **B** = `infinicus-platform/` monorepo (Postgres).
**Limits:** mapping is by block name, entry points and SQL touched; block internals were not read. Confidence H/M/L as in D1.


> **ERRATA (added in Phase 3):** T-10 and §1 describe Stack A and Stack B as parallel implementations of the whole flow. In fact the live SPA already uses Stack B for onboarding, simulations, operations, twin and decisions, and still uses Stack A for `simulate`, waitlist, feedback, email, `parse-idea`, and legacy KV `change-password`; authentication and simulation history also run through **Supabase**, which this document did not list. See `SOURCE_OF_TRUTH_AUDIT.md` §0–§1. Authorised classification rules (A1–A3, 2026-10-07): Stack B is the target for all 9 layers; BO block→domain split is classification only; BO-23/24 verified as contract infrastructure; BO-21 deferred to Phase 9; idempotency is a cross-cutting invariant owned with DATA contracts.

---

## 1. Key structural facts that shape the mapping

| # | Fact | Evidence |
|---|---|---|
| F-1 | Stack B's `layers/*` packages (`@infinicus/layer-*`) are **not imported by any app or package**. The API runs on `packages/*-runtime`, `packages/workflow`, `packages/simulation-engine` and `packages/database` repositories instead. | grep for `@infinicus/layer-`: 0 consumers |
| F-2 | **147 of 174** browser blocks at repo root are byte-identical to the matching block in `infinicus-platform/layers/*/blocks/`. The differences: DT-01 (2 files), ADI-01…25 (file naming and `docs/API.md`), and DA-25 (one extra test at root). | block-by-block `diff -r` |
| F-3 | The **platform copy of DT-01 still contains the syntax defect** repaired in Fix 1 (`manifest.js:33`, plus the registry clone bug). Fix 1 only touched the root copy. | `node --check` on `layers/business-digital-twin/blocks/INFINICUS-DT-01…/src/core/manifest.js` fails |
| F-4 | Business Operations has 25 blocks in B only (`layers/business-operations`) and **no root browser bundle**; it appears in Stack A only as `bol.html` and `functions/api/business/*`. Simulation's real engine is `packages/simulation-engine`; `layers/simulation` is a thin adapter (`sim-to-adi-mapper`, `engine-v3-browser-adapter`). | D1 §2 |

F-3 is a defect to schedule (see §7), not something to fix inside this MAP phase.

---

## 2. Domain mapping (spec §7.1)

### 2.1 Domain → current components

Primary owner is **bold**; supporting components in plain text.

| Domain | Primary components today | Supporting / gaps |
|---|---|---|
| **EXPERIENCE** | Stack A: `index.html`, `landing.html`, `account.html`, `theme.js`, `i18n.js`+`i18n/`, `platform/platform-bootstrap.js`, `dal.html`, `bol.html`. Stack B: `apps/web`, `packages/onboarding` (UI flow side), BI-22 dashboards/reporting, `packages/workflow` (decision-workflow *view*) | Guided/Professional mode code not located yet (Phase 8). Layer Guide / Next Best Action UI not located (Phase 7–8). |
| **BUSINESS ADMINISTRATION** | Stack B: `packages/authentication`, `authorization`, `billing`, `apps/admin` (stub), schemas `tenancy`, `identity`, `billing`, `audit`; BO-02 business profile, BO-03 organization; ABA-05/06 authority + approval policy (supporting). Stack A: `functions/api/auth/*` (KV users), `business/manage`, `_shared/rateLimit.js` | Tax config, currency, business hours, industry profile: only as BO-02 fields (not verified). Two identity stores (A, B). |
| **COMMERCE** | BO-04 catalog, BO-05 customers, BO-06 pipeline, BO-07 quotation/pricing, BO-08 orders, BO-09 payments/billing (shared with FINANCE). Stack B routes `products`, `orders`, `register-sessions`. Stack A `business/events` sale/customer events | **No module named Commerce**; POS, loyalty, promotions, discounts, refunds not found as distinct modules. |
| **OPERATIONS** | BO-10 procurement, BO-11 suppliers, BO-12 inventory, BO-13 warehouse, BO-14 fulfilment, BO-15 workforce, BO-16 tasks/workflow, BO-17 scheduling/capacity, BO-18 assets/maintenance, BO-20 service quality. Stack B `/operations/{inventory,procurement,suppliers,workforce,assets}`, `packages/workflow`(execution side), `business-operations-runtime` | Production not found as a block. |
| **FINANCE** | BO-09 receivables (shared), BO-19 expense/operational finance, DT-07 financial-state twin (modeled, not ledger), BI-11 financial intelligence (analytical, not ledger) | **No financial ledger, cash, payroll, budget module found.** Cash/margin are derived in BI/DT only. |
| **DATA** | Stack B: `layers/data-acquisition` (DA-01…25), `packages/data-acquisition-runtime`, `packages/database`, `handoff-contracts`, `event-contracts`, `shared-types`, schemas `data_acquisition`, `files`, `events`, `platform`(?). Stack A: `data-acquisition/` browser blocks (identical copies), `dal.html`, `schema.sql` (D1) | Dataset versions/snapshots and data contracts live in `platform`/`data_acquisition` (not verified). `platform` schema ownership unclear (29 tables). |
| **INTELLIGENCE** | BI: `layers/business-intelligence` BI-01…25 + root copy; DT: DT-01…24; SIM: `packages/simulation-engine`, `layers/simulation`; ADI: ADI-01…25, `packages/llm-client`, `BusinessDecisionRecommendationService`; schemas `business_intelligence`, `business_digital_twin`, `simulation`, `ai_decision_intelligence`. Stack A: `business/summary`, `business/twin`, `simulate`, `business/decisions/recommend` | Forecasting and risk are blocks inside BI/DT/SIM, not separate modules. Calibration is in CL (CONTROL LOOP) per manifest. |
| **CONTROL LOOP** | ABA-01…25, OM-01…25, CL-01…25 (+ root copies); schemas `approved_business_action`, `outcome_monitoring`, `continuous_learning`. Stack A: `business/decisions/{record-choice,record-outcome}` over `decision_memory` | Execution-related ABA blocks sit here but manifest assigns execution to BO (see §5). |

### 2.2 Business Operations layer split across domains (resolves D1 O-5)

Manifest §7 gives BO three primary domains (COMMERCE, OPERATIONS, FINANCE). One folder (`layers/business-operations`, 25 blocks) holds all three. **Proposed domain per block, without moving any file:**

| Blocks | Capability | Proposed domain | Conf. |
|---|---|---|---|
| BO-01 | Core runtime/registry | OPERATIONS (platform plumbing) | M |
| BO-02, BO-03 | Business profile, organization | BUSINESS ADMINISTRATION | H |
| BO-04, BO-05, BO-06, BO-07, BO-08 | Catalog, customers, pipeline, pricing, orders | COMMERCE | H |
| BO-09 | Payments, billing, receivables | COMMERCE (payments) with FINANCE as consumer of receivable balances | M |
| BO-10, BO-11, BO-12, BO-13, BO-14 | Procurement, suppliers, inventory, warehouse, fulfilment | OPERATIONS | H |
| BO-15, BO-16, BO-17, BO-18 | Workforce, tasks, scheduling, assets | OPERATIONS | H |
| BO-19 | Expenses, operational finance | FINANCE | H |
| BO-20 | Service quality, customer support | OPERATIONS (supporting COMMERCE) | M |
| BO-21 | Compliance, operational risk | BUSINESS ADMINISTRATION (policy) with OPERATIONS enforcement | L |
| BO-22 | Incidents, exceptions, escalation | OPERATIONS | M |
| BO-23, BO-24 | Operational event publication, data publication handoff | DATA (event/contract infrastructure) — contract owned by BO | M |
| BO-25 | Master integration / assembly | OPERATIONS | M |

### 2.3 Other layer-block groupings

| Layer | Blocks | Capability | Proposed domain |
|---|---|---|---|
| DAL | DA-01…05 | Runtime, source registry, connectors, credentials, scheduling | DATA |
| DAL | DA-06…11 | Webhook, file, API, DB, manual, streaming intake | DATA |
| DAL | DA-12…22 | Schema detection → validation, cleaning, normalization, entity resolution, dedupe, classification, sensitive data, quality, missing data, source reliability | DATA |
| DAL | DA-23, DA-24, DA-25 | Lineage/provenance, publication handoff, assembly | DATA |
| BI | BI-01…10 | Runtime, source mapping, ingestion, validation, cleaning, entity resolution, transformation, warehouse, KPI registry, calculation | INTELLIGENCE (note overlap with DA-13/14/16, see §5) |
| BI | BI-11…18 | Financial, sales, customer, marketing, operations, inventory, workforce, market intelligence | INTELLIGENCE |
| BI | BI-19…21 | Trend/variance, anomalies, root cause | INTELLIGENCE |
| BI | BI-22, BI-23 | Dashboards/reporting, alert & report distribution | EXPERIENCE (presentation) with INTELLIGENCE as data owner |
| BI | BI-24, BI-25 | Twin publication handoff, assembly | INTELLIGENCE |
| BDT | DT-01…04 | Runtime, identity/instances, schema/ontology, intake | INTELLIGENCE |
| BDT | DT-05…15 | Entity graph, org/financial/customer/sales/marketing/operations/inventory/workforce/asset/market twins | INTELLIGENCE |
| BDT | DT-16…22 | Synchronization, transitions, constraints, risk, opportunity, integrity, history/snapshots | INTELLIGENCE |
| BDT | DT-23, DT-24 | Scenario baseline, simulation package handoff | INTELLIGENCE |
| SIM | `simulation-engine`, `layers/simulation` | Monte Carlo, verdict, scores, adapters | INTELLIGENCE |
| ADI | ADI-01…12 | Runtime, intake, access, context, Twin/SIM adapters, evidence, goals, triggers, problem, objectives | INTELLIGENCE |
| ADI | ADI-13…23 | Alternatives, feasibility, impact, simulation orchestration, risk, scoring, uncertainty, explanation, recommendation, red-team, gate | INTELLIGENCE |
| ADI | ADI-24, ADI-25 | ABA handoff, assembly | INTELLIGENCE |
| ABA | ABA-01…12 | Runtime, intake, action ontology, lifecycle, authority, policy, approval workflow, signatures, contract, scope, revalidation, collisions | CONTROL LOOP |
| ABA | ABA-13…18 | Decomposition, assignment, resources, scheduling, adapters, dry run | CONTROL LOOP (execution planning) — see §5 |
| ABA | ABA-19, ABA-20, ABA-21, ABA-22 | Controlled execution, failure/rollback, execution evidence, completion verification | CONTROL LOOP **with ownership tension** (§5) |
| ABA | ABA-23, ABA-24, ABA-25 | Monitoring contract, OM handoff, assembly | CONTROL LOOP |
| OM | OM-01…25 | Contract intake → observation → variance → attribution → verdict → learning package → CL handoff | CONTROL LOOP |
| CL | CL-01…21 | Intake → classification → validation → rule/policy/risk/forecast/SIM/Twin calibration → governance → knowledge update | CONTROL LOOP |
| CL | CL-22, CL-23, CL-24, CL-25 | Deployment, impact verification, publication, assembly | CONTROL LOOP **with tension** (§5) |

---

## 3. Layer mapping (spec §7.2)

### 3.1 Authoritative layer per source of truth, and what implements it today

| Layer | Truth (Manifest §4) | Stack B implementation | Stack A implementation | API surface (B) |
|---|---|---|---|---|
| DAL | Prepared, validated, standardized data | `layers/data-acquisition`, `data-acquisition-runtime`, schema `data_acquisition` | `data-acquisition/` bundle, `dal.html` | `/data-sources/*` (≈20) |
| BO | Operational truth | `layers/business-operations`, `business-operations-runtime`, schema `business_operations` | `bol.html`; D1 `business_events` (events only) | `/operations/*`, `/products`, `/orders`, `/register-sessions`, `/events` |
| BI | Analytical evidence | `layers/business-intelligence`, schema `business_intelligence` | `business-intelligence/` bundle; `business/summary` | **none** |
| BDT | Modeled current state | `layers/business-digital-twin`, schema `business_digital_twin` | `digital-twin/` bundle; `business/twin` (KV cache) | `/twin`, `/twin/refresh` |
| SIM | Scenario outcomes | `packages/simulation-engine`, `layers/simulation`, schema `simulation` | `functions/api/simulate.js` (LLM-based) | `/simulations` |
| ADI | Recommended options | `layers/ai-decision-intelligence`, `packages/workflow` + `llm-client`, schema `ai_decision_intelligence` | `ai-decision-intelligence/` bundle; `decisions/recommend` | `/decision-recommendations` |
| ABA | Authorized action | `layers/approved-business-action`, schema `approved_business_action` | `approved-business-action/` bundle; `decisions/record-choice` | `/decisions`, `…/choice` |
| OM | Verified outcome evidence | `layers/outcome-monitoring`, schema `outcome_monitoring` | `outcome-monitoring/` bundle; `decisions/record-outcome` | `/outcomes`, `…/outcome` |
| CL | Versioned learning evidence | `layers/continuous-learning`, schema `continuous_learning` | `continuous-learning/` bundle | **none** |

A **one-layer-per-truth** reading holds at the *schema* level in Stack B (each layer has its own schema). It does **not** hold in Stack A: `decision_memory` mixes ADI, ABA and OM truth (D1 O-7), and `business/twin` derives Twin state directly from `business_events`. Both go to the Phase 3 audit.

### 3.2 Layer × domain: implemented vs Manifest §7 matrix

P = primary, S = supporting (Manifest). "Impl." = what the code does today (by block-group above).

| Layer | Manifest primary | Implemented primary | Gap |
|---|---|---|---|
| DAL | DATA | DATA | none |
| BO | COMMERCE, OPERATIONS, FINANCE | COMMERCE, OPERATIONS; FINANCE only BO-19 | FINANCE thin (§2.1) |
| BI | INTELLIGENCE | INTELLIGENCE; BI-22/23 presentation in EXPERIENCE | none at primary level |
| BDT | INTELLIGENCE | INTELLIGENCE | none |
| SIM | INTELLIGENCE | INTELLIGENCE | none |
| ADI | INTELLIGENCE | INTELLIGENCE | none |
| ABA | CONTROL LOOP | CONTROL LOOP, plus execution blocks that the manifest assigns to BO | **tension** §5 |
| OM | CONTROL LOOP | CONTROL LOOP | none |
| CL | CONTROL LOOP | CONTROL LOOP, plus deployment block | **tension** §5 |

### 3.3 Cross-cutting capabilities (one authoritative owner each, proposed)

| Capability | Serves layers | Proposed owner domain | Rationale |
|---|---|---|---|
| Authentication, sessions, RBAC | all | BUSINESS ADMINISTRATION | Manifest: users, roles, permissions, approval authority |
| Tenant context + RLS | all | BUSINESS ADMINISTRATION (policy) enforced by DATA infrastructure | `tenancy` schema + RLS policies |
| Event outbox / `events` schema | all | DATA (event infrastructure) | Manifest §5 DATA owns "event infrastructure" |
| Handoff and event contracts | all | DATA | contract definitions, versioned |
| Audit (`audit` schema) | all | BUSINESS ADMINISTRATION | cross-cutting governance |
| Idempotency (`api` schema) | API | EXPERIENCE gateway | request-level concern |
| Billing/subscription | platform | BUSINESS ADMINISTRATION | not in manifest; closest fit |
| Observability, incidents | platform | platform operations (**UNCLASSIFIED** in the 8 domains) | not a business domain; needs an explicit decision |
| Onboarding / cold-start entry | DAL, BDT, SIM | EXPERIENCE (flow) + BUSINESS ADMINISTRATION (profile) | Standard §8 entry path |
| LLM client | ADI | INTELLIGENCE | |

---

## 4. Duplicated implementation (mapping consequence of F-2)

The browser blocks exist **twice** with identical content for DAL, BI, DT (except DT-01), ABA, OM, CL, and with naming differences for ADI. Both copies map to the same domain/layer, so this is a **duplicate-implementation** issue, not an ownership conflict. Classification candidates for Phase 9: `KEEP` one canonical copy and `WRAP`/generate the other, or `DEPRECATE` one. No decision is made here.

---

## 5. Mapping tensions (ambiguous or conflicting ownership)

Each needs an explicit decision. None is judged a violation yet; Phase 6 will test them against the no-direct-mutation rules (Manifest §11).

| ID | Tension | Why it matters | Proposed handling (pending approval) |
|---|---|---|---|
| T-1 | **ABA-17…20** (execution adapters, dry run, *controlled action execution*, failure compensation/rollback) vs Manifest §8.7: "Business Operations remains responsible for execution" | Possible ABA-side execution; OM is also barred from rollback (Manifest §11) | Map execution as CONTROL LOOP *orchestration* only; confirm in Phase 6 whether ABA calls BO through the `AuthorizedActionPackage` contract or mutates directly |
| T-2 | **ABA-22** completion verification vs OM "verified outcome evidence" | Two layers could both claim to verify results | Keep ABA-22 as *execution* completion; OM owns *outcome* verification — confirm in Phase 3 |
| T-3 | **CL-22** "Model/Rule/Policy deployment" vs Manifest §8.10 "governed activation creates a new version" | Silent-deployment risk | Map as CONTROL LOOP *governed activation*; audit approval gate in Phase 6 §11.6 |
| T-4 | **BI-02…08** (mapping, ingestion, validation, cleaning, entity resolution, transformation, warehouse) overlap **DA-12…22** | Duplicate calculation/cleaning logic across DATA and INTELLIGENCE | Phase 6 §11.8 duplicate-logic check; no mapping change yet |
| T-5 | **ADI-16** simulation orchestration vs SIM ownership of scenario outcomes | ADI could be generating scenario results | Map as ADI *requesting* runs; verify SIM remains writer of outcomes |
| T-6 | **ADI-05 / ADI-06** adapters (Twin context, SIM results) | Fine if read-only via contracts; a problem if ADI reads private Twin/SIM tables | Phase 6 §11.7 |
| T-7 | **BO-23/24 and DA-24, BI-24, DT-24, ADI-24, ABA-24, OM-24, CL-24** publication blocks | Publication is each layer's *output contract* but contracts live in DATA (`handoff-contracts`) | Layer owns payload content; DATA owns contract definition |
| T-8 | **`platform` schema** (29 tables) and **`events` schema** | Cross-layer registries with unclear single owner | Phase 3 to list tables and assign a single owner |
| T-9 | **Billing, observability, incidents** not covered by the 8 domains | "Every component must have one domain owner" | Assign billing to ADMIN; decide whether platform operations needs a ninth category or maps to ADMIN |
| T-10 | **Stack A vs Stack B** both implement DAL→OM flows | Cannot name one authoritative implementation per layer | **Architecture decision required** (carried from D1 O-1): authoritative stack per layer |

---

## 6. Component ownership summary (for D3 input)

| Component | Primary domain | Layer(s) | Confidence |
|---|---|---|---|
| `packages/data-acquisition-runtime` | DATA | DAL | H |
| `packages/business-operations-runtime` | OPERATIONS (intake) / COMMERCE (orders) | BO | M — split by sub-service not yet done |
| `packages/simulation-engine` | INTELLIGENCE | SIM | H |
| `packages/workflow` | CONTROL LOOP (workflow view) / INTELLIGENCE (recommendation service) | ADI, ABA, OM, SIM | **L — mixes two domains in one package** |
| `packages/database` | DATA | all | H as location; **ownership boundary L** (D1 O-3) |
| `packages/handoff-contracts`, `event-contracts`, `shared-types` | DATA | all | H |
| `packages/authentication`, `authorization`, `billing` | BUSINESS ADMINISTRATION | — | H |
| `packages/onboarding` | EXPERIENCE / BUSINESS ADMINISTRATION | DAL, BDT, SIM (cold start) | M |
| `apps/api` | EXPERIENCE gateway | all (routes) | H |
| `apps/web` | EXPERIENCE | all | H |
| `layers/*` (8 packages) | per §2.3 | per layer | H, but **unreferenced** (F-1) |
| Stack A `functions/api/*` | per D1 §3.1 | BO, BI, BDT, SIM, ADI, ABA, OM | H |
| Stack A browser bundles | per §2.3 | DAL, BI, BDT, ADI, ABA, OM, CL | H |

---

## 7. Findings handed forward

| Item | Type | Goes to | Suggested next action |
|---|---|---|---|
| F-3: platform copy of DT-01 has the Fix 1 syntax and clone defects | **Defect** | Fix backlog (outside MAP) | Apply the same Fix 1 changes to `infinicus-platform/layers/business-digital-twin/blocks/INFINICUS-DT-01…`; add the bundle/syntax guard to cover platform blocks |
| F-1 / F-2: `layers/*` unused by apps; 147/174 duplicate blocks | Duplication | Phase 6 §11.8, Phase 9 | Classify copies as KEEP / DEPRECATE |
| T-1, T-3 | Possible direct-mutation shortcuts | Phase 6 §11.2/11.5/11.6 | Read ABA-19/20 and CL-22 sources |
| T-2, T-5, T-8 | Possible duplicate authoritative state | Phase 3 | Audit writers of the relevant tables |
| T-10 | **Architecture decision** | Needs user/approver | Name authoritative stack per layer, or approve parallel-run plan |
| BO sub-domain split (§2.2), cross-cutting owners (§3.3) | Ownership proposals | Approval | Confirm or amend before Phase 9 classification |

---

## 8. Completion status

| Spec item | Status |
|---|---|
| 7.1 Domain mapping — one primary owner per significant component | Done (§2, §6); 3 L-confidence items (BO-21, `workflow`, `database` boundary) |
| 7.2 Layer mapping — capability → layer(s), one authoritative layer per truth | Done (§3); Stack A violations of one-truth-per-layer deferred to Phase 3 |
| Cross-domain ownership choices | Proposed (§3.3, §5); **pending approval** |

**Next phase:** Phase 3 — Source-of-Truth Audit (D3 `SOURCE_OF_TRUTH_AUDIT.md`).
