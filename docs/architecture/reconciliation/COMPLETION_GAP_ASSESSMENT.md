# Completion gap assessment against the Master Architecture Guardrail (v1.0)

Date: 2026-10-13. Repo `main` at `97a84f3` (migrations `0001`–`0198`; open PRs: none). **Documentation only.** Nothing was implemented, migrated, deployed, activated, backed up, restored or changed in any environment. No AWS, GPG, role, grant or secret was touched.
Authority applied: `docs/architecture/MASTER_ARCHITECTURE_GUARDRAIL.md` → locked layer specs → cross-layer standards → domain contracts → build specs → implementation. No locked spec was edited.
Method: repository evidence only (documents, migrations, source, test files, `git log`, GitHub PR/CI history). Where this document says a test "passes" it reports what the repository's own documents and CI history state, unless it says it was re-run; **no test was re-run for this assessment**. Production facts are the owner's reports as recorded in `PRODUCTION_TARGET_DISCOVERY_AND_MIGRATION_READINESS.md` §0; they are not independently verified here.

## 0. Vocabulary (these states are not equivalent)
IMPLEMENTED (code exists) → TESTED (automated tests exist and passed in CI per the record) → MERGED (on main) → DEPLOYED (running in an environment) → LIVE-MIGRATED (schema applied to the production database) → ACTIVATED (governed activation ENABLED for a real business) → PRODUCTION-VERIFIED (observed working in production).
**For every criterion below: DEPLOYED = no, LIVE-MIGRATED = no (production is at 0170; 0171–0198 pending), ACTIVATED = no, PRODUCTION-VERIFIED = no.** Only IMPLEMENTED / TESTED / MERGED vary, and are stated per row.
Criterion status words: COMPLETE · PARTIAL · BLOCKED · PARKED · NOT STARTED · NOT APPLICABLE · UNPROVEN.

## 1. Evidence reviewed
- Governance: the guardrail; `BUILD-33-ARCHITECTURE-GUARDRAIL-RECONCILIATION-v1.1.md`; the 12 locked specs under `docs/architecture/locked/` (inventory read, not line-by-line re-verified); `ARCHITECTURE_RECONCILIATION_PLAN.md`; `infinicus-platform/CLAUDE.md`.
- Execution path: `P0-6_PLANNING…`, `P0-6_0` … `P0-6h`, `P0-6d_OUTCOME_MEASUREMENT_AUTHORITY.md`, `FINAL_AUDIT_EXECUTION_PATH.md`, `DATABASE_AUTHORITY_HARDENING_0196.md`, `P0-1`…`P0-5` documents and `OWNER_AUTHORITY_BOOTSTRAP.md`.
- Data capture: `DATA-CAPTURE_*` A–E and follow-ups, `P0-5_B2*` evaluator/rule-set/amendment documents.
- Production/ops: `LIVE_DB_READINESS_REVIEW_0170-0198.md`, `LIVE_ENVIRONMENT_DISCOVERY…`, `PRODUCTION_TARGET_DISCOVERY…`, `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md`, `OFFSITE_BACKUP_PLAN.md`, `infrastructure/backups/`, `PARKED_PRODUCTION_BACKUP_AND_MIGRATION.md` (#114).
- Code searches: `layers/*/src` (each holds one placeholder file); `packages/workflow/src` (ADI recommendation, ABA authoring, twin); `packages/business-operations-runtime`, `outcome-monitoring-runtime`, `event-worker`, `handoff-contracts`; test file names. Migration directory through 0198. PR history #74–#114 (merged; none open); main CI runs through #113 succeeded.
- Not read in full: the 70 reconciliation documents individually, the 12 locked specs line by line, the legacy Stack A tree.

## 2. Completion criteria A–M

| ID | Requirement (Section XXII) | Status | I / T / M | Conf. |
|---|---|---|---|---|
| A | DAL: canonical data enters; governed provenance; required data for the first action available | **PARTIAL** | yes / yes / yes (code-level) | 70% |
| B | BO: canonical truth; one authoritative writer for the first action; transactional safety | **COMPLETE** (code-level) | yes / yes / yes | 85% |
| C | BI/BDT/SIM: evidence and modeled state for the first action; simulation evidence referenceable | **PARTIAL** (owner ruling needed) | yes / yes / yes | 60% |
| D | ADI: governed recommendation for the first action; cannot execute | **PARTIAL** | yes / yes / yes | 75% |
| E | ABA: review/approve, governed parameters, sealed package, revoke/expire/supersede, BO can check authority | **COMPLETE** (code-level) | yes / yes / yes | 85% |
| F | BO execution: intake, receipt, claim, activation, fresh authority, lock, baseline CAS, execution, evidence, retry/recovery end-to-end | **COMPLETE** (code-level); recovery relies on an undeployed worker | yes / yes / yes | 85% |
| G | Events: authorization and executed handoffs durable and idempotent | **COMPLETE** (code-level) | yes / yes / yes | 85% |
| H | OM: execution evidence independently verified; separate from effectiveness; pending/inconclusive fail closed | **COMPLETE** (as scoped by Section XI) | yes / yes / yes | 85% |
| I | CL: no unverified result can enter learning; boundary proven | **COMPLETE** (boundary only, as scoped by Section XII) | yes / yes / yes | 80% |
| J | Security/tenancy: authz and isolation validated; no browser-derived authority; no owner backfill; RLS passes | **PARTIAL** | yes / yes / yes | 65% |
| K | Database: migrations validated; live delta reviewed; controlled runbook; rollback/backup procedure | **PARTIAL / PARKED** | yes / yes / yes | 75% |
| L | Operations: backup/restore validation; observability for execution failures and stranded work; deployment runbook; production closed | **PARTIAL / PARKED** | partial | 70% |
| M | End to end: data → evidence → modeled decision → simulation → recommendation → approval → package → claim → execution → evidence → OM, with negative paths | **PARTIAL** | partial | 80% |

### A — Data Acquisition: PARTIAL
- Evidence: `packages/data-acquisition-runtime`; Block A (#104, migration 0197) DAL `purchase_receipt` → `BusinessIntakeService` → mapper → `record_purchase_receipt` with fail-closed provenance; data-capture B (0187 positive unit cost), C (0183 currency), D (0198 PO-line/item linkage), E (0189 `reorder_policy_state`).
- Missing evidence: no document or test shows that the data the reorder evaluator needs (inventory item/balance, sales or demand history, supplier lead time) can be **ingested end to end** through DAL for a real business; the record shows capture primitives, not a proven ingestion path for that data set. The `layers/data-acquisition` directory is a placeholder.
- Owner decision: none required to state the gap; deciding whether the existing connectors/imports suffice is part of the next-block decision.

### B — Business Operations: COMPLETE (code-level)
- Evidence: `OperationalCommandExecutor` is the only writer of reorder fields (final audit grep); migration 0196 closes F3 at database level (definer function + privilege revocations); executor tests, P0-6c/6e/6f guards, Block D (#105) with 19 mutants killed per its PR record.
- Caveat: the privilege hardening in 0196 only takes effect where the application role is not the function owner (live finding A; production reports P1 PASS, unverified here).

### C — BI / BDT / SIM: PARTIAL
- Evidence: the BO-owned evaluator `inventory-reorder-policy/v1.0.0` (B2a–B2d; owner approval 2026-10-11) supplies action-relevant evidence; `TwinComputationService` / `twinEvidence` in `packages/workflow` model a twin snapshot (inventory delta only). `layers/business-intelligence` and `layers/business-digital-twin` hold placeholders. Simulation: owner-authorised amendment `P0-5_B2c_SIMULATION_NOT_APPLICABLE_AMENDMENT.md` makes the simulation reference a governed `NOT_APPLICABLE` (`NO_APPLICABLE_SIMULATION_MODEL`) for exactly `inventory_reorder_policy_update@1`, compensated by the BO evaluation.
- Missing evidence: no BI report or BDT state specific to reorder policy; no simulation model for inventory reorder exists.
- **Owner decision required:** does the governed `NOT_APPLICABLE` satisfy Section XXII.C and the "simulation" step of XXII.M, or is a reorder simulation model required? (See conflict C-1, section 8.)

### D — ADI: PARTIAL
- Evidence: recommendation persistence, validation and publication (`DecisionRecommendationRepository`, risk and validity facts 0174, `approved_action source_recommendation_id` 0170); ADI/SIM never touch BO (final audit grep); ABA authoring accepts a recommendation and governed parameters.
- Missing evidence: nothing in the repository **produces** a structured `inventory_reorder_policy_update@1` recommendation (reorderPoint/reorderQuantity). `BusinessDecisionRecommendationService` / `deterministicRecommendations` emit free-text decisions (burn rate, churn, pricing…); no `reorder` reference exists in `layers/*/src` or `packages/workflow/src`. The end-to-end test builds its recommendation through `createAbaFixture` (repository fixture). The first action is currently reachable through human-authored parameters in ABA authoring, not through an ADI producer.
- Owner decision: whether Section XXII.D requires an automated producer or accepts a governed human-modified recommendation for the first action. This is the largest evidence-backed gap.

### E — ABA: COMPLETE (code-level)
- Evidence: P0-1 (authority, no self-issue), P0-2 (risk policy), P0-3 (risk class / valid-until), P0-4 (audit/acceptance), P0-5 (`AuthorizedActionPackage`, authoring routes, issuance), P0-6a (execution ports, shared authority rule, status provider), migrations 0176–0178; revoke/supersede/expire/CONSUMED mirror.
- Caveat: P0-4 acceptance recorded one owner confirmation (D3) as outstanding at the time; the repository does not show its closure — UNPROVEN whether it was later confirmed.

### F — BO execution: COMPLETE (code-level)
- Evidence: P0-6c (engine, adapter, executions; 0191/0192), P0-6e (controlled wiring, governed activation; 0195), P0-6f (announcer composition, atomic activation/subscription safety, real e2e), P0-6g (durable stranded-claim recovery), P0-6h (operator recovery control); final audit: conformant, no finding blocks the merged state; 0196 closes F1/F3; F2 retained by owner ruling.
- Caveats: recovery (P0-6g) depends on the event worker, which has no deployment and whose cross-tenant discovery role is documented but not provisioned (F4). Mutations were proven on real PostgreSQL in CI, not in production.

### G — Events: COMPLETE (code-level)
- Evidence: `control_loop.action.authorized@1` and `operations.action.executed@1` through the existing outbox, same-transaction commit with execution evidence, deterministic ids, duplicate-announcement and duplicate-notification tests in the real e2e.

### H — OM: COMPLETE as scoped
- Evidence: P0-6d `ExecutionEvidence` contract, OM `ExecutionVerificationService`; outcome states limited to `EXECUTION_VERIFIED` / `OUTCOME_PENDING` / `OUTCOME_INCONCLUSIVE`; the database refuses outcomes beyond PENDING/INCONCLUSIVE; OM writes nothing to BO. Section XI forbids fabricating `OUTCOME_VERIFIED`; none is produced.

### I — CL: COMPLETE as scoped (boundary only)
- Evidence: V-06 CL fail-closed (platform and root); the final audit: nothing calls the learning gate; `learningEligibility` is derived in `execution-evidence/states.ts` and fails closed; lineage fields exist. Full learning is explicitly later (Section XII). Confidence 80% because I did not re-run the CL guards.

### J — Security / tenancy: PARTIAL
- Evidence: RLS forced on all fact tables, app role not superuser/BYPASSRLS (final audit probes); strict server-side ownership classification with no self-issued authority (P0-1, `OWNER_AUTHORITY_BOOTSTRAP.md`); no owner backfill was performed.
- Gaps: the identity migration (V-04/V-05, Phase 10 item P3-A: INFINICUS-controlled principal ids, server-side token exchange, removal of browser-readable credentials) has **no completion evidence in the repository**; it concerns the legacy Stack A surface and is therefore out of the execution path, but Section XXII.J says "no browser-derived authority" without that qualifier. The final audit did not cover the frontends.
- Owner decision: whether J is limited to the Stack B execution path (then COMPLETE at code level) or includes the legacy browser surface (then P3-A is required before completion).

### K — Database: PARTIAL / PARKED
- Evidence: 198 migrations; hash chain and per-migration fingerprints (`production-discovery/`); production at 0170 fingerprint-matched read-only; `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md` with entry criteria E1–E14 and forward-only rollback (restore from the recorded point); readiness review A–F.
- Open: live findings A–D (section 5), backup and restore proof (parked), the controlled migration itself (parked).

### L — Operations: PARTIAL / PARKED
- Evidence: off-VM backup tooling and restore-proof (merged, tested against local PostgreSQL 16 and a stub AWS client only), freshness check, deployment runbooks for the Hetzner/oci topology, kill switch and fail-closed activation in code.
- Missing: any backup taken, any restore proven, AWS/GPG setup (parked); alerting channel (undecided); **observability for execution failures and stranded work** — `infrastructure/monitoring/` contains only a README and the documents describe operator control but no alert or metric wiring; worker deployment (F4).

### M — End to end: PARTIAL
- Evidence: `apps/api/tests/p0-6f-execution-path.e2e.test.ts` proves, on the production `buildApp` and a real PostgreSQL, the path **ABA authoring → issuance and announcement → BO intake → claim → fresh ABA authority check → execution → evidence and event in one transaction → OM verification**, plus negative paths (no activation, missing subscription, revoked authority, duplicates, concurrency, OM unavailable, stranded claim recovery). P0-6g/6h add recovery tests.
- Missing: the upstream links the criterion names — **data acquisition, BI/BDT evidence, simulation, and an ADI-produced recommendation** — are not part of one test; the recommendation is a fixture and simulation is a governed NOT_APPLICABLE. No such test is run in production or staging.

## 3. Production-readiness matrix (evidence only)

| # | Dimension | State | Basis |
|---|---|---|---|
| A | Repository architecture complete | **PARTIAL** | Criteria B, E, F, G, H, I complete at code level; A, C, D, J partial; owner rulings pending (C-1, C-2, J scope) |
| B | Code implementation complete | **PARTIAL** | Execution path complete; ADI producer for the first action and reorder-specific BI/BDT evidence not present |
| C | Database schema complete | **COMPLETE in the repository** | Migrations 0001–0198; no schema gap for the first action is recorded (this assessment found none; not an exhaustive schema audit) |
| D | Migration readiness complete | **PARTIAL** | Runbook and discovery exist; findings A–D need decisions; entry criteria E1–E14 not all met |
| E | Deployment readiness complete | **PARTIAL** | Runbooks and hardening exist; worker undeployed; F4 role unprovisioned; `oci` compose lacks `GIT_SHA` (parked) |
| F | Backup readiness complete | **NOT COMPLETE (parked)** | Tooling merged; no bucket, key, VM install, backup or restore proof |
| G | Production migration complete | **NO** | Production at 0170; 0171–0198 pending |
| H | Production deployment complete | **NO** | Nothing from this programme deployed after the owner-reported state; unverified application SHA |
| I | Worker operational | **NO** | Not deployed |
| J | Activation ready | **NO** | Activation OFF; preconditions open (G, H, I, F, alerting) |
| K | Outcome measurement ready | **NO (as designed)** | Execution verification only; no governed effectiveness measurement window, baseline or attribution method |
| L | CL learning ready | **NO (as designed)** | Boundary proven in code; learning is out of scope (Section XII) |
| M | Full production validation complete | **NO** | No production verification of any criterion |

## 4. Completed programme blocks (merged)
Execution path P0-6.0 … P0-6h; final audit (#102); migration 0196 (#103, F1/F3); data-capture A (#104), B, C, D (#105), E and follow-ups; evaluator and rule set P0-5 B2a–B2d; live-DB review, environment and production-target discovery (#106–#108); read-only discovery script and runbook (#109); deployment hardening (#110); canonical 0170 fingerprint (#111); backup tooling (#112, #113); parked register (#114). Main CI succeeded on each merge through #113.

## 5. Live-database readiness findings A–D (owner gates; nothing implemented)
Note: the readiness review was written when the Supabase project was assumed to be live. The owner has since ruled production = Hetzner/oci PostgreSQL 16.15 (`admin_role` owner, `app_role` application role, reported P1 PASS). Supabase = development/staging. Each finding is restated against that target.

**A. Application role ≠ SECURITY DEFINER owner.**
- Question: does production's application connect as a role that cannot bypass 0195/0196's governed functions, and has `grant-app-role.sh` run?
- Evidence: owner-reported `app_role` / `admin_role` and P1 PASS; discovery script and `grant-app-role.sh` exist; whether the revocations are applied post-migration is not evidenced.
- Risk if decided wrongly: the application can still write activation or reorder fields directly; "BO is the only writer" holds only by code convention (the original F1/F3).
- Options: (1) accept P1 PASS and run `grant-app-role.sh` as a runbook step after migration (recommended); (2) additionally move function ownership to a dedicated NOLOGIN role (0196 follow-up P3); (3) defer.
- Recommendation: option 1, with the post-migration privilege probe from the runbook as an exit criterion. Confidence 80%.
- Owner decision before migration: **yes** (confirm option and that the probe is mandatory).

**B. EXECUTE grants to `anon` / `authenticated` / `service_role`.**
- Question: do those roles exist in production, and can they execute the governed functions?
- Evidence: the finding came from Supabase defaults. Production is self-hosted PostgreSQL; whether those roles exist there is not evidenced. The runbook still calls for revoking PUBLIC.
- Risk if wrong: low (functions self-protect on tenant setting, `bo:admin` and membership), defence-in-depth only.
- Options: (1) record "not applicable" after a read-only role/ACL check on production (recommended); (2) still revoke from any such roles; (3) for Supabase staging: revoke and confirm the exposed-schemas list.
- Recommendation: option 1 for production, option 3 for staging. Confidence 75%.
- Owner decision before migration: **yes**, to authorize the read-only check and the staging step.

**C. Append-only side effects (0181/0184/0186/0197).**
- Question: does any live job, operator runbook or ad-hoc procedure UPDATE/DELETE `audit.audit_events`, `inventory_movements`, `purchase_receipts`?
- Evidence: owner-reported zero rows in the critical tables; repository code paths only append; `delete-tenant-data.mjs` knows the convention; operator procedures outside the repository are unknown.
- Risk if wrong: a migrated table rejects a legacy maintenance operation; failure is loud, not silent.
- Options: (1) owner attests no such procedure exists (recommended; cheap); (2) grep operator runbooks and cron on the VM (read-only, needs authorization).
- Confidence 70%. Owner decision before migration: **yes** (attestation or authorization of the search).

**D. Currency default (0183).**
- Question: do all purchase-order publishers set `currencyCode` explicitly?
- Evidence: the runtime executor requires it; direct SQL or an older deployed build might not.
- Risk if wrong: rows silently take the 0183 default currency.
- Options: (1) owner confirms no direct-SQL publishers and that the deployed build is current (recommended); (2) add nothing and monitor.
- Confidence 75%. Owner decision before migration: **yes**, cheap attestation. Production purchase-order data is reported empty, which lowers the risk.

## 6. Final-audit scope gaps (classification only; no audit started)
| Area | Class | Evidence and reasoning | Conf. |
|---|---|---|---|
| Live database | **REQUIRED BEFORE PRODUCTION** | Production fingerprint matches 0170; post-migration reconciliation is runbook steps, not yet done (Section XXIV step 3) | 90% |
| Frontend / apps | **REQUIRED BEFORE PRODUCTION** only if J includes the legacy browser surface; otherwise AFTER | Not covered by the final audit; V-05 open (J) | 60% |
| ADI / SIM / LLM internals beyond the execution boundary | **REQUIRED BEFORE PRODUCTION** for the ADI producer once it exists; otherwise OPTIONAL | Boundary verified (grep); internals not audited; the first-action producer is not built | 65% |
| Performance | **OPTIONAL** | Section XXIII excludes optimization without measured need; none measured | 85% |
| Dependency risk beyond the CI allowlist | **REQUIRED BEFORE PRODUCTION (security/readiness audit, Section XXIV step 2)** | 6 allowlisted advisories recorded; no review of their production relevance in the repository | 70% |

## 7. Parked items (#114, preserved exactly; none started)
| # | Parked item | Prerequisite | Owner decision | Production dependency |
|---|---|---|---|---|
| 1 | AWS account, bucket, IAM users | none | resume instruction; Object Lock default | creates the off-VM store |
| 2 | GPG key and recovery copies | none | resume instruction | needed by 5 |
| 3 | AWS + GPG evidence review | 1, 2 | evidence paste | none |
| 4 | Hetzner backup/snapshot evidence | none | evidence paste | informs second layer |
| 5 | VM: AWS CLI v2 + public key | 1–4 | explicit authorization | touches production host |
| 6 | Supervised `--check`, first backup | 5 | explicit authorization | production read-only dump |
| 7 | Independent verification + restore proof | 6 | authorization of drill machine | none on production |
| 8 | External alerting channel | none | channel choice | required before activation |
| 9 | Enable daily timer | 6 and 7 succeeded | explicit | production host |
| 10 | Retention policy approval | none | approval | governs lifecycle rules |
| 11 | Pre-migration backup, migration 0171–0198, grants, deployment, post-checks | 7, 9, entry criteria E1–E14, findings A–D | explicit authorization | **changes production** |
| 12 | `oci` compose `GIT_SHA` parity; identify deployed SHA | none | go-ahead | build identity of production |
Sequencing: the register's dependency order is the only evidence-supported sequence; this assessment adds none.

## 8. Recorded conflicts and ambiguities (not resolved here)
- **C-1 — Simulation.** Guardrail XXII.C ("simulation evidence required by governance can be produced and referenced") and XXII.M (chain includes "simulation") vs `P0-5_B2c_SIMULATION_NOT_APPLICABLE_AMENDMENT.md` (owner-authorised, exact to `inventory_reorder_policy_update@1`: no simulation model exists, governed NOT_APPLICABLE). Not a clean contradiction because the amendment is itself owner governance; ambiguity is whether M requires a real simulation step. Affected: SIM, ABA gates (`AbaAuthoringService`, `packageIssuancePolicy`). Source-of-truth impact: none today. Alternatives: (a) the guardrail accepts governed NOT_APPLICABLE; (b) a reorder simulation model becomes required. Recommended: owner ruling; (a) is consistent with Section XXIII (no speculative abstractions).
- **C-2 — Recommendation producer.** Guardrail XXII.D requires a governed recommendation for the first action; the repository has no producer, only fixtures and human-authored ABA parameters. Gap, not a contradiction (see D).
- **C-3 — BYPASSRLS discovery.** Guardrail XVII: no cross-tenant BYPASSRLS scanning "unless separately authorized". The event worker's `infinicus_worker_discovery` role (`BYPASSRLS`, column-limited SELECT on `events.outbox_events`) comes from the earlier event-backbone specification (`docs/implementation-queue/05-event-backbone-phase-2.md`) and `infrastructure/deployment/event-worker/README.md`, which predate the guardrail. Recovery (P0-6g/6h) widens nothing. Ambiguity: whether that earlier approval counts as "separately authorized". Recommended: owner confirmation before the role is provisioned (F4).
- **C-4 — Browser-derived authority.** Guardrail XIII/XXII.J vs open V-04/V-05 on the legacy Stack A surface (see J). Consistent with XVIII (Stack A retained until cutover), but J's wording is unqualified.
- **C-5 — Stale status.** `ARCHITECTURE_RECONCILIATION_PLAN.md` carried an implementation status line dated 2026-10-07. It is replaced by a pointer in this change; the original is preserved in the plan under "Historical status".
- **C-6 — Locked specs.** Not compared line by line with the guardrail in this block (see section 1). No conflict was found in the parts read; absence of evidence is not proof.

## 9. The next block
See `ROADMAP_STATUS_2026-10-13.md` §4. Summary: **NO NEXT BLOCK AUTHORIZED** at ≥90% confidence. The minimum owner decisions are: (1) ruling on C-1 and on whether D requires an automated producer (together they decide whether criteria C, D, M are closed or what remains); (2) the scope of criterion J; (3) which of the open or parked tracks to resume, if any, before architecture completion. Estimated remaining blocks to architecture completion cannot be stated until (1) and (2) are ruled; if both rulings accept the current design (governed NOT_APPLICABLE, human-authored recommendation, J limited to Stack B), the evidence-backed remaining architecture work is the **criterion A data-ingestion proof** and the **criterion L observability for stranded work** (plus the parked production track, K/L), i.e. about 2 blocks plus the parked track. Confidence in that estimate: 55%.
