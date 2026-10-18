# Phase R — rehearsal on a restored production backup: detailed design (0199 → 0201)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Status | **DESIGN ONLY.** Nothing here has been run on production or on a drill machine. Every step that writes (to the backup bucket, to a drill machine) needs the owner's explicit authorisation. No production database, Compose, Cloudflare, DNS, secret, role or grant is touched by this document. |
| Parent | `PRODUCTION_RELEASE_SEQUENCE_0199-0201_DESIGN.md` (Phase R). Builds on `OFFSITE_BACKUP_PLAN.md`, `infrastructure/backups/restore-proof.sh`, `production-readonly-discovery.sh`, `production-discovery/` (fingerprint references through 0201, audit v2). |
| Evidence labels | `LOCAL-TESTED` executed on disposable PostgreSQL 16.15 in this repository's CI-mirroring environment; `OWNER-REPORTED`; `UNVERIFIED` (not established — to be established by the rehearsal itself). |

## 1. Purpose, and what the rehearsal can and cannot prove
Because no staging exists, the rehearsal is the only pre-production execution of the migrations against **production-shaped data**. It proves, on a restored copy of the real backup: that the pre-migration state is what we think (profile + fingerprint + audit v2), that 0199→0201 apply cleanly with the real gate and grants, that the result matches the reference fingerprint, that a refusal leaves nothing behind, that the logical rollback returns the schema to exactly 0198, and that the new and old API images start against the migrated schema.

It cannot prove: behaviour under live traffic or lock contention (the copy is idle; the tables are tiny, so lock durations are measured only for the record); the production container build itself (the rehearsal builds a separate image from the same SHA); network, Caddy, TLS or Cloudflare behaviour; that production is unchanged between rehearsal and window (hence W0/W1 re-checks and the migrations' own pre-flight).

## 2. Roles, machines and data handling
| Item | Requirement |
|---|---|
| Operator | runs commands on the VM (backup) and on the drill machine; a second person reads along. |
| Owner | approves each [WRITE] step, supplies the expectations profile counts, holds the private key custody decision. |
| Drill machine | **never the production VM.** PostgreSQL **16.15** (same minor as production; record `server_version`), gpg with the **private** key only while drilling, Docker (to build the same `tools`/`api` images) or Node 20 + pnpm, `psql`/`pg_restore` 16, disk ≥ 3× database size, encrypted disk, no network route to the production database, access limited to named operators. |
| Data classification | The restored database is **production data**, and `roles.sql` restored by `restore-proof.sh` contains production role definitions (password hashes). Treat the whole drill machine and every scratch database as production-sensitive: no copies off the machine, no pasting of values into tickets or chat, evidence files contain counts, hashes of schema only, and statuses — never rows, names, emails, tokens or connection strings. |
| Destruction | At the end (R13): drop every scratch database and role created on the throwaway server, remove decrypted dumps and `RESTORE_GNUPGHOME` private key material, delete build contexts containing `.env`-like files, record the destruction in the evidence record. |

## 3. Preconditions (R0)
1. **Release SHA fixed** (`<SHA>`): a reviewed `main` commit that contains migrations 0199, 0200, 0201 and the P2 references. At the time of writing `main` = `4b504d4` carries all of them. CI on `<SHA>` is green (note: check GitHub, do not infer).
2. **P5 backup evidence** (owner): `backup-offsite.sh --check` passes on the VM; bucket reachable; a read-capable credential held **off the VM** for the drill machine; private key available on the drill machine.
3. **P6** (owner): running API image id and `/v1/health` version recorded (rollback identity) — needed in R8 for the old-API compatibility step.
4. **Expectations profile for the new backup — a reviewed repository change (small block, needs authorisation):** `restore-proof.sh` defaults to `expectations/production-pre-0171.profile` (ledger head 0170), which a head-0198 backup would fail by design. A new profile `production-pre-0199.profile` is required with: `ledger_count=198`, `ledger_head=0198_link_purchase_order_lines_to_inventory_items.sql`, `schema_fingerprint=7fd4c419d738de8a` (REF_0198), and the `count <schema.table>=N` / `outbox <type>=N` rules **filled from the owner's fresh read-only production discovery output** (never invented: the 2026-10-16 audit reported 3 observations and 3 monitored actions; all other table counts are `UNVERIFIED` until the discovery run). Pass it with `RESTORE_EXPECTATIONS=…`. Until it exists, R3 cannot return `RESTORE_PROOF=PASS` against the right expectations.
5. **Production identity unchanged since the profile was written** — the backup is taken immediately before R3 (R1) so profile and backup describe the same moment.
6. Agreement that a failed rehearsal stops the programme (Section 9).

## 4. Step plan
Convention: `[READ]` observes only; `[WRITE-bucket]` writes an encrypted object to the off-VM bucket; `[WRITE-drill]` writes only to the drill machine's throwaway server. Nothing below writes to production data.

| Step | Where | Action | Pass condition |
|---|---|---|---|
| **R1** | production VM, `[WRITE-bucket]` | Quiesce is **not** required for the rehearsal backup (the window repeats it). Run `backup-offsite.sh --check`, then `BACKUP_LABEL=rehearsal-pre-0199 backup-offsite.sh` (add `--verify` if the VM credential can read). The tool uses a read-only session and a consistent `pg_dump` snapshot. Also run the read-only discovery script and keep its output (feeds the profile counts). | `BACKUP COMPLETE`; manifest records head `0198_…`, ledger count 198, fingerprint `7fd4c419d738de8a` (anything else → STOP: production is not the state the design assumes) |
| **R2** | drill machine, `[READ]` | Record `psql --version`, `pg_restore --version`, server `version()`, free disk, `docker --version`; confirm no route to the production database host. | versions are 16.x, server 16.15; disk headroom met |
| **R3** | drill machine, `[WRITE-drill]` | `restore-proof.sh <manifest-key> --keep` with `RESTORE_DB_NAME=infinicus_rehearsal` and `RESTORE_EXPECTATIONS=…/production-pre-0199.profile`. | `RESTORE_PROOF=PASS`; ledger, fingerprint (manifest **and** profile), every count rule satisfied; timings recorded |
| **R3b** | drill machine, `[WRITE-drill]` | Freeze the pre-migration state as templates: `CREATE DATABASE infinicus_rehearsal_pre TEMPLATE infinicus_rehearsal;` (no connections may be open) and derive working clones from it: `…_a` (main path), `…_b` (refusal), `…_c` (rollback/repeat). Every later step starts from a clone, so any step can be repeated from the pristine state without another restore. | clones exist; row counts equal on each |
| **R4** | clone `_a`, `[READ]` | (i) fingerprint hook: `INFINICUS_DISCOVERY_ONLY=fingerprint INFINICUS_DISCOVERY_PSQL="psql <_a url>" bash production-readonly-discovery.sh` → verdict `MATCHES_REPOSITORY_0198_PG16`; (ii) audit v2 in a forced read-only session (`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`): every `C0x/C1x` = 0 (`C12b` informational); `K05` empty; identity row shows head 0198. | all checks as stated. A non-zero check is a **finding about production** (report to the owner; the migrations would refuse anyway) |
| **R5** | drill machine, `[WRITE-drill]` | Build the same image the window will use: `docker build -f apps/api/Dockerfile --build-arg GIT_SHA=<SHA> -t infinicus-tools:rehearsal .` from a clean checkout of `<SHA>` (`git status --porcelain` empty). Run the gate against clone `_a` as the **owner role** (`admin_role`; its password exists only on the throwaway server): `docker run --rm --network host -e DATABASE_URL=postgresql://admin_role:…@127.0.0.1:5432/infinicus_rehearsal_a infinicus-tools:rehearsal` (entrypoint = migration gate). | output shows `apply`/`done` for exactly 0199, 0200, 0201 and `Migration gate passed.`; elapsed time recorded |
| **R6** | drill machine, `[WRITE-drill]` | Grants: `docker run --rm --network host -e ADMIN_DATABASE_URL=… -e APP_ROLE=app_role --entrypoint bash infinicus-tools:rehearsal infrastructure/database/scripts/grant-app-role.sh`. | ends with `Withheld direct writes of activation rows and protected reorder columns from app_role.` |
| **R7** | clone `_a`, `[READ]` | Verify (details in Appendix A): fingerprint hook → `MATCHES_REPOSITORY_0201_PG16` (`61ef99d74289c3b3`); ledger count 201, head `0201_…`; audit v2 all 0 and `K05` = two validated rows; row counts equal the profile (migrations add constraints and one function only); function properties (SECURITY DEFINER, STABLE, `search_path=pg_catalog, pg_temp`, no EXECUTE for PUBLIC, EXECUTE for `app_role`, owner is not `app_role`); `ledger-privileges-app-role` all false for `app_role` and PUBLIC. | every item |
| **R8** | clone `_a` | **Compatibility.** (a) New API: start the image built from `<SHA>` with `DATABASE_URL` as `app_role` against clone `_a`; `/v1/ready` 200, `/v1/health` reports `<SHA>`, OpenAPI lists `GET /v1/auth/memberships`, unauthenticated call → 401, an unauthenticated outcome request → 401. (b) Old API: start the rollback image (P6) the same way; `/v1/ready` 200 and `/v1/health` shows the old version (it ignores the new objects). (c) Supporting evidence, not a gate: run the repository integration suites that touch the migrated objects (`f-na05-1`, `f-na05-3`, `f-na05-4`, `na04-memberships`, `routePermissions`, `membership-list-active`, `om-repositories`) against a **second throwaway copy** with a test password set for `app_role` on the throwaway server only; triage any failure as environment (missing fixtures/roles) or migration-caused, and report both. The suites create their own tenants in the scratch copy only. | (a) and (b) as stated; (c) results reported, any migration-caused failure → STOP |
| **R9** | clone `_b`, `[WRITE-drill]` | **Refusal path.** Inject one cross-scope row on the throwaway copy only (a version row whose business differs from its monitored action's; Appendix B), then run the gate. | gate prints `Migration gate FAILED`; **the real message is in the PostgreSQL server log**, not in the gate output (the runner masks it with "current transaction is aborted"); log shows `0200 refused … mismatch=1` (the first pending migration with a violation stops the run); `_migrations` head stays at the last good migration; no new constraint exists |
| **R10** | clone `_c`, `[WRITE-drill]` | **Rollback path.** Apply 0199–0201 with the gate, then run the logical rollback in one transaction (Appendix C), then the fingerprint hook. | verdict `MATCHES_REPOSITORY_0198_PG16` (the schema is back to **exactly** 0198), ledger count 198; then re-apply with the gate and the verdict is `MATCHES_REPOSITORY_0201_PG16` again |
| **R11** | clone `_a`, `[WRITE-drill]` | Idempotency: run the gate a second time. | prints only `skip` lines; no `apply` |
| **R12** | — | Timings and lock notes for the record: restore, gate (per migration), grants, verification; the expected lock durations are milliseconds on tables of this size, observed on an idle copy only. | recorded; not an SLO |
| **R13** | drill machine, `[WRITE-drill]` | **Destruction** (Section 2): drop all `infinicus_rehearsal*` databases and the roles created for the rehearsal, remove decrypted objects, work directories and private key material; record who and when. | recorded |

## 5. Pass / fail and what each result means
Phase R passes only if R3, R4, R5, R6, R7, R8(a)(b), R9, R10, R11 all meet their pass conditions on a rehearsal that used the exact `<SHA>`. Mapping to the release acceptance criteria: A1 (R1/R2 identity), A2 (R4), A3 (R3), A4 (R5/R7), A5 (R7), A6 (R6/R7), A7 (R7), A8 (R8), A9 (R10), A10 (nothing in R touches production configuration).

| Failure | Meaning | Action |
|---|---|---|
| R1 manifest head/fingerprint ≠ 0198 / reference | production is not at the state the design assumes | stop; owner re-discovers; redesign the sequence for the real head |
| R3 mismatch against the profile | the profile (owner counts) or the backup is wrong, or production changed between discovery and backup | stop; correct the profile through review or retake the backup; never relax the profile to get PASS |
| R4 audit non-zero | production data violates the scope rule | stop; report counts/fingerprints; remediation is a separate, owner-authorised block (observations are immutable; there is no repair in the window) |
| R5/R6 gate or grants fail | a migration or tooling defect against real data | stop; read the server log for the real error; fix forward with a new reviewed change, then redo the rehearsal from R3b |
| R7 fingerprint ≠ 0201 reference | drift or different build | stop; compare group-level rows against `reference-0201.pg16.*` |
| R8 old API fails against the new schema | the "old API keeps working" claim is wrong | stop; the release must deploy migrations and API together or be redesigned |
| R10 rollback does not return to 0198 | rollback plan unsafe | stop; the window must not start |
A rehearsal PASS is valid only for: the same `<SHA>`, the same production head (0198) and the same fingerprint at W0. Any change to the SHA, to production's head/fingerprint, or to migration content requires repeating R3b onward (not necessarily R1 if the backup is still the production state, which W0 re-checks).

## 6. Evidence record (retained without values)
For each step: operator, start/end UTC, command line without secrets, exit status, the verdict lines quoted above, counts and the timings. Attach: the manifest key, `RESTORE_TIMINGS`, discovery verdict lines, audit v2 output (counts only), the gate transcript, the server-log line for the refusal, the rollback and re-apply fingerprints, the destruction record. Never attach row content, role definitions, hashes of secrets, or connection strings.

## 7. LOCAL-TESTED facts this design relies on (disposable PostgreSQL 16.15)
- Applying 0199–0201 via the real gate and `grant-app-role.sh` gives combined fingerprint `61ef99d74289c3b3` = `MATCHES_REPOSITORY_0201_PG16`.
- The logical rollback of Appendix C, run in one transaction on a database at 0201, gives `MATCHES_REPOSITORY_0198_PG16` and ledger 198 / head 0198; re-applying with the gate returns `MATCHES_REPOSITORY_0201_PG16`; a further gate run applies nothing.
- With one injected cross-scope version row on a copy at 0200, the gate fails with "current transaction is aborted" in its own output, while the PostgreSQL server log carries `0201 refused: … versions … mismatch=1`; the ledger head stays 0200 and no constraint is created.
- `CREATE DATABASE … TEMPLATE …` produces working clones when no other session is connected to the template.
## 8. UNVERIFIED items the rehearsal itself must establish
Whether production's PostgreSQL minor version equals the drill server's; the exact counts for the new profile; the environment variables the API image needs to start against a database without Supabase configured (R8a: expect identity exchange to answer 503; confirm on the drill machine before relying on it); whether the old API image starts cleanly against the migrated schema (R8b); the time each phase takes on the real data size; that the owner's read credential and private key work on the drill machine.

## 9. Owner decisions and authorisations needed
1. Authorise the small block that adds `production-pre-0199.profile` (values from the owner's discovery output) — and, optionally, a helper script that automates R5–R11 once the manual run has succeeded (a script is not recommended before the first manual run).
2. Authorise R1 (bucket write), name the drill machine and its operator, confirm key custody and the read credential.
3. Provide P5/P6 evidence and the release SHA.
4. Decide whether the rehearsal backup may double as the window backup (it may not, if production writes occurred since: the window re-takes it after quiescing).
5. Accept that a failed rehearsal stops the programme and that the window is a separate authorisation.

## Appendix A — R7 verification queries (run in a forced read-only session on the clone)
```sql
-- ledger
select count(*), max(filename) from public._migrations;                       -- 201 | 0201_enforce_om_monitored_action_child_scope_integrity.sql
-- function properties
select p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
       has_function_privilege('app_role', p.oid, 'EXECUTE') as app_role_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tenancy' and p.proname = 'list_active_memberships';
   -- t | s | {search_path=pg_catalog, pg_temp} | (not app_role) | f | t
-- scope constraints (expect 5 rows: 1 unique + 4 composite FKs, all convalidated)
select conrelid::regclass, conname, convalidated from pg_constraint
 where conname in ('monitored_actions_scope_key','outcome_observations_monitored_action_scope_fkey',
   'action_execution_verifications_monitored_action_scope_fkey','monitored_action_versions_monitored_action_scope_fkey',
   'monitored_action_status_history_monitored_action_scope_fkey') order by 2;
```
Also: the discovery script's `ledger-privileges-app-role` and `governed-functions` sections (read-only) as in the 0171–0198 runbook §4.

## Appendix B — R9 refusal injection (throwaway clone `_b` only, as the owner role)
Insert one `platform.businesses` row in an existing tenant/workspace with a new code, then one `outcome_monitoring.monitored_action_versions` row whose `business_id` is that new business but whose `monitored_action_id` is an existing action of another business (same tenant and workspace; columns as in the F-NA05-4 audit). Expected counts in the refusal text: `versions … mismatch=1`. Never run on production or on the main-path clone.

## Appendix C — logical rollback (single transaction; reverse order; rehearsed)
```sql
BEGIN;
ALTER TABLE outcome_monitoring.monitored_action_status_history DROP CONSTRAINT monitored_action_status_history_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.monitored_action_versions       DROP CONSTRAINT monitored_action_versions_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.action_execution_verifications  DROP CONSTRAINT action_execution_verifications_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.outcome_observations            DROP CONSTRAINT outcome_observations_monitored_action_scope_fkey;
ALTER TABLE outcome_monitoring.monitored_actions               DROP CONSTRAINT monitored_actions_scope_key;
DROP FUNCTION tenancy.list_active_memberships(uuid);
DELETE FROM public._migrations WHERE filename IN ('0199_create_list_active_memberships.sql',
  '0200_enforce_om_monitored_action_scope_integrity.sql','0201_enforce_om_monitored_action_child_scope_integrity.sql');
COMMIT;
```
Rollback is for the rehearsal and, with separate owner authorisation, for the window (Section 5 of the parent design). It changes no data. If rollback is ever needed on production, the preferred route after verification failure with the API stopped is this transaction followed by the fingerprint check; a full restore from the window backup remains the last resort.

## Corrections from the first real run (2026-10-18)
The rehearsal was run on 2026-10-18 (evidence in `P3_RELEASE_READINESS_REPORT_0199-0201.md` §3f). It showed these points in this design are wrong or incomplete:
- **R3:** use the reviewed profile `expectations/production-pre-0199.profile` (counts from the owner's read-only production query); `rehearsal/phase-r-restore.sh` accepts it as `PHASE_R_PROFILE`.
- **R5:** build from the exact commit with a clean checkout. The runtime image contains the built repository; the gate runs as `bash /repo/infrastructure/deployment/scripts/migration-gate.sh`. Never truncate its output.
- **R6:** the API image has no `psql`. Run the unchanged `grant-app-role.sh` from a `postgres:16` container on the same network.
- **R8(a):** the API refuses `NODE_ENV=production` with a loopback or localhost database URL; run the drill with `NODE_ENV=staging` and record that this guard is not exercised. Authentication runs after body validation, so an unauthenticated request with a malformed body returns 400; use a well-formed body to see 401.
- **R8(b):** the production API image carries no commit stamp (`/v1/health` reports `unknown`), so the "rollback image" cannot be reproduced from a SHA. Build the closest known commit (here `130bf5a`) and record that it is unproven; before the window tag the running image.
- **R8(c):** optional supporting evidence; not run on the restored copy in the first run.
- **R9 / Appendix B:** inject an **observation** whose business differs from its monitored action's (0200 checks observations and execution verifications); a version-row mismatch is caught by 0201, not 0200. The refusal text is in the server log as `ERROR:  0200 refused … observations orphan=0, mismatch=1 …`. After the refusal the ledger head is **`0199_…`** (0199 stays applied), the fingerprint verdict is `MATCHES_REPOSITORY_0199_PG16`, and no 0200 or 0201 constraint exists.

