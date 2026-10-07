# ARCHITECTURE_INVENTORY — BUILD-ARCH-RECON-01, Phase 1 (D1)

**Status:** INVENTORY COMPLETE — evidence only. No code moved, renamed, or refactored.
**Authority read first:** Master Architecture Manifest + Contract Matrix v1.0, Layer Guidance & Cold-Start Standard v1.0, Dual-Mode Experience Standard v1.0 (outline), BUILD-ARCH-RECON-01 §§1–6.
**Baseline:** branch `ccr-e53f2c76-7h2tzq` (after Fix 1–3), 189/189 root tests and 7/7 browser bundles passing.
**Method / limits:** file-tree walk, `grep` over source and SQL migrations, and reading of route files. Counts of tables, policies and functions come from `CREATE ...` statements in `infinicus-platform/infrastructure/database/migrations/0001–0170` and are **approximate** (later `ALTER`s and conditional DDL are not resolved). Not run: a live Postgres, the `infinicus-platform` pnpm test suite. Nothing here is a violation finding; items under "Observations" are leads for Phases 3–6.

---

## 0. Pre-build declaration (spec §5, filled from inventory)

```text
BUILD:                 BUILD-ARCH-RECON-01
PRIMARY PURPOSE:       Architecture reconciliation against locked manifest
PRIMARY DOMAIN:        Cross-domain
AFFECTED DOMAINS:      All 8 (inventory touches each; see §2)
AFFECTED LAYERS:       All 9 (DAL, BO, BI, BDT, SIM, AI-DI, ABA, OM, CL)
SOURCE-OF-TRUTH CHANGES: NONE (none proposed in Phase 1)
CONTRACT CHANGES:      TBD in Phase 4 (names differ from manifest §8; see §6)
DATABASE CHANGES:      NONE yet
MIGRATION REQUIRED:    TBD in Phase 10
ROLLBACK PLAN:         Required before any migration (not yet needed)
COLD-START / GUIDED / PROFESSIONAL IMPACT: TBD in Phases 7–8
ARCHITECTURE CONFLICT: NOT YET DETERMINED — candidate conflicts listed in §7
```

---

## 1. Top-level shape: two independent implementations

| Stack | Where | Runtime | Data store | Status |
|---|---|---|---|---|
| **A. Static site + Cloudflare Pages Functions** | repo root (`index.html`, `functions/`, `schema.sql`, `wrangler.toml`) | Browser + Cloudflare Workers | Cloudflare **D1** (`INFINICUS_DB`), **KV** (`INFINICUS_USERS`, `INFINICUS_WAITLIST`) | Live site; deployed via Cloudflare Pages |
| **B. `infinicus-platform/` monorepo** | `infinicus-platform/` (pnpm + turbo) | Node 22, Fastify API, Next.js web | **PostgreSQL**, 19 schemas, RLS | Built through BUILD-32; CI-tested; not wired to Stack A |

Stack A and B each hold their own businesses, events and decisions with **no shared data path** found. This is the single largest structural fact in the repo (see O-1).

---

## 2. Folder / module inventory (spec §6.1)

Confidence: **H** = path name + contents agree; **M** = inferred from name/entry points; **L** = ambiguous.

### 2.1 Stack A — repo root

| Path / Module | Current purpose | Proposed domain | Conf. | Notes |
|---|---|---|---|---|
| `index.html` (608 KB), `theme.js`, `i18n.js`, `i18n/` (19 locale files), `manifest.json`, `icon.svg`, `og-image.svg` | Main single-page app shell, theming, localization | EXPERIENCE | H | Loads the 7 browser layer bundles + `platform/platform-bootstrap.js` |
| `landing.html`, `legal.html`, `pitch deck.html`, `pitch deck_files/` | Marketing, legal, investor deck | EXPERIENCE | H | Static; not part of decision flow |
| `account.html` | Account/profile page | EXPERIENCE (+ ADMIN) | M | Calls `functions/api/auth/*` |
| `dal.html` (391 KB) | Data Acquisition Layer UI | EXPERIENCE → serves DAL | H | UI of layer 1 |
| `bol.html` (320 KB) | Business Operations Layer UI | EXPERIENCE → serves BO | H | UI of layer 2 |
| `data-acquisition/` (25 blocks, `da-bundle.js` 124 KB) | Browser DAL engines DA-01…DA-25 | DATA | H | Browser-global IIFEs, `INFINICUS.DA` |
| `digital-twin/` (24 blocks, `dt-bundle.js` 428 KB) | Browser Business Digital Twin engines DT-01…24 | INTELLIGENCE | H | `INFINICUS.DT`; repaired in Fix 1 |
| `business-intelligence/` (25 blocks, 377 KB) | Browser BI engines BI-01…25 | INTELLIGENCE | H | `INFINICUS.BI` |
| `ai-decision-intelligence/` (25 blocks, 271 KB) | Browser AI-DI engines ADI-01…25 | INTELLIGENCE | H | `INFINICUS.ADI` |
| `approved-business-action/` (25 blocks, 423 KB) | Browser ABA engines ABA-01…25 | CONTROL LOOP | H | `INFINICUS.ABA` |
| `outcome-monitoring/` (25 blocks, 365 KB) | Browser OM engines OM-01…25 | CONTROL LOOP | H | `INFINICUS.OM` |
| `continuous-learning/` (25 blocks, 216 KB) | Browser CL engines CL-01…25 | CONTROL LOOP | H | `INFINICUS.CL` |
| *(no root folder)* | Business Operations and Simulation browser engines | — | — | BO has only `bol.html`; Simulation has no root-level browser layer. See O-6 |
| `platform/` (`platform-bootstrap.js`, 9 tests) | Browser bootstrap: layer namespaces, handoff map, capability registry | EXPERIENCE (+ cross-layer) | M | Wires the 7 bundles together |
| `functions/api/` (see §3.1) | Cloudflare Pages Functions backend | mixed (see §3.1) | H | |
| `functions/_shared/rateLimit.js` | Rate limiting helper | BUSINESS ADMINISTRATION | M | Platform concern |
| `schema.sql`, `wrangler.toml`, `_routes.json`, `CNAME` | D1 schema, Cloudflare config, routing | DATA / infra | H | |
| `templates/` | Contains one file, `COMPATIBILITY-ADAPTER.ts` | UNCLASSIFIED | L | Purpose not yet inspected |
| `docs/` | Architecture, queue, completion reports, audits | — (documentation) | H | `docs/architecture/locked/` is authoritative |
| `.claude/`, `CLAUDE-*.md`, `INSTALL-INTO-REPOSITORY.md`, `QUEUE-INTEGRITY-SHA256.json` | Build-queue control files | — (governance) | H | |
| `scripts/` | `build-control/`, `check-bundles.mjs` | — (tooling) | H | |
| `*.zip` (2), `push.bat`, `set-sentry-dsn.bat` | Archives and Windows helper scripts | UNCLASSIFIED | H | Candidates for cleanup (Fix 3 follow-up) |
| `.github/workflows/` | `ci.yml` (platform only), `build-32.yml` | — (CI) | H | CI does **not** cover Stack A |

### 2.2 Stack B — `infinicus-platform/`

| Path / Module | Current purpose | Proposed domain | Conf. | Notes |
|---|---|---|---|---|
| `apps/api` (42 src files, 12 tests) | Fastify REST API `/v1/*` | EXPERIENCE gateway; routes belong to many domains (§3.2) | H | Plugins: auth, tenant context, permission, billing, idempotency, correlation id, rate limit |
| `apps/web` (8 src files) | Next.js app: businesses, workflow, history | EXPERIENCE | H | |
| `apps/admin` (1 file) | Stub | BUSINESS ADMINISTRATION | M | Placeholder only |
| `layers/data-acquisition` (25 blocks) | TypeScript DAL blocks | DATA | H | 403 files, 25 test files |
| `layers/business-operations` (25 blocks) | TS BO blocks | OPERATIONS + COMMERCE + FINANCE | M | Manifest §7 gives BO three primary domains; one folder holds all |
| `layers/business-intelligence` (25 blocks) | TS BI blocks | INTELLIGENCE | H | |
| `layers/business-digital-twin` (24 blocks) | TS BDT blocks | INTELLIGENCE | H | |
| `layers/simulation` (5 src files) | Simulation layer (thin) | INTELLIGENCE | H | Real engine is in `packages/simulation-engine` |
| `layers/ai-decision-intelligence` (25 blocks) | TS ADI blocks | INTELLIGENCE | H | |
| `layers/approved-business-action` (25 blocks) | TS ABA blocks | CONTROL LOOP | H | |
| `layers/outcome-monitoring` (25 blocks) | TS OM blocks | CONTROL LOOP | H | |
| `layers/continuous-learning` (25 blocks) | TS CL blocks | CONTROL LOOP | H | |
| `packages/database` (168 src files, 41 tests) | Migration runner + 17 repository groups covering all 19 schemas | DATA (but writes every domain's tables) | H | See O-3 |
| `packages/data-acquisition-runtime` | DAL runtime services | DATA | H | |
| `packages/business-operations-runtime` | BO runtime (intake, orders, inventory…) | OPERATIONS / COMMERCE | H | |
| `packages/simulation-engine` | Monte Carlo engine, verdict, scores | INTELLIGENCE | H | |
| `packages/handoff-contracts` (9 handoffs) | Typed layer-to-layer contracts | DATA (event/contract infra) | H | `dal-to-bo` … `cl-feedback` |
| `packages/event-contracts` | Canonical event type strings | DATA (event infrastructure) | H | |
| `packages/shared-types` | Shared types (`PlatformEvent`, `LayerId`) | cross-cutting | H | |
| `packages/authentication`, `authorization` | Identity, sessions, RBAC | BUSINESS ADMINISTRATION | H | |
| `packages/onboarding` | Business onboarding flow | EXPERIENCE + BUSINESS ADMINISTRATION | M | Cold-start entry point candidate |
| `packages/workflow` | Cross-layer decision workflow view | CONTROL LOOP / EXPERIENCE | M | Aggregates BI→OM for the UI |
| `packages/billing` | Subscriptions, trials | BUSINESS ADMINISTRATION | H | Not a manifest domain item; closest fit |
| `packages/observability`, `configuration`, `testing`, `llm-client` | Metrics/logging, config, test helpers, LLM wrapper | cross-cutting / platform | H | `llm-client` is used by `packages/workflow` |
| `infrastructure/{database,deployment,monitoring,backups}` | Migrations, deploy scripts, alerts, backups | — (infra) | H | |
| `docs/` (28 docs) | Per-stage DB docs, launch, incident, production readiness | — | H | |

**Domain coverage gap (observed):** nothing in either stack is clearly *owned* by COMMERCE (POS, catalog, pricing, loyalty, promotions, refunds, payments) or FINANCE (ledger, cash, payroll, budgets) as a named module. BO carries them implicitly (orders/products/register sessions). See O-5.

---

## 3. Route inventory (spec §6.2)

### 3.1 Stack A — Cloudflare Pages Functions (`functions/api/*`, 15 handlers)

| Route | Domain | Layer | Reads | Writes | Authorization | Concern |
|---|---|---|---|---|---|---|
| `/api/auth/{register,login,request,verify,change-password}` | ADMIN | — | KV `INFINICUS_USERS` | KV | Email/password; bearer session | Separate identity store from Stack B |
| `/api/business/manage` | ADMIN | BO | D1 `businesses` | D1 `businesses` | user_email | |
| `/api/business/events` | OPERATIONS/COMMERCE | BO | D1 `businesses` | D1 `business_events` | user_email | Event types limited to sale/expense/inventory/customer/team; no `schema_version`/`correlation_id` |
| `/api/business/summary` | INTELLIGENCE | BI | `business_events` | — | user_email | Aggregation lives in the handler |
| `/api/business/twin` | INTELLIGENCE | BDT | `business_events`, `businesses` | KV `INFINICUS_USERS` (TTL-cached snapshot) | user_email | Twin derived straight from events |
| `/api/business/decisions` (+ `/recommend`, `/history`, `/record-choice`, `/record-outcome`) | INTELLIGENCE + CONTROL LOOP | ADI, ABA, OM | `decision_memory`, twin | `decision_memory` | user_email | One table spans recommend → choose → outcome; AI call (Anthropic) |
| `/api/simulate` | INTELLIGENCE | SIM | — | — | rate limit | Venture-idea simulation via Anthropic; no Twin snapshot |
| `/api/parse-idea` | EXPERIENCE | DAL(?) | — | — | — | Image → idea via Workers AI |
| `/api/{waitlist,feedback,nurture,nurture-batch,send-email}` | EXPERIENCE | — | KV waitlist | KV | `NURTURE_BATCH_SECRET` for batch | Marketing; Resend email |

### 3.2 Stack B — Fastify API (`apps/api`, 14 route files, 75 endpoints)

Common guard chain on tenant routes: `authenticate → resolveTenantContext → requirePermission(<scope>) → requireActiveSubscription → requireIdempotencyKey` (writes).

| Route group | Domain | Layer | Permission | Notes |
|---|---|---|---|---|
| `/v1/auth/*` (5) | ADMIN | — | public / session | |
| `/v1/onboarding/*` (4) | EXPERIENCE + ADMIN | cold-start entry | session | `POST /onboarding`, `/:id/business`, `/:id/owner`, `GET /active` |
| `/v1/businesses` (GET, POST) | ADMIN | BO | `bo:write` | |
| `/v1/businesses/:id/workflow` | EXPERIENCE | cross-layer read | — | Aggregates BI, DT, SIM, ADI, ABA, OM |
| `/v1/businesses/:id/simulations` (POST, GET `/:runId`) | INTELLIGENCE | SIM | `sim:write` / `sim:read` | Runs "DAL → SIM → ADI" for a business idea (O-2) |
| `/v1/businesses/:id/decisions` (POST) | CONTROL LOOP | ABA | `aba:write` | |
| `/v1/businesses/:id/outcomes` (POST) | CONTROL LOOP | OM | `om:write` | |
| `/v1/businesses/:id/decision-recommendations` (+ `/:id/choice`, `/outcome`, `/history`) | INTELLIGENCE + CONTROL LOOP | ADI / ABA / OM | `adi:*`, `aba:write`, `om:write` | Ported counterpart of Stack A decisions |
| `/v1/businesses/:id/twin` (GET), `/twin/refresh` (POST) | INTELLIGENCE | BDT | `dt:read` / `dt:write` | |
| `/v1/businesses/:id/data-sources[/…]` (≈20: sources, connectors, health-check, manual-intake, collection-runs, validation-results, quality-score, provenance, publication-packages, publish) | DATA | DAL | `da:read` / `da:write` / `da:admin` | Full DAL surface |
| `/v1/businesses/:id/operations/{intake/:pkg, summary, inventory, procurement, suppliers, workforce, assets}` | OPERATIONS | BO | `bo:read` / `bo:write` | `intake` consumes a DAL publication package |
| `/v1/businesses/:id/{products,orders,register-sessions}` (≈14) | COMMERCE | BO | `bo:read` / `bo:write` | POS-style surface (create/complete/void orders, line items) |
| `/v1/businesses/:id/events` (+ `/summary`) | OPERATIONS | BO | `bo:write` / `bo:read` | Generic event intake |
| `/v1/billing/*` (4), `/v1/incidents/*` (6), `/v1/metrics` | ADMIN / platform ops | — | `platform:admin` (most) | |
| `/documentation` | — | — | public | Swagger UI |

**Not found in Stack B:** any route for Business Intelligence (`bi:*`), Continuous Learning (`cl:*`), or BI→DT / OM→CL handoffs. These layers exist as `layers/*` blocks and DB schemas but are not exposed by `apps/api` (to confirm in Phase 2).

Other inventories (spec §6.2): RPCs — none found; worker endpoints — none besides Pages Functions; scheduled processes — `nurture-batch` (HTTP-triggered, bearer secret); queues — `events` schema outbox (see §5); UI routes — Stack A SPA sections in `index.html`, `dal.html`, `bol.html`; Stack B `apps/web/app/` (`/`, `/businesses`, `/businesses/[id]/workflow`, `/businesses/[id]/history`).

---

## 4. Service inventory (spec §6.3)

Stack B runtime services (reads/writes from SQL found in source; events not yet traced):

| Service / module | Domain | Layer | Reads (schema) | Writes (schema) | Risk |
|---|---|---|---|---|---|
| `packages/data-acquisition-runtime` | DATA | DAL | `data_acquisition`, `platform` | `data_acquisition` (10 tables), `platform` (1), `tenancy` (2) | Writes `tenancy`/`platform` — outside DATA's own schema (O-4) |
| `packages/business-operations-runtime` | OPERATIONS/COMMERCE | BO | `business_operations`, `data_acquisition` (4), `platform` (6) | `business_operations` (8), **`data_acquisition.publication_deliveries`** (`BusinessIntakeService.ts`) | Cross-schema write into DAL (O-4) |
| `packages/simulation-engine` | INTELLIGENCE | SIM | none (pure compute) | none | Low |
| `SimulationOrchestrationService` (in `apps/api`/workflow) | INTELLIGENCE | DAL→SIM→ADI | — | — | Orchestrates start of run; to trace |
| `packages/database` repositories (17 groups) | DATA | all | all 19 schemas | all 19 schemas | Single package can write every domain's tables (O-3) |
| `packages/onboarding` | EXPERIENCE/ADMIN | cold-start | `onboarding`, `tenancy` | `onboarding`, `tenancy` | |
| `packages/authentication` / `authorization` | ADMIN | — | `identity`, `tenancy` | `identity` | |
| `packages/billing` | ADMIN | — | `billing` | `billing` | |
| `packages/observability` | platform | — | `observability` | `observability` | |
| `packages/workflow` | CONTROL LOOP/EXP | cross-layer | BI/DT/SIM/ADI/ABA/OM reads | — (read view) | |
| `packages/llm-client` | INTELLIGENCE | ADI | — | — | External dependency (Anthropic); consumed by `packages/workflow` (`BusinessDecisionRecommendationService`) and `configuration/secrets.ts` |

Layer blocks (`layers/*/blocks/*`, 8 layers × ~25 blocks) are domain/application/infrastructure code per block; their runtime wiring to `apps/api` was **not** traced in this phase.
External dependencies seen: Anthropic API (Stack A `decisions`/`simulate`, Stack B `llm-client`), Cloudflare Workers AI (`parse-idea`), Resend (email), Sentry (browser DSN), PostgreSQL, Cloudflare D1/KV.

---

## 5. Database inventory (spec §6.4)

### 5.1 Stack B — PostgreSQL (170 ordered migrations, contiguous, 0001–0049 hash-frozen)

| Schema | ≈Tables | Domain owner (proposed) | Layer |
|---|---:|---|---|
| `tenancy` | 8 | BUSINESS ADMINISTRATION | — |
| `identity` | 6 | BUSINESS ADMINISTRATION | — |
| `billing` | 4 | BUSINESS ADMINISTRATION | — |
| `onboarding` | 1 | EXPERIENCE / ADMIN | cold-start |
| `platform` | 29 | DATA (shared registries?) / mixed | cross-layer — ownership unclear |
| `events` | 5 | DATA (event infrastructure) | cross-layer |
| `files` | 4 | DATA | DAL |
| `audit` | 3 | BUSINESS ADMINISTRATION / cross-cutting | — |
| `observability` | 2 | platform ops | — |
| `api` | 1 | EXPERIENCE (idempotency) | — |
| `data_acquisition` | 36 | DATA | DAL |
| `business_operations` | 51 | OPERATIONS / COMMERCE / FINANCE | BO |
| `business_intelligence` | 48 | INTELLIGENCE | BI |
| `business_digital_twin` | 51 | INTELLIGENCE | BDT |
| `simulation` | 44 | INTELLIGENCE | SIM |
| `ai_decision_intelligence` | 47 | INTELLIGENCE | ADI |
| `approved_business_action` | 46 | CONTROL LOOP | ABA |
| `outcome_monitoring` | 45 | CONTROL LOOP | OM |
| `continuous_learning` | 47 | CONTROL LOOP | CL |
| **Total** | **≈478 tables** | | |

Other DB objects (grep counts across all migrations): **155** functions, **240** triggers, **448** `CREATE POLICY`, **455** `ENABLE ROW LEVEL SECURITY`, **0** views / materialized views. Queue/outbox: `events` schema (5 tables; see `docs/data-acquisition-event-outbox.md`). Audit tables: `audit` (3) plus per-layer audit/lineage tables.

Per-table template (authoritative writer / readers / mutation path / RLS) is **deferred to D3** for the ≈478 tables; at this phase ownership is recorded **per schema**. Observed writers by module (from SQL in code):

| Schema | Observed writers |
|---|---|
| `data_acquisition` | `data-acquisition-runtime`, **`business-operations-runtime`** (`publication_deliveries`), `database` repos |
| `platform`, `tenancy` | `data-acquisition-runtime`, `database` repos |
| all other layer schemas | `database` repos only (via repository classes) |

### 5.2 Stack A — Cloudflare D1 + KV

| Store | Object | Writer(s) | Readers | Notes |
|---|---|---|---|---|
| D1 | `businesses` | `business/manage` | events, summary, twin | owner by `user_email` |
| D1 | `business_events` | `business/events` | summary, twin | append-only; 5 event types |
| D1 | `decision_memory` | `business/decisions/*` | history | recommend + choice + outcome all write one table |
| KV `INFINICUS_USERS` | users, sessions, twin cache (TTL) | `auth/*`, `business/twin` | auth, decisions | two concerns in one namespace |
| KV `INFINICUS_WAITLIST` | waitlist | `waitlist` | `nurture*` | |

No RLS equivalent; tenant scoping is by `user_email` in handler code.

---

## 6. Contract and event inventory (input for Phase 4–5)

**Implemented handoffs** (`packages/handoff-contracts`, all `1.0.0`): `dal-to-bo`, `bo-to-bi`, `bi-to-dt`, `dt-to-sim`, `sim-to-adi`, `adi-to-aba`, `aba-to-om`, `om-to-cl`, `cl-feedback`.

**Manifest §8 canonical contract names** vs. implementation (name-level only; semantics audited in Phase 4):

| Manifest contract | Nearest implemented artifact | Name match |
|---|---|---|
| `CanonicalBusinessDataset` (DAL→BO) | `dal-to-bo` payload | No — different name |
| `OperationalEventStream` (BO→BI) | `bo-to-bi` payload (publication package) | No |
| `CurrentOperationalState` + `AnalyticalEvidence` (→BDT) | `bi-to-dt` payload; no BO→BDT state contract found | Partial / missing BO leg |
| `TwinSnapshot` (BDT→SIM) | `dt-to-sim` | No |
| `SimulationEvidencePackage` (SIM→ADI) | `sim-to-adi` | No |
| `DecisionPackage` (ADI→ABA) | `adi-to-aba` | No |
| `AuthorizedActionPackage` (ABA→BO) | none found; `aba-to-om` only | **Missing** |
| `ExecutionEvidence` (BO→OM) | none found | **Missing** |
| `VerifiedOutcomeEvidence` (OM→CL) | `om-to-cl` | No |
| `CalibrationProposal` (CL→Intelligence) | `cl-feedback` | No |

**Events:** `packages/event-contracts` defines dot-notation types per layer (`da.*`, `bo.*`, `bi.*`, `dt.*`, `sim.*`, `adi.*`, …). Manifest §9 uses `SALE_COMPLETED`-style names and requires `event_id, event_type, business_id, timestamp, schema_version, source, correlation_id, causation_id`; `PlatformEvent` shape to be compared in Phase 5. Stack A events have none of the correlation/schema-version fields.

---

## 7. Observations carried to later phases (not findings)

| ID | Observation | Evidence | Goes to |
|---|---|---|---|
| O-1 | Two parallel stacks with separate identity, business, event and decision stores and no sync | §1, §3.1, §5.2 | Phase 3 (source of truth), Phase 9 |
| O-2 | `POST /v1/businesses/:id/simulations` runs "Data Acquisition → Simulation → AI-DI" with no BI/Twin leg; Stack A `/api/simulate` has no Twin snapshot | `routes/businesses.ts`, `simulate.js` | Phase 6 §11.1 (simulation-first) |
| O-3 | `packages/database` repositories can write all 19 schemas; schema-level ownership is not enforced by code boundaries (DB roles/RLS not yet reviewed) | §4, §5.1 | Phase 3, 6 §11.7 |
| O-4 | `business-operations-runtime` writes `data_acquisition.publication_deliveries`; `data-acquisition-runtime` writes `tenancy` and `platform` | grep in §4 | Phase 3, 6 §11.7 |
| O-5 | No named COMMERCE or FINANCE module; their manifest responsibilities sit inside `business_operations` | §2.2 | Phase 2 mapping |
| O-6 | Stack A has no BO or SIM browser engines; Stack B has no BI/CL API routes | §2.1, §3.2 | Phase 2 layer mapping |
| O-7 | Stack A `decision_memory` is one table for recommendation, choice and outcome (three layers' truth) | §5.2 | Phase 3 |
| O-8 | Stack B `ABA→BO` (`AuthorizedActionPackage`) and `BO→OM` (`ExecutionEvidence`) contracts not found | §6 | Phase 4 |
| O-9 | CI covers `infinicus-platform/**` only; Stack A and the 7 browser bundles are not in CI (bundle guard `scripts/check-bundles.mjs` is manual) | `.github/workflows/ci.yml` | Phase 10 plan |
| O-10 | `platform` schema (29 tables) has unclear domain ownership | §5.1 | Phase 3 |

**Candidate architecture conflicts** needing an explicit decision before any MIGRATE phase: O-1 (which stack is authoritative) is the only one that could be an *architecture* conflict; the rest are reconciliation work inside the locked model.

---

## 8. Completion status of Phase 1

| Spec item | Status |
|---|---|
| 6.1 Folder/module inventory | Done (§2) |
| 6.2 Route inventory | Done at route-group level (§3); per-route "Reads/Writes" for Stack B handlers is summarized, not exhaustive |
| 6.3 Service inventory | Done at package level (§4); layer-block wiring and event consume/produce not traced |
| 6.4 Database inventory | Schema level done (§5); per-table writer/reader/RLS template deferred to D3 |

**Next phase:** Phase 2 — Architecture Mapping (D2 `LAYER_DOMAIN_MAPPING.md`).
