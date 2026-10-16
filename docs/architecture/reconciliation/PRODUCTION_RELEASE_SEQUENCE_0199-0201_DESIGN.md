# Production release sequence 0199 → 0201 — DESIGN (not executed, not authorised to execute)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Status | **DESIGN ONLY.** Nothing here has been run. Every step marked **[WRITE]** needs the owner's explicit authorisation for that run. Production, Cloudflare, DNS, secrets, roles and grants are not touched by this document. |
| Scope | Applying migrations **0199** (membership discovery function), **0200** (OM observation / execution-verification scope keys) and **0201** (OM child-table scope keys, PR #147), and releasing an API image that contains the F-NA05-1 guard and `GET /v1/auth/memberships`. |
| Out of scope | Worker activation, `apps/web` hosting, Cloudflare/DNS, legacy retirement, Supabase configuration, Gate D live identity test, any data repair. |
| Evidence labels | `REPO-VERIFIED` read from the repository; `LOCAL-TESTED` disposable PostgreSQL 16 only; `OWNER-REPORTED` stated by the owner, no artefact; `UNKNOWN` not established. |

Builds on: `PRODUCTION_MIGRATION_RUNBOOK_0171-0198.md` (entry criteria, backup, gate, grants, rollback conventions), `OFFSITE_BACKUP_PLAN.md`, `NA-04_RELEASE_READINESS_AND_ISOLATED_TEST_HOSTING.md` §5–§7, `production-readonly-discovery.sh`, `production-discovery/f-na05-2-om-integrity-audit.sql`. Where this document is silent, those runbooks govern.

## 1. Current state and what is unknown
| Item | State | Label |
|---|---|---|
| Repository head | `main` carries 0001–0200 (0199, 0200 merged). 0201 is PR #147 and the 0199 comment fix is PR #148 — both open at the time of writing; the release SHA must be chosen after the owner decides on them. | REPO-VERIFIED |
| Production migration head | 0198 | OWNER-REPORTED (the F-NA05-2 audit run on 2026-10-16 reported head 0198, PostgreSQL 16.15, database `infinicus`) |
| OM population | 3 observations, 3 monitored actions, 0 scope mismatches, RLS enabled and forced | OWNER-REPORTED (audit output not in the repository) |
| Child tables (`monitored_action_versions`, `…_status_history`, execution verifications) | not audited in production | UNKNOWN |
| Running API build | unknown (`/v1/health` reported `version: unknown` before S-3) | UNKNOWN |
| Staging environment | none documented | REPO-VERIFIED |
| Backup + restore proof | owner reports an isolated restore rehearsal; no manifest, timings or tool output in the repository; freshness unknown | OWNER-REPORTED |
| Reference schema fingerprints | exist for 0169, 0170, 0198 only (`production-discovery/`, discovery script constants) | REPO-VERIFIED |
| Application writers of the affected tables | `MonitoredActionRepository` / `OutcomeObservationRepository` unchanged since migration 0185-era code (last commit 0e89d5a, 2026-10-11); they write consistent scope | REPO-VERIFIED |

## 2. What each migration does, and its blast radius
| Migration | Change | Lock / risk | Refuses when | Logical rollback |
|---|---|---|---|---|
| 0199 | `CREATE FUNCTION tenancy.list_active_memberships(uuid)` (read-only, SECURITY DEFINER, EXECUTE revoked from PUBLIC) | no table lock; additive | — | `DROP FUNCTION tenancy.list_active_memberships(uuid)` + delete ledger row |
| 0200 | `UNIQUE (id, tenant_id, workspace_id, business_id)` on `monitored_actions`; composite FKs from `outcome_observations` and `action_execution_verifications`; NOT VALID then VALIDATE | brief locks on 3-row tables (unique build: short ACCESS EXCLUSIVE; FK add: SHARE ROW EXCLUSIVE; VALIDATE: SHARE UPDATE EXCLUSIVE) | **pre-flight**: any orphan/mismatched row → raises with counts only, nothing changes | drop the 2 FKs, then the unique key |
| 0201 | composite FKs from `monitored_action_versions` and `monitored_action_status_history` to the 0200 key | same, tiny tables | **requires 0200's key**; pre-flight counts | drop the 2 FKs |
Rollback order is the reverse of apply order: 0201 FKs → 0200 FKs → 0200 key → 0199 function. Dropping the 0200 key while 0201 FKs exist fails (dependency), which is the intended guard.
Compatibility (LOCAL-TESTED, disposable DBs): the full API/workflow/database/event-worker/BO-runtime/web suites pass at 0201; the old and new writers produce consistent scope, so the old API keeps working against the new constraints. With the old API, a request naming a foreign monitored action now fails at the database (23503 → HTTP 500) instead of writing a cross-scope row; the new API answers 404 before the database is reached.

## 3. Principles
1. **Order is fixed:** backup → migrations → grants → API. (0199 must precede an API that serves `/v1/auth/memberships`, otherwise that route answers 500, never data. 0200/0201 do not depend on the API.)
2. **Nothing is authorised by being listed.** Each [WRITE] step is a separate go-ahead; a failed gate stops the sequence.
3. **No fix-forward inside the window.** A failed gate means stop, report, decide (retry unchanged, fix-forward with a new migration, or restore).
4. **Rehearse on the restored production backup first** (no staging exists). The rehearsal is the substitute for staging and is itself a precondition, not an option.
5. **`deploy.sh` cannot be used for production as written:** its production promotion gate requires a prior succeeded deployment to `staging` for the same version, and no staging exists. Do not edit the gate to get around it; the compose + migration-gate path of the 0171–0198 runbook is used, and the rehearsal evidence replaces the staging prerequisite by an explicit owner decision recorded in the change record.
6. **The migration gate hides the cause of a failure.** After a migration fails after its own `BEGIN`, `migrate.ts` prints "current transaction is aborted…" instead of the real message (pre-existing, unchanged). Read the real refusal text from the PostgreSQL server log (`docker compose logs postgres`), not by re-running.

## 4. Phases

### Phase P — Preparation (no production access; Claude or operator, each needs its own authorisation)
| # | Task | Output |
|---|---|---|
| P1 | Owner decides the release content: include 0201 (PR #147) and the comment fix (PR #148)? Merge decisions are the owner's. | one reviewed `main` SHA `<SHA>`, CI green on it |
| P2 | Generate reference fingerprints on a clean PostgreSQL 16 for heads **0199, 0200, 0201** and add them to the discovery script and `production-discovery/` (the script currently knows 0169/0170/0198 and would report `NO_REFERENCE_MATCH` after the release). A small code/docs block. | `REF_0201_PG16` etc.; chain file extended |
| P3 | Extend the read-only audit to the child tables (counts of orphan and scope-mismatched rows in `monitored_action_versions`, `monitored_action_status_history`; same pattern as C03–C05). Claude drafts, owner runs. | audit v2 |
| P4 | Fix or accept the `packages/authentication` bcrypt timeout flake (no longer-timeout) so CI on `<SHA>` is trustworthy. Optional. | green CI first time |
| P5 | Confirm the current backup tooling state (`backup-offsite.sh --check`, freshness, last `restore-proof.sh` result) — owner evidence. | E10/E11 evidence |
| P6 | Gate C minimum: record what `api.infini-cus.com` currently serves (`/v1/health` version, image id) — the rollback identity. Gates A, B and D are **not** prerequisites for this database/API release; they gate the web work and are tracked separately. | rollback identity |

### Phase R — Rehearsal on a restored production backup (no production writes)
1. **[READ on production, WRITE to the off-VM bucket]** take the pre-release backup exactly as §2 of the 0171–0198 runbook (encrypted, off-VM, manifest + checksum, `--verify`). This is the same backup used in the window if the window opens within the agreed freshness period (default: same day).
2. On the drill machine, run `restore-proof.sh <manifest-key>` → `RESTORE_PROOF=PASS` into a scratch PostgreSQL 16.
3. In that scratch database only: run the audit v2 script (expect all counts 0), then apply 0199, 0200 (and 0201) with the real migration gate and `grant-app-role.sh`, verify with the discovery script's catalog sections, run the audit script again, run the relevant integration suites against it where possible. Record timings.
4. Rollback rehearsal in the scratch database: the logical rollbacks of §2 in reverse order, then re-apply.
5. Exit criteria: all of Section 6 acceptance criteria A1–A8 pass in the scratch database. **Any failure stops the programme before the window.** Also rehearse the refusal path once (inject a violating row in the scratch copy; expect the migration to refuse with counts and the head to stay).

### Phase W — Production window (all steps [WRITE] unless stated; operator on the VM as `deploy`, second operator reading along, owner reachable)
| Step | Action | Pass condition / stop |
|---|---|---|
| W0 | Entry criteria E1–E14 of the 0171–0198 runbook that still apply (identity, ledger, no drift for the reported head, roles, activation zero, disk, checkout clean) re-evaluated from a **fresh** discovery run: `production-readonly-discovery.sh` [READ]. Expect head 0198 and `MATCHES_REPOSITORY_0198_PG16`. | any red → STOP |
| W1 | Read-only audit v2 on production [READ, session forced read-only]. Every check 0. | any non-zero → STOP; owner decides remediation (separate authorisation; observations are immutable, so remediation is a design task, not a window task) |
| W2 | Record state: `git rev-parse HEAD`, `docker compose -p oci images`, current API image id and `/v1/health`; tag the current API image as the rollback image. | recorded |
| W3 | Quiesce: `docker compose stop api` (maintenance window: Caddy returns 502 for a few minutes; the worker is not running). The OM write path is rarely used; the quiesce makes the backup equal the pre-migration state. | `postgres` healthy, `api` stopped |
| W4 | Backup (or confirm the Phase R backup is the post-quiesce state; if any write could have occurred since, take a new one): `backup-offsite.sh --check`, then `--verify` with label `pre-0199-0201`; Hetzner snapshot or latest-backup time recorded. | `BACKUP COMPLETE`, manifest records head 0198; **restore proof already PASS from Phase R for a backup of this state, or run again** |
| W5 | Checkout `<SHA>` (fast-forward only, clean tree); `GIT_SHA=<SHA> docker compose -p oci build api tools`. | clean tree, image built |
| W6 | Migration gate: `docker compose -p oci run --rm tools`. Expect exactly `apply/done` for 0199, 0200 (and 0201). | an `apply` without `done`, or "Migration gate FAILED" → STOP, read the server log, no blind retry (each file is atomic) |
| W7 | Grants: `grant-app-role.sh` via the `tools` service (mandatory after 0199, new function). Ends with the documented message. | message present |
| W8 | Verify [READ]: discovery script (head, ledger count, roles, `ledger-privileges-app-role` all false, governed functions, RLS flags; fingerprint verdict for the new head from P2); audit v2 (all C = 0; K01/K03 show the new constraints validated); function properties (SECURITY DEFINER, STABLE, pinned `search_path`, PUBLIC has no EXECUTE, app role has EXECUTE; app role does not own it). | any mismatch → STOP, decide rollback (§5) with the API still stopped, nothing exposed |
| W9 | Start the API: `docker compose -p oci up -d api caddy` (never the worker). | `/v1/ready` 200; `/v1/health` reports `<SHA>`; OpenAPI lists `GET /v1/auth/memberships`; unauthenticated call → 401; external `https://api.infini-cus.com/v1/ready` ok |
| W10 | Smoke (no live identity needed): the existing smoke script with `EXPECTED_BUILD_SHA=<SHA>`; an unauthenticated outcome-recording request → 401. Gate D (real Supabase identity) is **not** part of the window. | pass |
| W11 | Close: evidence retained (command output without values), change record completed, owner told the result. | — |
Expected API downtime: from W3 to W9 (minutes; dominated by build time if the build is done before W3 — recommended: build in advance with `--no-start`, quiesce only for W3–W9).

### Phase V — Post-release (24 h)
- Watch 5xx rate, `observability.error_events`, `failed_auth`; one repeat of audit v2 after 24 h.
- Any OM request failing with a database FK error from the old pattern must not appear (new API returns 404).
- Gate D, web hosting, worker activation: separate authorisations, not implied.

## 5. Rollback decision table
| Situation | Action |
|---|---|
| Gate refuses (pre-flight) or a migration fails | API still stopped. Read the server log; nothing was changed by the refused file. Owner decides: remediate data (separate block) or abandon the window and restart the API from the rollback image. |
| Migrations applied, verification fails (W8), API stopped | Logical rollback in reverse order (§2) within one maintenance window, or full restore from the W4 backup if the schema is in doubt. Then start the rollback API image. |
| API started, then a defect found | Re-create the rollback image (`up -d` the tagged image); the database needs no change (the constraints are compatible with the old API). |
| Data corruption suspected | Full restore from the W4 backup (recovery point = W4; no writes occurred between W3 and W4). |
Rollback is rehearsed in Phase R; the full restore is proven by `restore-proof.sh`, not by a restore on production.

## 6. Acceptance criteria (every one must hold; evidence is retained)
| # | Criterion | Where checked |
|---|---|---|
| A1 | Production identity confirmed before any write (host, database name, compose services, `api.infini-cus.com` served by this VM) | W0 |
| A2 | Pre-release audit v2 reports 0 violations for observations, execution verifications, versions and status history | W1 and Phase R |
| A3 | A restore-proven off-VM backup of the pre-migration state exists (manifest with head 0198, checksums, `RESTORE_PROOF=PASS`) | W4 / Phase R |
| A4 | Migration ledger head is the intended migration, contiguous, no unexpected rows; the three/five new constraints exist with `convalidated = true` | W6, W8 |
| A5 | Schema fingerprint equals the clean-PG16 reference for the new head | W8 (needs P2) |
| A6 | Application role: no new privileges, cannot own or alter the function; EXECUTE on the function granted by `grant-app-role.sh` only; ledger still not readable by the app role | W7, W8 |
| A7 | Post-release audit v2 still all 0; RLS flags unchanged (enabled and forced where they were) | W8 |
| A8 | API reports the released SHA, `/v1/ready` 200, `GET /v1/auth/memberships` present and 401 unauthenticated; no new 5xx class in the first hour | W9, W10, Phase V |
| A9 | Rollback image tagged and restorable; rollback steps rehearsed in the scratch copy | W2, Phase R |
| A10 | No change to Cloudflare, DNS, secrets, roles, worker or legacy services (diff of the compose project and `.env` is empty) | W11 |

## 7. Owner decisions required before Phase W
1. Release content and SHA (merge #147? #148?), after CI is green on it.
2. Accept rehearsal-on-restored-backup as the staging substitute (and record it), given `deploy.sh`'s staging prerequisite cannot be met.
3. One window for 0199–0201 vs separate windows (recommendation: one window; the three migrations are additive, tiny and independently reversible; separate windows only multiply downtime and backups).
4. Maintenance window length, quiesce policy (recommendation: stop the API for backup-to-start), time, named operators.
5. Who runs audit v2 and in which role (a read-only role or a forced read-only session as in the script header).
6. Whether to harden the authentication test timeout first (P4).

## 8. Risks
- Production facts are OWNER-REPORTED; W0 re-establishes them from tool output and any difference stops the window.
- The child-table state in production is UNKNOWN until audit v2 runs; 0201 refuses to run over violations, so the failure mode is "stop", not "corrupt".
- Backup freshness and restore proof are unverified in the repository (P5).
- Reference fingerprints for the target head do not exist yet (P2); without them A5 cannot be evaluated.
- Single VM, no staging: the rehearsal on a restored backup is the only pre-production execution; it uses production-shaped data on a separate machine and must be treated as production data (access-controlled, destroyed afterwards).
- `deploy.sh`'s audit table (`platform.deployment_events`) is not written by this manual path; the change record is the audit.
