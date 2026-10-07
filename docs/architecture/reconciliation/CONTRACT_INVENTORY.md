# CONTRACT_INVENTORY — BUILD-ARCH-RECON-01, Phase 4 (D4)

**Status:** AUDIT COMPLETE — **read-only**. No application code, schema, specification or data was changed to produce this document.
**Authority applied:** Master Manifest v1.0 §8 (canonical inter-layer contracts), §9 (event rules), §10–11 (ownership, no direct mutation); authorisation of 2026-10-07 (Stack B is the target for all 9 layers; domains never transfer layer ownership).
**Baseline audited:** `main` at `ad6440c` (Stack B code identical on this branch). Items from **unmerged** PRs are labelled and are not baseline: PR #14 (webhook intake, draft), PR #22 (BUILD-33 event architecture, draft).
**Method / limits:** source reading plus grep over `packages/handoff-contracts`, `packages/workflow`, `packages/database`, `apps/api`, the browser `platform/platform-bootstrap.js` handoff map, and SQL migrations. Nothing was run against production. Browser-bundle blocks (≈200) were not read individually.

## PROVISIONAL markers (not answered here)

These three questions remain **UNRESOLVED**. Findings that depend on them are tagged and must not be treated as final.

| Tag | Open question |
|---|---|
| **[P:SOT-01]** | Are Supabase user IDs ever exposed to third parties? (decides whether the identity/tenant claim on Stack B contracts can be trusted) |
| **[P:SOT-02]** | Will the legacy `/api/business/*` endpoints be blocked or removed, and when? (decides whether they stay in the contract surface) |
| **[P:L-1]** | Does one user interaction constitute sufficient approval authority? (decides whether the ADI→ABA authorization step is valid) |

---

## 1. Summary — the ten canonical contracts (Manifest §8)

Status vocabulary: **WIRED** = a contract type exists and runtime code uses it; **DEFINED, NOT WIRED** = type + validator exist but runtime code does not call them (only tests); **BYPASSED** = layers exchange the data by another mechanism; **MISSING** = no artifact found.

| # | Manifest contract | Direction | Implemented artifact | Status | Runtime validation | Severity |
|---|---|---|---|---|---|---|
| 1 | `CanonicalBusinessDataset` | DAL → BO | `dal-to-bo.ts` (`DALToBOHandoffPayload`, v1.0.0) + `data_acquisition.publication_packages` | **WIRED** | `BusinessIntakeService` validates and consumes | — |
| 2 | `OperationalEventStream` | BO → BI | `bo-to-bi.ts` (v1.0.0) + `business_operations.bo_publication_packages` | **WIRED** | `OperationalPublicationService` produces and validates | — |
| 3a | `CurrentOperationalState` | BO → BDT | none found (no BO→BDT contract file) | **MISSING** (BDT reads BO event ledger directly) | none | MEDIUM |
| 3b | `AnalyticalEvidence` | BI → BDT | `bi-to-dt.ts` (v1.0.0) | **DEFINED, NOT WIRED**; browser map says `not_wired`; no BI route | none | MEDIUM |
| 4 | `TwinSnapshot` | BDT → SIM | `dt-to-sim.ts` (v1.0.0) | **DEFINED, NOT WIRED**; simulation orchestration does not reference a Twin snapshot | none | MEDIUM |
| 5 | `SimulationEvidencePackage` | SIM → ADI | `sim-to-adi.ts` (v1.1.0) | **WIRED** | `sim-to-adi-mapper.ts` | — |
| 6 | `DecisionPackage` | ADI → ABA | `adi-to-aba.ts` (v1.0.0) + `adi_publication_packages` / `aba_intake_packages` | **BYPASSED** (orchestrator drives the tables directly) | validator not called | HIGH |
| 7 | `AuthorizedActionPackage` | ABA → BO | none found | **MISSING** | none | HIGH |
| 8 | `ExecutionEvidence` | BO → OM | none found; `aba-to-om.ts` is a different leg | **MISSING** | none | HIGH |
| 9 | `VerifiedOutcomeEvidence` | OM → CL | `om-to-cl.ts` (v1.0.0) | **DEFINED, NOT WIRED**; no OM→CL route | none | HIGH |
| 10 | `CalibrationProposal` | CL → Intelligence | `cl-feedback.ts` (v1.0.0), target `PLATFORM` | **DEFINED, NOT WIRED** | none | MEDIUM |

Additional implemented leg not in the manifest list: `aba-to-om.ts` (ABA → OM monitoring contract), **BYPASSED** like #6.

**Naming.** The manifest names are logical contract names; the repository names the same payloads after the layer boundary (`DAL→BO`, …) and uses "publication package / intake package" tables. This is a naming difference, not a structural one. Per the authorisation (no cosmetic renames), the recommendation is a contract-name mapping in the registry, not renaming code.

---

## 2. Contract attributes (spec §9: producer, consumer, schema, version, tenant/business id, correlation, provenance, compatibility, validation, failure behavior)

Shared by all nine implemented handoff files (verified by file scan):

| Attribute | Common finding |
|---|---|
| Schema | TypeScript interface `<X>HandoffPayload` inside `LayerHandoff<T>` envelope (`shared-types`): `handoffId, sourceLayer, sourceBlock, targetLayer, targetBlock, payload, correlationId, lineage[], status, createdAt` |
| Version | `<X>_CONTRACT_VERSION`; all `1.0.0` except `sim-to-adi` `1.1.0` |
| Tenant/business id | `tenantId`, `workspaceId` and `businessId` in every payload; **`dal-to-bo` allows `businessId: null`**, all others require it |
| Correlation | envelope `correlationId` (required) — not repeated inside the payload |
| Provenance | `lineage[]` on the envelope; DAL→BO also carries `provenanceReferenceIds`, `consentReferenceIds`, quality and reliability scores |
| Idempotency | `idempotencyKey` present in every payload |
| Validation | one `validate<X>Handoff()` per file returning `{ valid, reasons[] }`, never throwing; checks layer names, status `ready`, required ids, serializability, and a `forbidden_field_*` list so no downstream business logic rides inside the handoff |
| Compatibility policy | **strict equality** (`contractVersion !== X` → `contract_version_unsupported`). No backward-compatibility window is defined in code |
| Failure behavior | reject with reasons; the handoff is not applied |
| Extra controls | only `dal-to-bo` scans for credential-like keys; only `dt-to-sim` and `bi-to-dt` carry freshness fields; `dt-to-sim` and `sim-to-adi` reference a snapshot id; `adi-to-aba`, `bi-to-dt`, `dt-to-sim` carry confidence |

Per-contract notes:

| Contract | Producer → consumer in code | Notes |
|---|---|---|
| DAL→BO | DAL `publishPackage` → `BusinessIntakeService.intake` | Consumer **rejects `businessId === null`** (`BusinessIntakeService.ts:154, 262`), so the nullable payload field is guarded at the consumer. Consumer also writes `data_acquisition.publication_deliveries` (D3 SOT-09) |
| BO→BI | `OperationalPublicationService` → BI publication package | produced; **no BI consumer route** in `apps/api` |
| BI→BDT | none at runtime | browser `HANDOFF_MAP`: `BI_TO_DT` = `not_wired`, `contractBacked: false` |
| BDT→SIM | none at runtime | `HANDOFF_MAP`: `DT_TO_SIM` = `not_wired` |
| SIM→ADI | `layers/simulation` mapper → ADI | `direct-port`, contract-backed; only contract at v1.1.0 |
| ADI→ABA | `packages/workflow` writes `adi_publication_packages` then `aba_intake_packages` | see C-01 |
| ABA→OM | `packages/workflow` writes `aba_publication_packages` then `om_intake_packages` | see C-01 |
| OM→CL, CL feedback | none at runtime | `HANDOFF_MAP` marks both `active` via `registerPublisher` / event bus in the **browser** bundles only, not contract-backed |

Wiring on the browser side (`platform/platform-bootstrap.js:102–152`, a frozen static map): `DA_TO_BO` and `BO_TO_BI` persistence, contract-backed; `SIM_TO_ADI` direct-port, contract-backed; `BI_TO_DT`, `DT_TO_SIM`, `ADI_TO_ABA` **not wired**; `ABA_TO_OM`, `OM_TO_CL` active but **not contract-backed**; `CL_FEEDBACK` event-bus, not contract-backed.

---

## 3. Findings

| ID | Severity | Finding | Evidence | Affects contract |
|---|---|---|---|---|
| **C-01** | **HIGH** | **Six of nine handoff validators are never called by runtime code** (`validateBIToDT`, `DTToSIM`, `ADIToABA`, `ABAToOM`, `OMToCL`, `CLFeedback`); they appear only in contract files and migration tests. ADI→ABA and ABA→OM transfers are performed by `packages/workflow` calling repositories for **two layers' schemas in one request** (`adiPublications.createPackage/markReady/dispatch` → `abaIntake.receivePackage/acceptPackage` → `createReview` → `submitApprovalDecision` → `approvedActions.createAction`; then `abaPublications…` → `omIntake…` → `monitoringPlans…` → `monitoredActions…` → `workflow.recordOutcome`). The persisted publication/intake tables act as the handoff, but the typed, validated contract is bypassed. | `BusinessDecisionRecommendationService.ts` (`startChoiceReview`, `recordChoiceOutcome`); grep for validators | 6, ABA→OM |
| **C-02** | **HIGH** | **No `AuthorizedActionPackage` exists.** An `ApprovedAction` is created in ABA and nothing delivers it to Business Operations. Business Operations' only command executor (`OperationalCommandExecutor`) is fed by DAL publication mappers, not by ABA. The approve → execute → monitor loop is closed by a human performing the action and typing the outcome. | grep for the contract and for any ABA consumer in `business-operations-runtime` | 7 |
| **C-03** | **HIGH** | **No `ExecutionEvidence` (BO→OM) and no `VerifiedOutcomeEvidence` (OM→CL).** OM receives its observation from the caller's text (`evidenceType: 'manual_entry'`, `addExecutionObservation({ notes })`). The label is honest, but it is a user assertion, not post-action evidence from Business Operations, and nothing is produced for CL. Matches D3 SOT-04. | `recordChoiceOutcome`; absence of OM→CL route | 8, 9 |
| C-04 | MEDIUM | The Twin is built from the BO event ledger by `TwinComputationService`; there is no `CurrentOperationalState` contract and no `AnalyticalEvidence` input. Manifest §8.3 requires both and forbids the Twin inferring operational truth independently. Matches D3 SOT-12. | `TwinComputationService.ts:45–60`; `HANDOFF_MAP` | 3a, 3b |
| C-05 | MEDIUM | `POST /v1/businesses/:id/simulations` runs DAL→SIM→ADI and does not reference a Twin snapshot; `dt-to-sim` requires a snapshot id. Matches D1/D3 O-2. | `SimulationOrchestrationService.ts` (no snapshot use) | 4 |
| C-06 | MEDIUM | **Strict version equality and no compatibility policy.** A producer bump (as `sim-to-adi` to 1.1.0 already did) breaks any consumer still on 1.0.0; there is no window, adapter or negotiation. | `contract_version_unsupported` checks | all |
| C-07 | MEDIUM | **Idempotency keys inside handoffs are random per call** in the orchestrator (`randomUUID()` for each publication and intake). A retried request creates a second publication/intake chain; protection comes only from the API layer's `Idempotency-Key` table, which is optional per call site and does not cover internal retries. | `startChoiceReview`, `recordChoiceOutcome` | 6, ABA→OM |
| C-08 | MEDIUM | **Only `dal-to-bo` scans for credential-like keys**; the other eight contracts do not. | `CREDENTIAL_KEY_PATTERN` only in `dal-to-bo.ts` | 2–10 |
| C-09 | LOW | `dal-to-bo` allows `businessId: null` while the manifest requires a business/tenant identifier on every contract. Guarded by the consumer today; the type permits the unsafe value. | `dal-to-bo.ts`, `BusinessIntakeService.ts:154` | 1 |
| C-10 | LOW | Contract names differ from the manifest (§1). | — | all |
| C-11 | **PROVISIONAL [P:L-1]** | In the ADI→ABA step the orchestrator creates the approver assignment for the calling user and records the `ApprovalDecision` in the same request (`approverUserId: ctx.userId`, generated `assignmentCode`/`decisionCode`), under the single route permission `aba:write`. No authority/threshold check (ABA-05/06 concepts) appears in the service. Whether this satisfies approval authority is **exactly the open question L-1**; this audit does not answer it. | `startChoiceReview` | 6 |
| C-12 | **PROVISIONAL [P:SOT-01]** | Every Stack B contract's `tenantId`/`businessId` is as trustworthy as the session that produced it. For browser-originated requests that session is a derived shadow account (D3 SOT-01). If Supabase IDs are discoverable, the tenant claim on these contracts is forgeable by whoever derives the credentials. | `index.html:3523–3535` | all |
| C-13 | **PROVISIONAL [P:SOT-02]** | Legacy Stack A `/api/business/*` is an undocumented, unauthenticated contract surface (client-supplied `user_email`/`business_id`; its own JSON shapes). It is inventoried below and kept in scope until SOT-02 is resolved. | `functions/api/business/*.js` | — |

**CRITICAL:** none. C-02 and C-03 are the largest structural gaps but do not by themselves create a direct-mutation path; they are **missing contracts**, not bypasses of an existing control.

---

## 4. Event inventory (feeds Phase 5)

### 4.1 Baseline (`main`)

| Item | Finding |
|---|---|
| Event types | `packages/event-contracts` lists dot-notation types (`da.*, bo.*, bi.*, dt.*, sim.*, adi.*, aba.*, om.*, cl.*`) |
| Envelope | `PlatformEvent` has `eventId, eventType, eventVersion, tenantId, businessId, correlationId, causationId?, payload, occurredAt, publishedAt`; **no `source` field** (manifest §9 lists `source` and `schema_version`; `eventVersion` plays the schema-version role) |
| Storage | `events.outbox_events` (`event_version`, `tenant_id` NOT NULL, `business_id` **nullable**, `correlation_id` NOT NULL, `causation_id` nullable, `aggregate_type/id`, `status` pending→processing→published/failed/dead_lettered); `events.inbox_events` with `UNIQUE (event_id, consumer_name)`; delivery attempts; subscriptions; dead letters |
| Producers | SQL trigger functions per layer (`emit_*` in 11 migration files: DA 0022, BO 0036, BI 0049, DT 0062, SIM 0076, ADI 0091, ABA 0106, OM 0121, CL 0136, onboarding 0141, billing 0153) through `emit_outbox_event` |
| Consumers | **none found** in application code: only `outbox.ts`, `outboxMonitor.ts`, `PlatformIncidentRepository.ts` reference the table; cross-layer handoffs do not travel on events (§3 C-01) |
| Idempotency | present on the consumer side (inbox unique); **no dedupe key on the outbox** |
| Mutability | outbox rows are updated through status changes; **no append-only/immutability trigger found** on `events.*` in the baseline migrations |
| Naming | repository uses `da.data.published`-style names; manifest §9 examples (`SALE_COMPLETED`, `ACTION_AUTHORIZED`, …) are uppercase business events not defined as such |
| Missing manifest events | no `ACTION_AUTHORIZED` (ABA→BO), `ACTION_EXECUTED`, `OUTCOME_VERIFIED`, `CALIBRATION_PROPOSED`, `MODEL_VERSION_ACTIVATED` (consistent with C-02/C-03/CL gaps) |

### 4.2 In-flight work that overlaps — **PROVISIONAL until merged**

| PR | What it adds | Effect on this audit |
|---|---|---|
| **#22** BUILD-33 (draft, 66 commits, base `0f3efef`) | canonical `BusinessEvent` contract + registry in `event-contracts`; `packages/database/src/eventing/*` (ledger, outbox, inbox, delivery attempts, dead letter, replay authorization); migrations **`0171_create_business_event_ledger.sql`** and **`0172_harden_eventing_scope.sql`**; "immutable Event Ledger foundation" | would address the mutability, `source`, idempotency and ownership gaps in §4.1. **Do not treat §4.1 gaps as final until #22 is reviewed.** Its status "in_progress" and "do not merge until validation gates are green" stand |
| **#14** webhook intake (draft) | inbound DAL route; no new cross-layer contract (see §5) | provisional until merged |

### 4.3 Migration-number collision (action needed)

PR #14 now carries `0171_create_da_webhook_token_lookup.sql` (renumbered from 0170 on the owner's authorisation, because `main` already has `0170_add_approved_action_source_recommendation.sql`). **PR #22 also adds `0171_…` and `0172_…`.** Per `MIGRATION-ALLOCATION-POLICY.md`, the branch merged first keeps its number and the other renumbers; the merge order is not decided. The root guard added in Fix 2 (unique, contiguous numbers) will fail on whichever branch merges second until it renumbers.

---

## 5. Webhook (PR #14) against the authorised architecture rule — provisional

Authorised flow: external sender → authenticated webhook credential → DAL intake (validation, provenance, idempotency) → governed DAL→BO contract → downstream lifecycle.

| Check | Result (code on PR #14 branch, `5b5a087`) |
|---|---|
| Inbound only | `receiveWebhook` creates a DAL collection run through `runIntake`; no BO/BI/BDT/SIM/ADI/ABA/OM/CL write found |
| Authenticated credential | bearer token in the URL path; hash comparison; identical rejection for unknown prefix and wrong secret |
| Provenance and validation | shared `runIntake` pipeline with manual intake |
| Idempotency | `webhook_receipts` keyed by `external_event_id` or payload SHA-256, per data source |
| Governed DAL→BO hand-off | publication to BO remains a **separate explicit step** (`publishPackage`, creating a `business_operations`-targeted package); the webhook does not auto-publish |
| New contract introduced | none; the DAL→BO contract (#1) is unchanged |
| Open issues | rate limiting appropriate for delivery/retries **not confirmed**; sender headers stored verbatim in `webhook_receipts.headers` (both tracked in the PR) |

No direct cross-layer mutation, duplicated source of truth, authorization bypass or contract conflict was found in the webhook change itself.

---

## 6. Legacy Stack A surface — **PROVISIONAL [P:SOT-02]**

| Endpoint family | Shape source | Contract | Authentication |
|---|---|---|---|
| `/api/business/{manage,events,summary,twin}` | ad-hoc JSON, D1 | none (see D3) | client-supplied `user_email` / `business_id` |
| `/api/business/decisions[/recommend,/history,/record-choice,/record-outcome]` | ad-hoc JSON, `decision_memory` | none | same |
| `/api/{simulate,parse-idea,waitlist,feedback,send-email,nurture*}` | ad-hoc | none | rate limit / batch secret |
| `/api/auth/*` | KV users | none | email + password |

None of these participates in the nine lifecycle contracts. They are classified by what they stand in for (D3 §2), not as contract implementations.

---

## 7. Classification candidates (spec §14 vocabulary; for Phase 9, not decided here)

| Item | Candidate |
|---|---|
| C-01 bypassed validators | WRAP WITH CONTRACT (call the validator at the orchestration boundary, or generate the publication/intake rows from the validated handoff) |
| C-02 `AuthorizedActionPackage` | BLOCKED BY ARCHITECTURE DECISION (needs L-1) |
| C-03 `ExecutionEvidence` / `VerifiedOutcomeEvidence` | MIGRATE (introduce after C-02) |
| C-04/C-05 Twin inputs | WRAP WITH CONTRACT |
| C-06 version policy | KEEP + add a documented compatibility policy |
| C-07 random idempotency keys | MIGRATE (derive keys from the business request) |
| C-08 credential scan | WRAP WITH CONTRACT (shared validator helper) |
| C-09 nullable business id | KEEP (consumer guards); tighten type later |
| C-10 naming | RENAME **not recommended**; add a mapping table |
| Event gaps (§4.1) | BLOCKED until PR #22 is reviewed |
| PR #14/#22 migration numbers | MIGRATE (renumber the later branch) |

---

## 8. Stop-condition check (D2 standing rule)

| Condition | Result |
|---|---|
| Source of truth conflict | none new (D3 findings stand) |
| Layer ownership / domain boundary | none |
| **Authorization flow** | **C-11 is PROVISIONAL on L-1**; nothing changed or concluded |
| Event/handoff or data contract conflict | **missing and bypassed contracts reported (C-01–C-03)**; no conflicting definitions found (no two files claim the same contract) |
| Direct mutation / duplicate canonical writer | none found; webhook is DAL-only |
| Simulation mutation, ADI direct execution, OM evidence mutation, CL self-modification | none found |
| ABA bypass | **Not concluded.** The orchestrator performs ABA steps programmatically (C-01, C-11); whether that bypasses ABA's authority depends on L-1 |

**No CRITICAL conflict. Items needing a decision from you are listed in the completion message, not resolved here.**

---

## 9. Completion status

| Spec item (§9) | Status |
|---|---|
| Validate or introduce the 10 canonical contracts | Validated; 3 MISSING (3a, 7, 8), 5 DEFINED-NOT-WIRED or BYPASSED, 2 WIRED; **nothing introduced** (read-only phase) |
| producer, consumer, schema, version, tenant/business id, correlation, provenance, compatibility, validation, failure behavior | §2 |
| Event audit (Phase 5) | partially covered (§4); **final once PR #22 is reviewed** |

**Next phase:** Phase 5 completion (event audit, after PR #22 review) and Phase 6 — Architecture Violation Scan (D5 `ARCHITECTURE_VIOLATIONS.md`).
