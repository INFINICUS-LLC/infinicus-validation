# Phase W2 — production window plan, migrations 0202 → 0206 (POS-4 register link, POS-5 tender capture) (PLAN ONLY)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Status | **PLAN ONLY — the window is NOT authorised.** Nothing in this document has been run on production. It becomes executable only when the owner gives an explicit "authorise Phase W2" for a named window and a named release SHA. |
| Builds on | `PHASE_W_WINDOW_PLAN_0199-0201.md` (steps, deploy method, lessons) and `PHASE_W_EXECUTION_RECORD_0199-0201.md` (what actually happened, including the restore proof and the VM reboot) |
| Production now | Ledger 201, head `0201_enforce_om_monitored_action_child_scope_integrity.sql`, fingerprint `61ef99d74289c3b3` (`MATCHES_REPOSITORY_0201_PG16`); API running release `ba02d163a1b574c79844311b8737c73939a2c3dc` (image `f55bbfa6e73a…`); VM rebooted onto kernel 6.8.0-147 on 2026-10-19 |
| Data | Test data only (owner statement, 2026-10-19): 6 users, 16 tenants and businesses. The impact of a failure is time, not customers. |

## 1. What is released, and the evidence
- **Five additive migrations** (each file is its own transaction; none rewrites or backfills data):
  - `0202` adds nullable `business_operations.register_sessions.currency_code` and nullable `platform.orders.register_session_id`, a same-business foreign key (`ON DELETE RESTRICT`), a format check, `UNIQUE (id, business_id)` on `register_sessions`, and an index.
  - `0203` adds `UNIQUE (id, business_id)` on `platform.orders` and the new, empty table `business_operations.order_payments` (16 columns).
  - `0204` adds two indexes on it (4 indexes in total with the primary key and the per-order position key).
  - `0205` enables and forces row level security with one tenant + workspace policy.
  - `0206` makes it append-only (`forbid_mutation` / `forbid_truncate` triggers; `forbid_mutation()` is re-declared identically) and adds the deferred consistency constraint trigger (`order_payments_consistency`).
- **New API image** carrying POS-1.6 (currency minor units), POS-4 (register link) and POS-5 (tender capture) routes. The web counter UI is a separate artifact (see section 6, question 1).
- **Candidate release SHA:** the merge commit of **this** pull request on `main` (it adds the reference fingerprints for 0202–0206 to the discovery script that the window runs from the release folder; the API code is that of `571a6ea7f02ea8c8934b61dd7b5da7793eb6a86d`, #184, whose PR checks were all `success`: `validate`, `operations-runtime`, `build-and-smoke-test-image`, Cloudflare Pages). The exact SHA is named in the authorisation. **Order of work: merge this PR first, then release from that commit.**
- **Evidence produced for this plan (2026-10-19, local PostgreSQL 16.15, no production access):**
  - Reference schema fingerprints for heads 0202, 0203, 0204, 0205 and 0206 were generated from clean migrations with exactly the committed `schema-fingerprint.sql` / `function-fingerprint.sql`, and the **method was validated first**: the same procedure at 0201 reproduces the committed `reference-0201.pg16.*` files byte for byte (hash `61ef99d74289c3b3`, which is also what production reports).
  - Head hashes: 0202 `670efa2071aece99`, 0203 `4754f82304066378`, 0204 `e63dc272f3feb3cc`, 0205 `b1f501d79c6fd600`, **0206 `c0b9988865306004`**. The discovery script and its guard test know all five.
  - **Logical rollback proven** (Appendix A): applying 0206 and then the rollback script returns exactly the committed 0201 reference (hash `61ef99d74289c3b3`) and removes the five ledger rows.
- **Not rehearsed:** a run of the gate against a restored copy of production, and the old API (`ba02d16`) against the 0206 schema. The second is expected to work because every change is additive and nothing the old API writes touches `order_payments`, but that is reasoning, not a test.

## 2. Preconditions (all must be true before the window is authorised)
| # | Precondition | Who | Evidence |
|---|---|---|---|
| P1 | Backup key: an offline copy exists (owner stated done, 2026-10-19). The key is **revoked on the laptop but valid on the VM**; the window backup still encrypts to it and the 2026-10-19 backup was restore-proven. Rotation is a separate, later decision (see the execution record) | owner | statement |
| P2 | This PR merged; the release SHA named | owner | merge commit |
| P3 | Window booked, operator named (the owner, on the laptop with the SSH key), about 90 minutes | owner | — |
| P4 | Release folder on the VM from an export of exactly the release SHA: `git archive` on the laptop, `scp`, SHA-256 equal on both sides, unpacked next to (not over) `/home/deploy/infinicus-release-ba02d16` | owner | hashes |
| P5 | Release image **built on the laptop** (the VM has 1.9 GB RAM and no swap), `GIT_SHA` set, tagged `oci-api:latest` and `oci-tools:latest`, saved, copied, hash equal, `docker load` on the VM. Before the load, the running image gets `infinicus-api:rollback-pre-0202` (`f55bbfa6e73a…`); the older `infinicus-api:rollback-pre-0199` (`4fba8110ac9c…`) stays | owner | ids |
| P6 | CI green on the release SHA, **including the push run on `main`**, re-read on the day | Claude / owner | run link |
| P7 | Optional, recommended if time allows: gate rehearsal on a restored copy of the newest backup (Phase R method) | owner | — |
| P8 | Every command defines its own variables (`OCI`, `REL`, `C`); SSH reconnects lose them (lesson of Phase W) | operator | — |

## 3. The window (all steps on the VM as `deploy`, bash)
`OCI=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci`; `REL=/home/deploy/infinicus-release-<sha7>/infinicus-platform`; `C="docker compose -p oci --env-file $OCI/.env -f $REL/infrastructure/deployment/oci/docker-compose.yml"`.

| Step | Action | Pass condition / stop |
|---|---|---|
| W0 | `[READ]` fingerprint hook through the **release** script (`INFINICUS_DISCOVERY_ONLY=fingerprint`), counts, and in a forced read-only session `select count(*) from platform.orders` and `... business_operations.register_sessions` | `MATCHES_REPOSITORY_0201_PG16`; counts equal `production-pre-0202.profile`; the two POS tables empty (if not empty, record the counts and continue only if the owner agrees; 0202 backfills nothing so existing rows get NULL links); any other red → **STOP** |
| W1 | `[READ]` audit v2 (`f-na05-2-om-integrity-audit-v2.sql`) in a forced read-only session (`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`) | every `C` check 0 except the population counts C01/C01c; `K05` two validated rows |
| W2 | `[READ]` record `docker inspect oci-api-1`, `docker compose images`, `/v1/health`; confirm the rollback tag from P5 points at the running image | tag equals the running image id |
| W3 | Quiesce: `$C stop api` | `postgres` healthy, `api` stopped. **Do not stop postgres or caddy by hand** (`unless-stopped` containers stopped manually do not return after a reboot) |
| W4 | Backup: `COMPOSE_DIR=$OCI BACKUP_LABEL=pre-0202-window BACKUP_ENV_FILE=/etc/infinicus/backup.env bash $REL/infrastructure/backups/backup-offsite.sh --check`, then `--verify`; read the manifest back | `BACKUP COMPLETE`, manifest ledger 201, head `0201_…`, fingerprint `61ef99d74289c3b3`, both objects `verified`. Profile for a later restore proof: `production-pre-0202.profile` |
| W5 | Gate from the release image: `$C --profile tools run --rm --no-deps tools`. **Never pipe or truncate the output** | exactly `apply`/`done` for 0202, 0203, 0204, 0205, 0206 and `Migration gate passed.`; an `apply` without `done`, or `FAILED` → **STOP**, read the PostgreSQL server log, no blind retry |
| W6 | Grants: `grant-app-role.sh` from a `postgres:16` container (same command as Phase W; the admin URL is read from `.env` by the shell and never printed) | ends `Withheld direct writes of activation rows and protected reorder columns from app_role.` The new table also inherits `app_role` privileges from the default privileges set in Phase W; the script is idempotent and re-run for completeness |
| W7 | `[READ]` verify | fingerprint hook → **`MATCHES_REPOSITORY_0206_PG16` (`c0b9988865306004`)**; ledger 206, head `0206_order_payments_append_only_and_consistency.sql`; `order_payments`: RLS enabled and forced, 1 policy, 3 triggers (`forbid_mutation_order_payments`, `forbid_truncate_order_payments`, `order_payments_consistency`), 4 indexes, 16 columns, 0 rows; `has_table_privilege('app_role','business_operations.order_payments','TRUNCATE')` false; `orders.register_session_id` and `register_sessions.currency_code` exist; audit v2 as W1; counts equal the profile. Any mismatch → **STOP**, decide rollback (§4) with the API still stopped |
| **Stop point** | If W0–W7 passed the database is migrated. The currently running image (`ba02d16`) is expected to work on it (additive change, section 1). If anything about the new API is in doubt, start the tagged rollback image and stop here. | — |
| W8 | `$C up -d --no-deps api` (the API only) | `/v1/ready` 200; `/v1/health` reports the release SHA; external `/v1/ready` ok |
| W9 | `smoke-test.sh` with `EXPECTED_BUILD_SHA=<release sha>`. Optional W9b: the owner takes one test sale in the counter (open register, one order, cash tender), then a read-only check: `order_payments` has one row and `sum(amount_applied)` equals the order total | pass. **A completed payment cannot be deleted afterwards** (append-only); only the tenant-data delete script removes such rows, so do W9b only with a test business |
| W10 | Close: keep the output without values; a restore proof of the W4 backup is recommended afterwards (same procedure as the Phase W proof) | — |

Expected API downtime: W3 to W8, minutes (image built in advance).

## 4. Rollback (decision table)
| Situation | Action |
|---|---|
| Gate refuses or a migration fails (W5) | API is stopped. Each file is its own transaction, so the database stands at the last `done` head: fingerprint verdict `MATCHES_REPOSITORY_020X_PG16` for that head. Read the server log. Owner decides: remediate (separate block), roll back with Appendix A, or restart the rollback image (works: earlier heads are additive). |
| Verification fails (W7), API stopped | Appendix A (one transaction; returns exactly `MATCHES_REPOSITORY_0201_PG16`, ledger 201 — proven on a scratch database), then restart the rollback image. Full restore from the W4 backup only if the schema is in doubt. |
| New API started, defect found (W8–W9) | Start `infinicus-api:rollback-pre-0202`; the database needs no change. If W9b rows exist they are append-only and stay (harmless to the old API). To remove the schema as well, Appendix A drops `order_payments` and discards those test rows; the owner decides. |
| Data corruption suspected | Restore the W4 backup on a disposable machine first; never over production unverified. |

## 5. Not part of this window
Cloudflare, DNS, secrets, roles, bucket protection, backup-key rotation, Gate D (real identity), the leftover test containers (`infinicus-api-smoke-test`, `infinicus-restore-test-db`) and the scheduled-backup check — each a separate block.

## 6. Questions for the owner (with a recommendation)
1. **Web counter UI hosting.** The POS counter pages call the new endpoints. If production web is built from `main` automatically (Cloudflare Pages), it may already show the new UI against the old API. *Recommendation:* tell me how the production web is deployed so the plan can order web and API releases; do not change Cloudflare in this window.
2. **Rehearsal (P7).** *Recommendation:* skip it; the five migrations are additive, empty-table, and ran in CI on clean databases and on the validated scratch copy; the W4 backup plus Appendix A cover the risk. Do it only if you want the same assurance as Phase W.
3. **W9b test sale.** *Recommendation:* do one, in a test business, because it is the only check that proves tender capture on production; accept that the payment row is permanent.
4. **Release timing.** *Recommendation:* the same quiet-evening pattern as Phase W; about 90 minutes booked, 30 expected.

## 7. Risks and open items
- No scheduled offsite backup was found on the VM (only the system `dpkg-db-backup` timer; cron not checked): the window's own W4 backup is the only recovery point, and it is the only scheduled-backup evidence until that gap is checked.
- The backup key is revoked on the laptop (accidental import, owner statement); the VM's copy is valid, so backups continue; rotation is pending.
- The old-API-on-0206 behaviour is reasoned, not rehearsed (section 1).
- The VM has little memory headroom (about 600 MB): no builds or heavy work on it.

## Appendix A — logical rollback of 0202–0206 (API stopped; run as `admin_role`)
Tested on a scratch PostgreSQL 16.15 database after a clean 0206 migration: schema fingerprint afterwards `61ef99d74289c3b3` (equal to the committed 0201 reference), five ledger rows deleted. `forbid_mutation()` is intentionally kept (0206 re-declares it identically to the earlier definition). Dropping `order_payments` discards any payment rows it holds.
```sql
BEGIN;
DROP TABLE IF EXISTS business_operations.order_payments;
DROP FUNCTION IF EXISTS business_operations.check_order_payment_consistency();
ALTER TABLE platform.orders DROP CONSTRAINT IF EXISTS orders_register_session_same_business_fk;
DROP INDEX IF EXISTS platform.idx_orders_register_session;
ALTER TABLE platform.orders DROP COLUMN IF EXISTS register_session_id;
ALTER TABLE platform.orders DROP CONSTRAINT IF EXISTS orders_id_business_unique;
ALTER TABLE business_operations.register_sessions DROP CONSTRAINT IF EXISTS register_sessions_currency_code_format;
ALTER TABLE business_operations.register_sessions DROP CONSTRAINT IF EXISTS register_sessions_id_business_unique;
ALTER TABLE business_operations.register_sessions DROP COLUMN IF EXISTS currency_code;
DELETE FROM _migrations WHERE filename IN ('0202_link_orders_to_register_sessions.sql','0203_create_order_payments.sql','0204_create_order_payments_indexes.sql','0205_create_order_payments_rls.sql','0206_order_payments_append_only_and_consistency.sql');
COMMIT;
```

## 8. Not done
No production command was run for this plan; no merge, migration, deployment, backup, tag, cleanup, Cloudflare/DNS/secret/role/grant change.
