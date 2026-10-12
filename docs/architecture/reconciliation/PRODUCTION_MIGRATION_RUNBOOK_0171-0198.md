# Controlled production migration runbook: 0171-0198 (Hetzner VM infinicus-prod-01 / Docker Compose) - PREPARED, NOT EXECUTED

Status: **prepared for owner review. Nothing in this document has been run. Production writes are not authorised by it.** Every step that writes is marked **[WRITE]** and needs the owner's explicit go-ahead for that run. Activation of execution is outside this runbook.

Basis: repository `main` after PR #108 (migrations 0001-0198), the Hetzner compose stack in `infrastructure/deployment/hetzner/`, the discovery document `PRODUCTION_TARGET_DISCOVERY_AND_MIGRATION_READINESS.md`, and the read-only discovery script `production-readonly-discovery.sh`. **Production runtime facts are still unverified** (no operator output yet), so the entry criteria below are gates, not assumptions: the runbook may only start when all of them are satisfied by real output.

**Verified live state (2026-10-12, see the discovery document section 0):** host Hetzner `infinicus-prod-01`; PostgreSQL 16.15; ledger head **0170**; **pending range 0171-0198 (28 migrations)**; schema fingerprint = canonical 0170 (`38eabb12fde135b5`), no drift, no partial 0171+ state; `app_role` / `admin_role`; P1 PASS. The remaining entry criteria below are still open until their evidence exists.

Roles in this runbook: **Operator** (has the VM) and **Owner** (approves). Commands run on the VM as `deploy` from the directory production actually runs: `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci` (the `$HZ` directory below; "oci" is a legacy directory name, the host is Hetzner - do not rename it; the `hetzner/` directory is not the running one and its compose file differs by `DB_SSL` and the `GIT_SHA` build argument) unless stated.

## 0. Entry criteria (all required; otherwise STOP)
| # | Criterion | Evidence | Stop if |
|---|---|---|---|
| E1 | Production identity confirmed | discovery output: hostname / Hetzner metadata, compose services `postgres api caddy`, `api.infini-cus.com` served by this VM | another database or VM serves production |
| E2 | Ledger understood | discovery: ledger rows, head, every name exists in the repo, no duplicates, no gap | gap, duplicate or unknown name (UNEXPECTED / MISSING) |
| E3 | No schema drift for the reported head | `fingerprint-verdict=MATCHES_REPOSITORY_0170_PG16` (live head 0170; **satisfied by the first run**: production `38eabb12fde135b5` = canonical clean-PG16 0170) - re-check immediately before the window | `NO_REFERENCE_MATCH`, or a hash different from the 0170 reference at the window |
| E4 | Roles are right | `app-role-p1=PASS...`, `app_role` is `LOGIN` with no superuser / bypassrls / createdb / createrole, the `api` container's `DATABASE_URL` user is `app_role` (not `admin_role`), `ledger-privileges-app-role` all `f` for `app_role` and PUBLIC | any of these fails (DATABASE AUTHORITY HARDENING INEFFECTIVE / LEDGER EXPOSED) |
| E5 | Activation is zero | `execution_capability_activations` absent or 0 rows; `event_subscriptions` for `bo.authorized_action_intake` = 0; no worker container, or stopped | any activation row or running worker |
| E6 | Append-only compatibility | no cron / timer / script / container command touches `audit.audit_events`, `inventory_movements`, `purchase_receipts`, `purchase_receipt_lines` (discovery section 9) | a dependency is found |
| E7 | Currency | the deployed build supplies `currencyCode`: the deployed checkout contains Data-capture Block C (`2bbac7a`, #78) - check `git -C /opt/infinicus/repo merge-base --is-ancestor 2bbac7a HEAD && echo contains-block-C` and `purchase_orders` has no rows written without currency | an older publisher is active |
| E8 | Deployed build identified and clean | `repo-head` known, `repo-dirty` empty | unknown or dirty checkout |
| E9 | Disk | free space on the Docker data volume >= `max(5 GB, 3 x database size)`; `df -i` healthy | less |
| E10 | Backup tooling | PostgreSQL 16 `pg_dump`/`pg_restore` available in the `postgres` container; an off-host destination (Hetzner Storage Box or S3) reachable by the operator | none available |
| E11 | Recovery path exists | owner has confirmed the Hetzner server backup / snapshot option is enabled or a snapshot will be taken in step B3 | neither |
| E12 | The exact commit to deploy is fixed | one reviewed `main` SHA, recorded in the change record; its CI is green | moving target |
| E13 | Follow-up hardening PR merged (recommended, not blocking) | `/v1/health` reports the SHA; redeploy docs include `grant-app-role.sh` | - |
| E14 | Window and people | quiet period, Owner reachable, second operator reading along | - |

## 1. PRECHECK (read-only)
1. Record the change: date/time (UTC), target SHA `<SHA>`, operator, owner approver.
2. Run the discovery script and keep the full output: `bash <repo>/infinicus-platform/infrastructure/deployment/scripts/production-readonly-discovery.sh 2>&1 | tee pre-migration-$(date -u +%Y%m%dT%H%M%SZ).txt`.
3. Evaluate E1-E12 against that output. Any red = STOP and report; do not "fix forward" inside the window.
4. Capture `docker compose images`, the API image id and `git rev-parse HEAD` as the **rollback identity** (section 6).

## 2. BACKUP **[WRITE: creates files / a scratch database only, never alters production data]**
Quiesce first so the backup equals the pre-migration state: **B0** `docker compose stop api` (stops writes; Caddy then returns 502 - this is the maintenance window; the event worker is not running). Confirm `docker compose ps` shows `postgres` healthy and `api` stopped.
- **B1 Logical dump (from the `postgres` container, PostgreSQL 16 client = server):**
  `mkdir -p /opt/infinicus/backups && docker compose exec -T postgres pg_dump -U admin_role -d infinicus -Fc > /opt/infinicus/backups/pre-0170-$(date -u +%Y%m%dT%H%M%SZ).dump`
- **B2 Validate:** `pg_restore --list <dump> | wc -l` (>0; ~8,800 entries for a fully migrated schema, fewer at an older head), `sha256sum <dump>` recorded in the change record, size plausible against the discovery database size.
- **B3 Server-level layer:** take a Hetzner snapshot or confirm the latest automatic backup time in the Cloud Console (record id and time).
- **B4 Off-host copy:** copy the dump and its checksum to the Storage Box / S3 target and verify the checksum there.
- **B5 Restore proof (mandatory):** `docker compose exec -T postgres createdb -U admin_role -O admin_role infinicus_restore_proof`, then `docker compose exec -T postgres pg_restore -U admin_role -d infinicus_restore_proof --exit-on-error < <dump>` (exit 0), then compare the fingerprint of the proof database with production's: run the discovery script's SQL against `infinicus_restore_proof` (set `DB_NAME=infinicus_restore_proof`) - the verdict and the ledger summary must equal production's. Then `dropdb -U admin_role infinicus_restore_proof`. This exact procedure was rehearsed locally on PostgreSQL 16: a dump of a fully migrated database restores with exit 0 and an identical fingerprint verdict (`MATCHES_REPOSITORY_0198_PG16`). *Do not proceed unless B1-B5 all succeeded.*

## 3. MIGRATION **[WRITE]**
1. `cd /opt/infinicus/repo && git fetch origin && git checkout <SHA> && git status --porcelain` (must be clean; record `git rev-parse HEAD` = `<SHA>`).
2. Build the image at that commit (no containers are replaced yet): `cd $HZ && docker compose build` (`GIT_SHA=<SHA>` only takes effect once the running `oci` compose carries the `GIT_SHA` build argument - until then `/v1/health` keeps reporting `unknown`; record the deployed SHA from `git rev-parse HEAD` and `docker compose images`).
3. Run the migration gate as the owner role: `docker compose run --rm tools` - the gate takes an advisory lock and applies, in filename order and each file in its own transaction, every migration not in the ledger. For the live head of 0170 the exact expected order (28 files) is:
   0171_create_da_webhook_token_lookup, 0172_create_business_event_ledger, 0173_harden_eventing_scope, 0174_add_adi_recommendation_risk_validity, 0175_add_aba_review_version_snapshot, 0176_create_authorized_action_packages, 0177_create_authorized_action_capture, 0178_create_action_governance, 0179_create_authorized_action_boundaries, 0180_create_bo_authorized_action_intake, 0181_audit_events_append_only, 0182_create_bo_inventory_policy_evaluations, 0183_add_explicit_currency_to_inventory_costs, 0184_inventory_movements_append_only, 0185_create_business_currency_declarations, 0186_force_rls_inventory_movements, 0187_require_positive_inventory_unit_cost, 0188_freeze_decided_approval_decisions, 0189_add_inventory_reorder_policy_state, 0190_add_outbox_claimed_at, 0191_create_bo_authorized_action_executions, 0192_guard_inventory_reorder_fields, 0193_align_execution_mutation_result_vocabulary, 0194_create_om_action_execution_verifications, 0195_create_bo_execution_capability_activations, 0196_harden_database_authority_activation_and_reorder, 0197_create_purchase_receipt_lines, 0198_link_purchase_order_lines_to_inventory_items. (A head other than 0170 starts after it.) **Staged verification:** after each `done` (or after the whole run) the combined fingerprint can be compared with `production-discovery/migration-fingerprint-chain.pg16.txt`, which lists the clean-PG16 hash after every migration 0170-0198; a hash that is not the expected one for the last applied file is a stop condition.
4. **Stop conditions during the gate:** an `apply` line without its `done`; any non-zero exit; "Migration gate FAILED". Do **not** re-run blindly and do **not** edit a file. Each file is atomic, so the schema is at the last `done` file. Report, then decide with the Owner: fix forward with a new migration, or restore (section 6).
5. Expected duration on the volumes observed in development: under a minute (the only rewrite is the 143-row outbox table in 0173).

## 4. GRANTS **[WRITE]**
1. `docker compose run --rm --entrypoint bash tools infrastructure/database/scripts/grant-app-role.sh` (the `tools` service already sets `ADMIN_DATABASE_URL` and `APP_ROLE=app_role`). It must end with the line `Withheld direct writes of activation rows and protected reorder columns from app_role.` **This step is mandatory after 0196** and is missing from the current redeploy instructions (follow-up PR).
2. Verify with the discovery script (read-only): `app-role-p1=PASS_...`; `ledger-privileges-app-role` all false; `governed-functions`: `record_execution_capability_activation` and `apply_inventory_reorder_policy` owned by `admin_role`, `prosecdef=t`, `search_path` pinned, `app_role_exec=t`, `public_exec=f`; `protected-tables-app-role`: `execution_capability_activations` INSERT/UPDATE/DELETE/TRUNCATE all `f`; `protected-columns-app-role`: `reorder_point`, `reorder_quantity`, `reorder_policy_state` `f`, `quantity_on_hand` `t`; `rls-flags` as expected (RLS enabled; FORCE where migrated); `fingerprint-verdict=MATCHES_REPOSITORY_0198_PG16`; ledger summary `198` rows, head `0198_...`.
3. STOP if any of these differ. The API is still stopped, so nothing is exposed.

## 5. DEPLOYMENT **[WRITE]**
1. `docker compose up -d api caddy` (api now runs the image built at `<SHA>`; `DATABASE_URL` uses `app_role`). Do **not** start the `event-worker` profile.
2. Wait for `docker compose ps` to show `api` healthy; `docker compose exec -T api wget -qO- http://localhost:3000/v1/ready` -> `{"status":"ready",...}`; externally `curl -s https://api.infini-cus.com/v1/ready`.
3. Worker: **deployed OFF** means *not started*. If the Owner wants the worker container present later, that is a separate change with its own variables, discovery role, `INFINICUS_EXECUTION_KILL_SWITCH` engaged, and verification that it idles.

## 6. POSTCHECK (read-only; reuse the discovery script)
Migration head and count (198, `0198_link...`); fingerprint verdict; RLS flags; role and privilege assertions (section 4.2); `execution_capability_activations` = 0; `events.event_subscriptions` for `bo.authorized_action_intake` = 0; no `event-worker` container; `/v1/ready` and `/v1/health`; `sessions-by-role` shows the API connecting as `app_role`; Caddy logs show no 5xx burst; connection count well under `max_connections`; outbox has no `control_loop.*` rows pending; tenant isolation, login and a read endpoint verified through the public site (read-only smoke, section 26 of the discovery document). **No mutating smoke test without a separate authorisation** (write-path checks run in a scratch copy restored from the section 2 dump).

## 7. ROLLBACK / RECOVERY
| Situation | Action |
|---|---|
| Gate failed on file N | Schema = state after file N-1; API still stopped. Owner decides: fix forward (new migration) or restore |
| Grants verification failed | API stays stopped; re-run `grant-app-role.sh` (idempotent) once; if still wrong, escalate - never start the API with wrong privileges |
| API unhealthy after deploy | `git checkout <rollback SHA>`, `docker compose build api`, `docker compose up -d api` (the previous API on the migrated schema is safe: new columns are nullable/defaulted) |
| Database must be reverted | 0181, 0184, 0186, 0196 and 0197 are **irreversible by migration** (append-only triggers, FORCE RLS, governed-function hardening). Recovery = restore: stop `api`, `createdb infinicus_restored`, `pg_restore` the B1 dump, point the stack at it (rename databases or change the compose database name), run the discovery script on it, start the old API image. Hetzner snapshot restore is the server-level alternative. PITR is **not** available (section 11 of the discovery document) |
| Unexpected execution activity | Engage `INFINICUS_EXECUTION_KILL_SWITCH`, stop the `event-worker` container if one exists, remove the business activation through the governed path; do not delete rows |
| DNS / origin | no change in this runbook; if a replacement VM is ever introduced, revert the `api` A record |
Do not claim any step above is reversible when it is not; the migration tables themselves have no down scripts.

## 8. ACTIVATION
**Explicitly outside this runbook.** Activation needs: this runbook completed and verified; monitoring minimum in place (uptime, disk, connections, dead-letter count/age, worker health, execution refusal/failure visibility); worker deployed with its own discovery role and the kill switch engaged; smoke green; activation rows = 0; kill switch exercised; and the Owner's separate written authorisation.

## 9. Appendix - producing a fingerprint reference for another head (the 0170 reference was produced exactly this way)
On a workstation with PostgreSQL 16: create an empty database, apply `migrations/0001..<head>` in order with `psql -v ON_ERROR_STOP=1 -f`, run the discovery script with `INFINICUS_DISCOVERY_PSQL="psql -h <host> -U <user> -d <db>"` and take the printed `combined-sha256-16` as the reference for `<head>`; compare to production's value, and diff the group rows if they differ. Do not use a database that has been used to run tests (test leftovers change the `public` functions group; this happened once while preparing the 0198 reference and was corrected).
