# P0-5 Block 1 — `AuthorizedActionPackage`: contract reconciliation, source-of-truth ownership and issuance boundary

Status: **reconciliation for owner review. Documentation only.** No production code, no migration, no ABA→BO wiring, no live Supabase change, no locked-spec edit. Base: `main` at `a3b7fc8` (P0-4 closed, #45-#48). Block 2 does not start until the owner approves this document.
Owner rulings applied: **D-1..D-7 and the package-integrity ruling** (2026-10-08, section 12). Companions: `P0-5_HANDOFF.md`, `P0-4_ACCEPTANCE.md`, `ARCHITECTURE_VIOLATIONS.md` (V-12, V-13), `CONTRACT_INVENTORY.md` (C-02, C-03).

Evidence labels: **[spec]** quoted from the locked specifications; **[verified]** re-read directly in the repository for this block; **[inventory]** reported by the repository inventory and not individually re-read (treat as ~85-90% confidence); **[ruling]** owner ruling; **[proposal]** a reconciliation proposal that the owner has not yet ruled on.

Locked chain (unchanged): `ADI → ABA → AuthorizedActionPackage → BO execution → ExecutionEvidence → OM → CL`.

---

## 0. STOP findings and their resolution

| ID | Finding | Resolution |
|---|---|---|
| **S1** | `approve_with_modifications` is a bare status flag. `approval_decision_modifications` stores only `modification_code` + `description` (text); `approveWithModifications()` takes no modification input; `SubmitApprovalInput` and `POST /decisions` carry none; `addModification` has no production caller. The model cannot represent "the exact parameter set BO may execute" **[verified]**. | **D-2.** Persist immutably (1) the original proposed parameter set/reference, (2) a structured modification delta + reason, (3) the complete final effective authorized parameter set. Prose-only is insufficient. Execution-affecting modifications re-run the affected governance checks. No package is built around the incomplete state: Block 2+ must first add the structured capture (sections 5, 10). |
| **S2** | Required package fields with no authoritative source: action type, target resource, structured parameters, accountable owner, automation level, budget, rollback instructions, simulation reference on the review version, package version/status/expiry/integrity. Execution window, preconditions and monitoring metrics have tables but are never populated **[inventory]**. The locked ADI Decision Package (§26) has `recommended_option`/`alternatives` but no structured action type, target or parameters **[spec]**. | **D-1** (split authorship) fixes *who authors* the structured action; **D-6** fixes *how absence is represented* (`VALUE` / `NOT_APPLICABLE` / `UNAVAILABLE`; `UNAVAILABLE` ⇒ package not executable). Sources still to be built are listed in section 3 and 11. |
| **S3** | Ownership/spec ambiguity: BO §16 defines its own "Approval Engine" (GO/MODIFY/STOP) next to ABA's authority; specs are silent on package id/version, replay, single-use, expiry, revoke, BO acknowledgement and BO→ABA status; the Manifest §8.7 list has `approver`, ABA §32 does not. | **D-3** (authority split confirmed), **D-4** (package model), **D-5** (handoff), **D-7** (no locked-spec amendment needed). The residual design questions are in section 11 (R-1..R-10). |

**Not triggered (verified):** no duplicate execution authority exists today (nothing in BO consumes ABA output; the BO isolation guard passes, 6 tests); `ApprovedAction` is not treated as execution authority in any code path (table comment: "never a record of execution", migration 0097); no direct BO consumption of ABA state; ABA publication targets only `outcome_monitoring` in three places (CHECK, repository whitelist, emit function).

---

## 1. Proposed `AuthorizedActionPackage` ownership

**Authority chain [spec]:** "AI Decision Intelligence recommends. Approved Business Action authorizes. Business Operations executes. Outcome Monitoring verifies." (ABA §3). ABA is "the source of truth for: What business action was formally authorized." (ABA §35). ABA §32: "Publish an Authorized Action Package". Manifest §8.7: "Business Operations remains responsible for execution." BO is the operational truth owner (BO §39; ABA §36 forbids ABA to "mark success without execution evidence").

**Ownership [ruling D-1, D-3, D-4]:**
- **ABA owns, authors and issues** the `AuthorizedActionPackage` and is the source of truth for *what was formally authorized*. Canonical schema: `approved_business_action` (new, distinct records; section 5).
- **ADI authors** recommendation intent, recommended option, proposed parameters *where governed evidence supplies them*, alternatives, evidence, risk, confidence and simulation lineage. ADI never authorizes or executes (ADI §25, §37).
- **ABA authors the FINAL EXACT AUTHORIZED ACTION:** selected action, exact effective authorized parameters, modification delta, execution boundaries/conditions, accountable owner, approval/governance lineage. The package carries the **ABA-authorized effective parameter set**; BO never reconstructs parameters from ADI.
- **BO owns execution and operational truth.** BO revalidates operational conditions and may refuse; a refusal does not rewrite ABA approval and becomes BO execution/refusal evidence (D-3).
- **BO-side intake record** (a receipt, not authorization truth) lives in the BO schema (D-5).

**Answers to the Block 1 questions**
- Canonical repository/schema: `approved_business_action` for the package; `business_operations` for the BO receipt. Not `platform.*`.
- Existing tables overlapping the concept: see section 2 (OVERLAPS). None can serve as the package unchanged.
- `platform.approved_actions` is **legacy/compatibility only** (SOT-07; no production code reads or writes it **[inventory]**).
- `ApprovedAction` and `AuthorizedActionPackage` are **distinct records** [ruling D-4]. The specs state neither identity nor distinctness (ABA §16 draws `APPROVED BUSINESS ACTION → AUTHORIZED ACTION PACKAGE` as two steps; ABA §37 shows `AUTHORIZED ACTION → ASSIGN OWNER → EXECUTION PLAN → BUSINESS OPERATIONS`).

**Order of the ABA flow [spec ABA §37]:** approval review → GO/MODIFY/STOP → authorized action → assign owner → execution plan → Business Operations. The package is therefore **issued at the end of the ABA flow**, after the accountable owner and execution plan exist, which is also where owner, execution window, preconditions and rollback come from. This resolves the apparent tension between §37 (owner/plan after "authorized action") and §32/Manifest 8.7 (owner in the package).

---

## 2. Current-state inventory

### 2.1 ABA schema `approved_business_action` [inventory unless marked]
- **Append-only** (`forbid_mutation`, migration 0106): action versions, steps, constraints, execution plan versions/dependencies/windows, gate evaluations, holds, releases, decision rationales and **modifications**, audit events, publication versions/events, review versions and evidence, assignment versions, authority scopes, attestations, signatures, and others.
- **Mutable headers:** `approved_actions` (status draft/active/completed/cancelled/superseded, **changed in place with no transition guard**), `action_execution_plans`, `action_control_gates`, `approval_decisions` (status frozen once decided by trigger; other columns not frozen), `approver_assignments`, `approval_exceptions`, `aba_publication_packages`.
- `approval_decision_versions` is deliberately not append-only; only a `status` move away from a decided value is blocked.
- RLS: ENABLE + FORCE on all tables, scope = tenant + workspace (not business).
- `approved_actions`: `decision_id` NOT NULL FK, `action_code` text, status, `latest_version`, `source_recommendation_id` (0170); **no unique on `decision_id`**; no database check that the decision is approved; created only by `ApprovedActionRepository.createAction` (insert, no verification) **[verified: sole production caller is the choice flow, after an approve]**.
- `approved_action_versions`: one free-text `description` (live flow writes the literal `'Approved business decision'`), no jsonb, no hash, no status. `approved_action_steps` (text) and `approved_action_constraints` (operator + jsonb operand) exist, **never written by production code**.
- Execution plans, windows, control gates: schema + repository only; **no production importer, nothing evaluates them**.
- `approval_decision_modifications`: `modification_code` text + `description` text only **[verified]**.
- `aba_publication_packages`: idempotent, lifecycle trigger (draft→ready→dispatched→acknowledged/rejected/revoked), `target_layer` CHECK **only `outcome_monitoring`** **[verified]**; header carries no payload, versions carry a summary text; the live flow never writes a version. Closest precedent for a package lifecycle, but OM-only and payload-less.
- `approval_audit_events`: canonical for approval decision/refusal/expiry (P0-4); `approval_authority_scopes` (`provenance`) canonical for authority grant/revoke (D3).
- Review versions (0175): `risk_class`, `is_time_sensitive`, `valid_until`, `twin_snapshot_id`, `source_recommendation_version_id`. **No simulation reference.**

### 2.2 Business Operations
- BO has **no** intake tables for ABA output, no commands table, no execution table, no ExecutionEvidence store **[inventory]**.
- `OperationalCommandExecutor`: 6 DAL-fed command types, in-memory commands, **`idempotencyKey` accepted but never used** **[verified]**; sole feeder is the DAL intake service (`dal-to-bo:<pkg>:<version>` dedupe through `data_acquisition.publication_deliveries`). It is not an authorized-action path.
- `bo_publication_packages`/`bo_handoff_records` are **outbound BO→BI** (target layers exclude OM/ABA). `tasks`, `workflow_instances` are generic, not ABA-aware.
- BO isolation guard (`boIsolation.architecture.test.ts`): forbids, in BO code roots, references to approved-action tables/repositories, execution plans, control gates, and imports from the ABA layer. `AuthorizedActionPackage` is deliberately not forbidden. **A BO table or column named like `approved_action_id` would trip the guard.**

### 2.3 Eventing (BUILD-33) [inventory]
- Implemented, **no producers/consumers wired**: `events.business_event_ledger` (immutable, idempotency unique on tenant/workspace/source_domain/source_service/idempotency_key, correlation NOT NULL, causation nullable), transport tables (outbox, inbox with `UNIQUE(event_id, consumer_name)`, dead letter, subscriptions, delivery attempts), `BusinessEventEnvelope` + validator, in-memory `BusinessEventContractRegistry` (no contracts registered by default), `CanonicalEventPublisher`.
- No `ACTION_AUTHORIZED`-type contract exists. Existing SQL emit functions write `aba.action.*` outbox events with no TypeScript caller.
- Replay rule: action-like event names require an ABA approval reference and replay is delivery-only (cannot create a new command) — a name-pattern match, not a registry flag.
- The event-contracts tests are not in the CI test filter (BUILD-33 Amendment 1); they were run locally in P0-4 (15 passing).

### 2.4 Legacy / other
- `platform.approved_actions` (`action_type`, `action_payload` jsonb), `platform.decisions`, `platform.outcomes`: SOT-07 legacy surfaces, unused by code, **not to be repurposed**.
- Routes: `POST .../decision-recommendations/:id/choice` creates an ABA review/decision and (if approved) an ApprovedAction; **touches no BO**. `POST .../decision-recommendations/outcome` takes a client `approvedActionId` + `outcomeNotes`, publishes ABA→OM and records a `manual_entry` observation; **touches no BO**.

### OVERLAPS (none usable unchanged)
`approved_actions` family (immutable reference intent, but text-only content, mutable status); `aba_publication_packages` (lifecycle/idempotency precedent; OM-only, payload-less); execution plans/windows/gates (planned window, preconditions; unpopulated); decision/audit/authority tables (approval lineage); review versions (risk/validity/twin facts); ADI recommendation tables (steps, constraints, monitoring requirements; unpopulated by the live flow); OM `monitored_actions`/`action_execution_observations` (overlap the future ExecutionEvidence; text-only); DAL `publication_packages`/`publication_deliveries` (inbound-to-BO precedent); BUILD-33 ledger/outbox/inbox; `platform.*` legacy; `api.idempotency_keys` (HTTP-level only).

---

## 3. Field-to-authoritative-source matrix

Representation rule **[ruling D-6]**: every governed field is `VALUE` (authoritative value exists), `NOT_APPLICABLE` (legitimately does not apply; governed reason preserved) or `UNAVAILABLE` (required source missing). **Any required field `UNAVAILABLE` ⇒ the package is not executable.** No value is fabricated.

Legend — *Author*: who is the authoritative author; *Today*: what exists now; *Gap*: what Block 2+ must provide.

### 3.1 Identity / scope
| Field | Author | Today | Gap / note |
|---|---|---|---|
| `package_id`, `package_version` | ABA issuer | none | new (D-4) |
| `tenant_id`, `workspace_id`, `business_id` | ABA issuer (from verified context) | present on every ABA table | RLS is tenant+workspace only; business scope must be asserted by issuer and BO |

### 3.2 Lineage
| Field | Author | Today | Gap / note |
|---|---|---|---|
| recommendation id/version | ADI | `approved_actions.source_recommendation_id`; review version `source_recommendation_version_id` (0175) | version-level lineage exists |
| review / approval version | ABA | `action_review_package_versions.id`; `approval_decision_versions.id` | the "authoritative approved version" must be pinned by id and covered by the digest |
| approved decision id | ABA | `approval_decisions.id` | |
| approved action id | ABA | `approved_actions.id` (legitimate as a reference) | package references the action **version**, not the mutable row |
| Twin snapshot id | ADI → ABA copy | review version `twin_snapshot_id` (soft uuid) | re-assessable via `assessFreshness` |
| Simulation run id | ADI/SIM → ABA | **not persisted on the review version** | `VALUE` when the decision is simulation-backed, governed `NOT_APPLICABLE` otherwise (D-6); needs a persistence path |
| original proposed parameter set/ref | ADI (where evidence supplies it) | ADI has `recommended_option` text; no structured parameters on the live flow | reference may be `UNAVAILABLE` only if ABA fully authors the set (see 3.4) |

### 3.3 Authorization
| Field | Author | Today | Gap / note |
|---|---|---|---|
| approving actor, assignment, role at decision time | ABA | assignment + `approver_assignment_versions.role_code`; audit detail | |
| authority/provenance reference | ABA | `approval_authority_scopes` (provenance), assignment id | canonical per D3 |
| permission used | ABA | audit detail `permissionUsed` (when route supplies it) | decisions and choice routes both supply it since P0-4 |
| approval timestamp | ABA | decision timestamps / audit `occurred_at` | |
| `risk_class` | ADI-authored, ABA copy | review version (0175) | copy, never recompute |
| approval record / audit reference | ABA | `approval_audit_events` row for the decision | link by id |

### 3.4 Action (ABA-authored per D-1)
| Field | Author | Today | Gap / note |
|---|---|---|---|
| action type/code | ABA (from an action vocabulary) | **none** (`action_code` is a generated string) | vocabulary/ownership decision R-1 |
| target/resource | ABA | **none** | |
| exact effective authorized parameters | ABA | **none structured** (text-only candidates, never written) | **REQUIRED** (D-6); structured capture is the S1/S2 work |
| modification delta + reason | ABA (approver) | `approval_decision_modifications` text only, unwritten | structured delta + reason (D-2) |
| owner (accountable) | ABA (ABA §13: owner id, role, assigned by, time, due date, escalation policy) | **none** (assignment tables are approvers, not owners) | **REQUIRED** before issuance/executability (D-6) |
| execution window | ABA execution plan | `action_execution_windows` (unpopulated) | value or governed applicability semantics |
| automation level | ABA policy gate for levels 2-4 (ABA §17) | none | needs an authoritative ABA policy source; otherwise `UNAVAILABLE` |
| budget | ABA | none | value or governed `NOT_APPLICABLE` |
| preconditions | ABA | `approved_action_constraints`, control gates (unpopulated) | |
| rollback instructions | ABA (ABA §14-15) | none | value or governed `NOT_APPLICABLE` |
| monitoring metrics | ADI requirement → ABA → OM | ADI `decision_monitoring_metrics` and OM `monitoring_plan_metrics` exist, unlinked to the action | source required where monitoring policy requires them |

### 3.5 Validity
| Field | Author | Today | Gap / note |
|---|---|---|---|
| `issued_at` | ABA issuer (database clock) | none | new |
| `valid_until` / package expiry | ABA (bounded by decision `valid_until` and execution window) | review version `valid_until` | package expiry may not exceed the decision's validity |
| freshness state | ABA issuer at issuance; BO/ABA contract at consumption | `assessFreshness`, `evaluateApprovalGate` | re-assessed at issuance and at consumption |
| lifecycle state | ABA lifecycle record | none | section 7 |

### 3.6 Traceability
| Field | Author | Today | Gap / note |
|---|---|---|---|
| `correlation_id`, `causation_id` | ABA issuer | correlation id in audit detail; causation absent | causation of the package = approved decision version / audit event |
| audit reference | ABA | `approval_audit_events` | issuance, revocation and supersession also audited |
| source recommendation/version refs | ADI | present | |
| **integrity digest** | ABA issuer | none | section 5.3 [ruling] |

---

## 4. Issuance preconditions

**Only one component may issue a package: the ABA package issuer** (new, ABA-owned) [proposal; D-4]. `ApprovedActionRepository.createAction` alone is **not** proof and must never be a precondition substitute. The issuer takes **only identifiers** from the caller; everything else is loaded and verified server-side, inside one tenant transaction, with the database clock. No caller-supplied execution authority, parameter or status is trusted.

The issuer must verify, and refuse with a recorded, audited reason otherwise:
1. **Decision state:** the decision is `approved` or `approved_with_modifications` at the **authoritative approved decision version** (pinned by id).
2. **Approval version integrity:** the version the package pins is the one that decided; the effective parameter set captured at decision time matches the package inputs exactly (digest comparison, section 5.3).
3. **Authority was valid at decision time:** the decision's assignment/version and role, from the audit record and assignment version, not the assignment's *current* status.
4. **Risk policy passed:** re-evaluate `evaluateApproval` for that role tier against the persisted `risk_class` (unclassified ⇒ high).
5. **Persisted facts still valid:** re-run the persisted-fact gate on the review version with the database clock: not expired, time-sensitivity known, `valid_until` present when time-sensitive.
6. **Twin reference fresh under current policy:** `assessFreshness` on `twin_snapshot_id` (not stale, verifiable).
7. **Modification governance (D-2):** if `approved_with_modifications`, the original set, the structured delta + reason and the complete final set are all persisted, and fresh relevant evaluation evidence exists for every governance dimension the modification touches (Simulation, risk, constraints, validity, resource requirements, cost, reversibility, expected outcome). **No numeric materiality thresholds are invented.**
8. **Required governed fields (D-6):** accountable owner present; exact authorized parameters present; every other required field is `VALUE` or governed `NOT_APPLICABLE`. Any `UNAVAILABLE` required field ⇒ the package is either refused or issued explicitly non-executable (owner choice, R-4).
9. **Single issuance per decision version:** idempotent on (decision version, package scope); replay returns the existing package.
10. **Everything audited:** issuance (and every refusal) writes an `approval_audit_events` row in the same transaction as the package; ABA §25 fields (action id, decision id, modified parameters, simulation run, model/version) are populated from real sources or recorded `UNAVAILABLE`.

**Defence in depth [proposal]:** a database guard (trigger) rejecting insertion of a package whose decision is not decided, plus an architecture test that only the issuer imports the package repository's insert. Not requested in the rulings; flagged for review.

---

## 5. Immutability and versioning model

**Distinct from `ApprovedAction` [ruling D-4].** Do not repurpose `approved_actions` (mutable status, text-only content, no payload).

### 5.1 Model [ruling D-4, proposal for shape]
- A package is **immutable after issuance, versioned, with append-only lineage.**
- **Supersession produces a new package/version**; it never edits the old payload. **Revocation and supersession never mutate authorized payload fields.**
- Conceptual records (names and columns are a Block 2 decision):
  - package header: identity, scope, lineage anchors, no mutable status column;
  - package versions: append-only; the full authorized payload (structured, versioned schema) + digest;
  - package lifecycle events: append-only (ISSUED, REVOKED, SUPERSEDED, EXPIRED, CONSUMED) with actor, reason, correlation, timestamp.
- All three are append-only (`forbid_mutation`) with RLS on tenant + workspace. State is **derived** from the lifecycle record and the clock.

### 5.2 Structured authorized-action capture (resolves S1) [ruling D-2; shape proposal]
Persist at decision time, immutably: (1) the original proposed parameter set or a reference to it, (2) the structured modification delta + reason, (3) the complete final effective authorized parameter set. The package then copies (3) and references (1) and (2); BO never computes (3) from (1)+(2).

### 5.3 Integrity digest [ruling]
The package carries a **canonical integrity digest** over the authoritative execution-relevant and authorization-relevant fields. It is **tamper evidence only**; it does not replace RBAC, approval provenance or BO validation. Proposal for Block 2: a versioned canonicalization (e.g. `aap-digest/1`: deterministic key order, normalized timestamps and numbers, explicit `UNAVAILABLE`/`NOT_APPLICABLE` encoding) and SHA-256; the exact field set and algorithm are fixed in the Block 2 contract and owner-reviewed.

---

## 6. BO validation contract

BO validates **before** execution and refuses (producing refusal evidence) on any failure. BO **must not**: consume `ApprovedAction` directly; reconstruct authority from ADI/ABA tables; trust browser-supplied package fields; mutate ABA records. (ABA §16: BO "must re-check permissions, rules, automation policy, current state, and safety constraints before execution"; BO §36: execution requires approval, permission, rules compliance, automation policy, safety constraints.)

BO checks (all on the package delivered through the contract, never from ABA tables):
1. **Existence/authenticity:** the referenced `package_id`/`package_version` exists; the **digest recomputes and matches**; the contract/schema version is supported.
2. **Scope:** tenant/workspace/business match the BO request context.
3. **Status:** derived EXECUTABLE — ISSUED, not EXPIRED, not REVOKED, not SUPERSEDED, not already CONSUMED where single-use applies; no required field `UNAVAILABLE`.
4. **Version is current:** no newer superseding package for the same authorized action.
5. **Not expired:** package expiry and execution window respected, on the database clock.
6. **Action type supported** by BO's own capability registry (R-1); unsupported ⇒ refuse.
7. **Parameters match the package exactly;** BO executes only the ABA effective parameter set. Deviations are execution evidence, not silent substitution.
8. **Operational revalidation:** permissions, rules compliance, automation policy, current operational state, safety constraints. BO may refuse; refusal is BO evidence and does not rewrite ABA approval (D-3).
9. **Idempotency/replay:** a BO-side receipt keyed on (package id, version) makes redelivery or replay a no-op; replay is delivery-only and cannot create a second command.
10. **Single use:** where the action is single-use, the receipt marks it consumed atomically with the execution decision.

**Isolation constraints:** the package type and validator live in the shared handoff-contract package (the pattern used by `DALToBOHandoff`), which BO may import; BO code must not import the ABA layer or name ABA tables. The existing isolation guard is **extended, not removed**: BO may reach ABA output **only** through `AuthorizedActionPackage`.

---

## 7. Lifecycle / state model

**Persisted lifecycle facts [ruling D-4]:** `ISSUED`, `REVOKED`, `SUPERSEDED`, `EXPIRED`, `CONSUMED`.
- **`EXECUTED` is not an ABA package state.** Execution truth belongs to BO / `ExecutionEvidence` (ABA §36; Manifest §8.8).
- **`EXECUTABLE` is a derived validation result**, not a persisted state (section 6, check 3).

| From | To | Written by | Notes |
|---|---|---|---|
| (none) | ISSUED | ABA issuer | after all section-4 preconditions |
| ISSUED | REVOKED | ABA, explicit authorised action | reason + actor; payload untouched |
| ISSUED | SUPERSEDED | ABA, when a newer package/version is issued | new package carries lineage to the old |
| ISSUED | EXPIRED | derived from the database clock; recorded on detection (same pattern as P0-4 `approval.expired`, no scheduler) | |
| ISSUED | CONSUMED | recorded from the BO receipt (R-5) | BO never writes ABA tables |

Open sub-questions (section 11): whether `CONSUMED` is a single-use mark or an acceptance mark; how a revoke after consumption is treated (it cannot recall execution; likely an explicit stop instruction handled by BO).

Mapping to spec vocabularies: ABA §5 action states (PENDING_REVIEW … ROLLED_BACK, EXPIRED, STALE) describe the *action*, not the package; BO §16 states (… EXECUTED, FAILED) describe BO's operational approvals. Neither vocabulary is reused as the package state.

---

## 8. Future event handoff (conceptual; no producer or consumer wiring now)

**Rulings [D-5]:** use all three: (1) the canonical ABA `AuthorizedActionPackage` (authorization SOT); (2) a BUILD-33 `ACTION_AUTHORIZED` event referencing package id/version (transport/notification); (3) a BO-side intake/consumption receipt (execution-boundary receipt for idempotency/replay/acceptance tracking, **not** duplicate authorization truth). P0-5 defines, contracts and tests; **P0-6 performs the actual ABA→BO wiring.**

- **Producer:** the ABA issuer, after the package commits (outbox → ledger). **Consumer:** BO intake.
- **Name/domain [proposal, Block 2]:** Manifest §9 gives `ACTION_AUTHORIZED` as an example; the ledger requires `domain.aggregate.verb` names and a `source_domain` from a closed set. ABA sits under the `control_loop` domain in the Manifest ownership matrix, suggesting `control_loop.action.authorized` (aliasing the Manifest name). To be fixed in the Block 2 contract.
- **Payload:** package id, version, digest, scope, correlation/causation, approval reference. **Evidence class** `ACTUAL` (a recorded authorization). The event carries a *reference*; the package remains the authorization record.
- **Correlation/causation:** `correlation_id` carried through; `causation_id` = the approval decision (version) / audit event.
- **Idempotency/replay:** ledger key e.g. `aap:{package_id}:{version}`; consumer dedupe through the inbox `UNIQUE(event_id, consumer_name)`; BO receipt unique on (package id, version). The existing replay rule already requires an ABA approval reference for action-like events and makes replay delivery-only, which is compatible.
- **Registry:** no contract is registered today; Block 2 registers an `ACTION_AUTHORIZED` (and revoke/supersede) contract programmatically. The event-contracts tests should enter the CI filter before the contract is relied on [proposal].
- **Ledger use:** the Manifest says events "should" be used "where appropriate" and is silent on a handoff ledger; D-5 chooses to use the BUILD-33 ledger.
- Status reads: whether BO learns REVOKED/SUPERSEDED by pushed events, by pulling an ABA-owned status contract at execution time, or both is R-10.

---

## 9. Compatibility / legacy findings

| Surface | Classification | Rule |
|---|---|---|
| `platform.approved_actions`, `platform.decisions`, `platform.outcomes` | **Legacy/compatibility only (SOT-07)**; unused by production code | Do not repurpose; retirement only through SOT-02 gates |
| `approved_business_action.approved_actions` + `ApprovedActionRepository` | **Retained as ABA's authorized-action record; not execution authority** | Not the package. Known gaps to close at the issuer, not by changing this table: no approved-decision check on `createAction`, mutable status, no unique(decision_id), no transactional link to the decision |
| `aba_publication_packages` | OM publication only | Not reused for the BO package (OM-only target, payload-less, mutable header); changing its three target-layer guards is not required |
| `POST .../decision-recommendations/outcome` | **Legacy/interim compatibility surface** | Client `approvedActionId` + `outcomeNotes` is not ExecutionEvidence; observations stay manual/unverified; must not satisfy ExecutionEvidence, become VerifiedOutcomeEvidence, authorise OM verification, or enter CL as verified learning evidence. Not removed (SOT-02 gates); debt for P0-5/V-13 |
| `OperationalCommandExecutor` and BO DAL intake | DAL-fed operational ingestion | Not an authorized-action path; not repurposed. Any future package consumption is a separate BO intake |
| `bo_publication_packages` / `bo_handoff_records` | Outbound BO→BI | Not the inbound receipt (wrong direction) |
| ABA standalone block packages under `layers/approved-business-action/blocks` (e.g. contract generation, scope/parameter boundary) | Browser-style assets not imported by the platform | Their documentation lists a contract model (checksum, version, revocation state, issue/expiry) that is consistent with these rulings; they are inputs to Block 2 design, not an implementation |

---

## 10. Migration need assessment

**Assessment: yes — real migrations will be required from Block 2 onward.** Nothing is created or proposed to run now. Numbering follows `MIGRATION-ALLOCATION-POLICY.md` (next free number is **0176**; inspect `main` and open migration-bearing PRs and record the owner before creating any). At least:
1. **Structured authorized-action capture** (S1/S2): complete final effective parameter set, original proposed set/reference, structured modification delta + reason, ABA-authored action type/target/owner/execution boundaries. `approval_decision_modifications` is text-only and cannot hold this.
2. **Package storage:** header, append-only versions (payload + digest), append-only lifecycle events, RLS, `forbid_mutation`, indexes.
3. **BO intake/consumption receipt** in the BO schema (named so as not to trip the isolation guard).
4. Possibly a persistence path for the simulation reference and monitoring-metric linkage, and a source for automation level/policy, depending on rulings R-1..R-4.

Constraints: every one joins the **controlled deployment review** (live Supabase is at **0169**; **0170-0175 are unapplied**; no deployment is authorised). Changing `aba_publication_packages.target_layer` is **not** required by this design.

---

## 11. Decisions required before Block 2 (open; owner to rule)

Rulings D-1..D-7 and the integrity ruling are applied above. The reconciliation raised these further questions; none is decided here.

| ID | Question | Recommendation |
|---|---|---|
| **R-1** | **Action vocabulary.** Who owns the action-type/target vocabulary and how does BO declare which types it supports? (BO §36 lists price change, purchase order, staff reassignment, reorder point, promotion, product disable, maintenance, operating hours; the current executor handles 6 DAL-oriented command types.) | ABA owns the action ontology (ABA-03 block intent); BO owns a capability registry of supported types; "action type is supported" is a BO check. |
| **R-2** | **Accountable owner.** Source and assignment path (ABA §13: owner id, role, assigned by, time, due date, escalation). | New ABA record; required before issuance (D-6). |
| **R-3** | **Automation level policy source** (ABA is the gate for levels 2-4). | An ABA policy source; otherwise `UNAVAILABLE` and not executable. |
| **R-4** | When a required field is `UNAVAILABLE`: refuse issuance, or issue a visibly non-executable package? | Refuse issuance, recording the reason; avoids issued-but-useless packages. |
| **R-5** | `CONSUMED` semantics and who records it (BO must not mutate ABA): single-use mark vs acceptance mark; recorded by ABA from the BO receipt event; treatment of revoke after consume. | ABA derives CONSUMED from the BO receipt event; revoke-after-consume is a BO stop instruction, not a state change. |
| **R-6** | **Package expiry** rule: `min(decision valid_until, execution window end, explicit expiry)`, derived from the clock, recorded on detection (no scheduler). | Adopt, mirroring P0-4 Block 2. |
| **R-7** | **Material-modification detection** without numeric thresholds: action-type definitions declare which governance dimensions each parameter influences; a modified parameter that touches a dimension requires fresh evidence for that dimension. | Adopt as the mechanism for D-2. |
| **R-8** | Issuer defence in depth (DB guard + architecture test that only the issuer inserts). | Adopt. |
| **R-9** | Physical placement: new tables in `approved_business_action`, BO receipt in `business_operations`; handoff types and validator in the shared handoff-contract package. | Adopt. |
| **R-10** | How BO learns current package status: pull an ABA-owned status contract at execution time, push revoke/supersede events, or both. | Both; the pull is authoritative at the moment of execution. |
| **R-11** | Put the event-contracts tests into the CI filter before relying on the `ACTION_AUTHORIZED` contract. | Adopt. |

**Locked-spec position [ruling D-7]:** no amendment is required. STOP again if implementation requires moving recommendation authority into ABA, authorization authority into BO, omitting Manifest-required package semantics, creating dual execution authority, or changing the locked chain.

---

## 12. Owner rulings recorded (2026-10-08)

- **D-1 Split authorship.** ADI: recommendation intent, recommended option, proposed parameters where governed evidence supplies them, alternatives/evidence/risk/confidence/simulation lineage. ABA: final exact authorized action (selected action, exact effective authorized parameters, modification delta, execution boundaries/conditions, accountable owner, approval/governance lineage). The package uses the ABA-authorized effective parameter set; BO never reconstructs from ADI.
- **D-2 `approve_with_modifications`.** Persist (1) original proposed set/reference, (2) structured modification delta + reason, (3) complete final effective authorized set; prose-only insufficient; execution-affecting modifications re-run affected governance checks and require fresh relevant evaluation before issuance; no invented numeric thresholds.
- **D-3 Authority split.** ABA authorizes execution of an ADI-originated decision; BO is operational executor/truth owner; BO §16 approval engine covers BO's ordinary operational approvals and does not re-authorize the ADI decision; BO revalidates and may refuse; refusal does not rewrite ABA approval and becomes BO evidence.
- **D-4 Package model.** Distinct `AuthorizedActionPackage`; not `ApprovedAction`; immutable, versioned, append-only lineage; supersession = new package/version; lifecycle facts ISSUED, REVOKED, SUPERSEDED, EXPIRED, CONSUMED; no EXECUTED state; EXECUTABLE derived; revoke/supersede never mutate authorized payload.
- **D-5 Handoff.** Canonical package + BUILD-33 `ACTION_AUTHORIZED` event referencing id/version + BO-side intake/consumption receipt. P0-5 defines/contracts/tests; P0-6 wires. No producer/consumer wiring until authorised.
- **D-6 Missing fields.** `VALUE` / `NOT_APPLICABLE` / `UNAVAILABLE`; `UNAVAILABLE` ⇒ not executable; accountable owner and exact parameters required; automation level needs an authoritative ABA policy source; budget, rollback, execution window value or governed `NOT_APPLICABLE`; monitoring metrics where policy requires; simulation reference may be governed `NOT_APPLICABLE`; nothing fabricated.
- **D-7 Locked spec.** No amendment required now; STOP conditions as listed in section 11.
- **Package integrity.** Canonical integrity digest over authoritative execution- and authorization-relevant fields; tamper evidence only.

---

## 13. Standing prohibitions (unchanged)
No ABA→BO wiring (P0-6, last, flagged off, explicit approval to enable); no override path; no owner-authority backfill; no fabricated legacy time-sensitivity values; no locked-spec edits; no live migration apply without explicit authorisation (live Supabase at 0169, 0170-0175 unapplied); no migration 0176 without demonstrated need and authorisation; no scheduler; weakening none of P0-1..P0-4.
