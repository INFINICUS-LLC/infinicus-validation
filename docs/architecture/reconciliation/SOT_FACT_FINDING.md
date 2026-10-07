# SOT_FACT_FINDING — SOT-05, SOT-06, SOT-07 and duplicate-block comparison (READ-ONLY)

**Status:** FACT-FINDING ONLY. **No canonical ownership is assigned** where evidence is incomplete. No code, spec, data or file was changed or moved. Authority: your ruling of 2026-10-07 (SOT-05/06/07 = fact-find first; duplicate blocks = compare semantics before any classification).
**Limit:** this repository cannot show **production** row populations (Supabase, Cloudflare D1/KV, Stack B Postgres). Each "unknown" below lists the exact read-only query that would settle it.

## 1. SOT-05 — Entitlement and usage metering

| Fact (verified in repo) | Evidence |
|---|---|
| The SPA reads the user's plan and simulation count from **Supabase** `profiles` (`plan`, `sim_count`) after sign-in and keeps them in `U` (browser state and `localStorage`). | `index.html:838–845` |
| The SPA gates UI features on that browser copy (`isPro()`, `isGrowthPlus()` read `U.plan`). | `index.html:3338–3339`, `3701`, `6181`, `6430` |
| After a simulation the browser **writes** usage itself: inserts into Supabase `simulations` and calls RPC `increment_sim_count`; it also increments `U.simCount` locally. | `index.html:876–882`, `3797` |
| Stack B has its own entitlement model: `billing.plans`, `billing.subscriptions`, `billing.subscription_status_history`, `billing.usage_records`, `EntitlementService`, and `requireActiveSubscription` on business-write routes. | migration `0150`; `packages/billing`; `apps/api/src/plugins/billing.ts` |
| The SPA never calls any Stack B billing route (0 references to `/v1/billing`). | grep of `index.html`, `account.html` |
| **No payment-provider integration exists in the repository** (no Stripe/Paddle/etc. code in Stack B, Stack A functions or the SPA beyond marketing text). So the repo does not show **how a plan value ever changes**. | grep |

**Therefore:** two independent entitlement systems exist with no link between them. Which one is authoritative in production is **not determinable from the repo**.
**Unknowns (need production evidence):** (a) how/where `profiles.plan` is set; (b) whether `billing.subscriptions` has real tenant rows; (c) whether plan limits are enforced anywhere on the server for the SPA's flows (the SPA's own gating is client-side and therefore advisory).
**Read-only queries to run (please review/run, then share counts only):**
- Supabase: `select plan, count(*) from profiles group by plan;` and `select count(*) filter (where sim_count>0), count(*) from profiles;`
- Stack B: `select status, count(*) from billing.subscriptions group by status;` and `select count(*) from billing.usage_records;`
**Decision status:** NOT ASSIGNED. Client-side plan gating cannot be treated as authoritative entitlement in any case (security note, not an ownership ruling).

## 2. SOT-06 — Owner of plan/subscription data (and legacy D1)

| Fact | Evidence |
|---|---|
| Plan/subscription **schema** exists only in Stack B (`billing.*`, migration `0150`, seeded plans) and implicitly in Supabase `profiles` (table definition is **not** in this repository, so its schema is unverifiable here). | migrations; grep of `schema.sql` (contains only `businesses`, `business_events`, `decision_memory`) |
| Stack A D1 (`INFINICUS_DB`) holds **no** plan/subscription table. It is used by `functions/api/business/*` (28 `prepare(` calls); KV `INFINICUS_USERS` is used by the auth functions (6 references). | `schema.sql`; `functions/api/*` |
| Legacy D1 data = `businesses`, `business_events`, `decision_memory` (the legacy `/api/business/*` surface, SOT-02). | `schema.sql` |

**Therefore:** the authoritative owner of plan/subscription data **cannot be proven from the repo**. Candidates are Supabase `profiles` (what the live SPA reads) and Stack B `billing.*` (what the API enforces). Same queries as SOT-05; additionally for D1: `select count(*) from businesses; select count(*) from business_events; select count(*) from decision_memory;` (needed for the SOT-02 retirement gate "data migration complete").
**Decision status:** NOT ASSIGNED.

## 3. SOT-07 — Who writes, reads and governs `platform.*`

**Correction to my earlier statement (SOURCE_OF_TRUTH_AUDIT SOT-07: "platform schema has no declared single owner"):** the frozen architecture map `docs/architecture/BUILD-32-DOMAIN-OWNERSHIP-MAP.md` **does assign per-table owners**. What is true is that the schema as a whole is shared and is not owned by one domain, which is consistent with the map ("cross-cutting platform infrastructure is not a ninth business domain").

| Table(s) | Declared owner (BUILD-32 map) | Code writers (non-test) | Readers |
|---|---|---|---|
| `platform.orders`, `customers`, `payments` | COMMERCE | `packages/database` (`OrderRepository`) | `business-operations-runtime`, `packages/database` |
| `platform.suppliers`, `inventory_items`, `warehouses` | OPERATIONS (canonical reference) | `packages/database` repositories | same |
| `platform.employees` | BUSINESS ADMINISTRATION (master) | `packages/database` | same |
| `platform.businesses` | **not listed in the map** | `packages/database` (`BusinessRepository`, onboarding) | multiple |
| `platform.incidents`, `incident_updates`, `deployment_events`, `secret_rotation_events`, `system_settings` | **not listed** (cross-cutting infrastructure by description) | `packages/database` repositories | observability/API |
| `platform.decisions`, `approved_actions`, `outcomes`, `simulations`, `learning_items`, `metrics`, `operational_events` | not listed | **none found** | **none found** (SOT-10) |

- **Writers:** the only non-test writers are six repositories in `packages/database`. `business-operations-runtime` reads `platform.*` (7 files) and writes to its own `business_operations.*` plus (SOT-09) one DAL table.
- **Governance gaps:** `platform.businesses` and the infrastructure tables have no explicit owner in the map; whether they are "Business Administration" or "cross-cutting infrastructure" is a ruling for you.
**Decision status:** per-table ownership for the six commerce/operations/admin tables is **documented** (BUILD-32 map; build-spec level 5, not a locked layer spec). No ruling assigned by me for `platform.businesses` or the infrastructure tables. SOT-08 (two writer paths on three BO tables) remains.

## 4. Duplicate blocks — root copies vs `infinicus-platform/layers/*/blocks`

Method: SHA-256 per file (excluding `node_modules`, `dist`, `.turbo`); for ADI additionally compared the string and numeric literals of each root block against the platform source rebuilt with esbuild.
**Limit:** literal comparison catches changed messages, codes, thresholds and policy constants; it is **not proof of identical control flow**. No locked spec was edited.

| Layer | Root files | Platform files | Result |
|---|---|---|---|
| Approved Business Action | 456 | 455 | **455 byte-identical**; root-only: `aba-bundle.js` |
| Business Intelligence | 464 | 463 | **463 identical**; root-only: `bi-bundle.js` |
| Continuous Learning | 404 | 403 | **403 identical**; root-only: `cl-bundle.js` |
| Data Acquisition | 402 | 400 | **400 identical**; root-only: `da-bundle.js`, one extra bundle integration test |
| Digital Twin (platform: `business-digital-twin`) | 459 | 458 | **458 identical**; root-only: `dt-bundle.js` |
| Outcome Monitoring | 425 | 424 | **424 identical**; root-only: `om-bundle.js` |
| AI Decision Intelligence | 204 | 327 | **Not byte-identical by design.** Same 25 block names. Root block files are **single-file browser builds**; platform blocks are multi-file ES modules. |
| Business Operations, Simulation | none | n/a | no root copy of BO blocks; Simulation has no root block directory |

**ADI findings**
- 24 of 25 root ADI blocks have **the same string and numeric literals** as the platform source (the only difference is build plumbing). They are esbuild builds of the platform source. The root file headers embed a **build path from an earlier session scratchpad** (`.../adi-src-patched/...`): the root copies were generated from a patched working copy that is **not committed**, so the exact patch is unrecorded (provenance gap).
- **ADI-24 (ABA handoff) has one real environment difference:** platform uses synchronous `node:crypto` `createHash('sha256')`; the root browser build uses asynchronous Web Crypto `subtle.digest('SHA-256')`. Same algorithm and input (`JSON.stringify`); the digest function is async in the root copy, which only works because `build()` already awaits. Not a semantic change against the locked ADI spec on this evidence, but it is a divergence that must be tracked.
- Root `adi-bundle.js` is what `index.html` loads (`index.html:802`), so ADI behaviour in production comes from the **root build**, not from the platform source.

**Provisional policy applied (your ruling):** platform copies = target; root = legacy/compatibility candidates; **no deletion, move, sync or overwrite.**
**Open before final classification:** (1) record the ADI patch/provenance; (2) a behavioural (not literal) check of the ADI root builds against the platform tests; (3) confirm the root-only `*-bundle.js` files are generated artifacts and say how they are produced.

## 5. Summary

| Item | State |
|---|---|
| SOT-05 | Facts gathered; **owner not determinable** from repo; production queries listed |
| SOT-06 | Facts gathered; **owner not determinable**; D1 counts needed for SOT-02 gate |
| SOT-07 | Per-table owners documented in BUILD-32 map; `platform.businesses` and infrastructure tables unowned in the map; earlier wording corrected |
| Duplicate blocks | 6 layers byte-identical except bundles; ADI is a build of the platform source with one environment difference (ADI-24) and an unrecorded patch |
| CRITICAL | none |
