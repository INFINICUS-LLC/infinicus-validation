# Phase W2 — production window plan, migrations 0202 → 0209 (POS-4 register link, POS-5 tender capture, POS-6c order note, POS-8b printer registry, POS-8c print log) (PLAN ONLY)

> File name kept from the first version of this plan (0202-0206). History: 2026-10-20 0207 (order note) was added; **2026-10-21 0208 (printer registry) and 0209 (print-job log) were added** (this version, which replaces `PHASE_W2_ADDENDUM_0208.md`), so one backup, one gate run and one verification cover all eight migrations.

| Field | Value |
|---|---|
| Date | 2026-10-19; revised 2026-10-21 |
| Status | **PLAN ONLY — the window is NOT authorised.** The earlier blocker (P0, CI on `main` could not go green) is **cleared as of 2026-10-21 03:29 UTC** (section 0). Nothing in this document has been run on production. It becomes executable only when the owner gives an explicit "authorise Phase W2" for a named window and a named release SHA. |
| Builds on | `PHASE_W_WINDOW_PLAN_0199-0201.md` (steps, deploy method, lessons) and `PHASE_W_EXECUTION_RECORD_0199-0201.md` (what actually happened, including the restore proof and the VM reboot) |
| Production now (last verified; NOT re-checked for this revision, there is no production access here) | Ledger 201, head `0201_enforce_om_monitored_action_child_scope_integrity.sql`, fingerprint `61ef99d74289c3b3` (`MATCHES_REPOSITORY_0201_PG16`); API running release `ba02d163a1b574c79844311b8737c73939a2c3dc` (image `f55bbfa6e73a…`); VM rebooted onto kernel 6.8.0-147 on 2026-10-19. W0 re-reads all of this on the day. |
| Data | Test data only (owner statement, 2026-10-19): 6 users, 16 tenants and businesses. The impact of a failure is time, not customers. |

## 0. Finding that blocked the window (2026-10-21) — CLEARED
**CI on `main` has been red since the dependency-vulnerability scan started failing, and that failure makes CI skip everything after it.** The `validate` job's step "Dependency vulnerability scan" fails (3 un-allowlisted vite/launch-editor advisories: GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm; dev toolchain, not part of the shipped runtime), and the steps **after it are skipped: create application role, apply migrations (migration gate), grant, the whole test run**, and the whole `build-and-smoke-test-image` job. Every push run on `main` from #200 (run 489, 2026-10-20 22:30 UTC) to #206 (run 501) ended `failure` this way; the run for #207 was still in progress when this was written.
Consequences: (a) precondition P6 ("CI green on the release SHA") cannot be met; (b) **CI has not run the migration gate or any test against 0208 and 0209** (my local runs did: see section 1) and has not built or smoke-tested the image since; (c) the merged POS-8 work has only local evidence.
**Resolution (2026-10-21):** the owner approved "go allowlist"; PR #209 added three time-boxed entries (tracked with issue #24, review by 2026-11-06) and merged as `ccadbf5`. Push run 505 on `main` (run id 39538090284) then went **fully green**: `validate` success (lint, typecheck, build, secret scan, dependency scan, application role, **migration gate applying 0202–0209 on a fresh database**, grants, the full test step in about 4.5 minutes) and `build-and-smoke-test-image` success (image build, run, smoke test, DAST scan). This is the first CI evidence for 0208 and 0209. The allowlist entries expire for review on 2026-11-06. *Original proposal, kept for the record:* either a time-limited, justified allowlist entry for the three advisories in `infrastructure/deployment/scripts/check-dependency-vulnerabilities.mjs` (the pattern already used for `tinypool`, issue #24), or upgrade vite. *Recommendation:* allowlist now (small, reviewable, same pattern), upgrade vite as its own block. After it merges, the first green push run on `main` is the first CI evidence that migrations 0202–0209 apply and the suites pass; read it before booking the window.

## 1. What is released, and the evidence
- **Eight additive migrations** (each file is its own transaction; none rewrites or backfills data):
  - `0202` adds nullable `business_operations.register_sessions.currency_code` and nullable `platform.orders.register_session_id`, a same-business foreign key (`ON DELETE RESTRICT`), a format check, `UNIQUE (id, business_id)` on `register_sessions`, and an index.
  - `0203` adds `UNIQUE (id, business_id)` on `platform.orders` and the new, empty table `business_operations.order_payments` (16 columns).
  - `0204` adds two indexes on it (4 indexes in total with the primary key and the per-order position key).
  - `0205` enables and forces row level security with one tenant + workspace policy.
  - `0206` makes it append-only (`forbid_mutation` / `forbid_truncate` triggers; `forbid_mutation()` is re-declared identically) and adds the deferred consistency constraint trigger (`order_payments_consistency`).
  - `0207` (POS-6c) adds the nullable `platform.orders.note` text column and the check `orders_note_format` (1 to 500 characters, never a card number). The note is internal, editable only while the order is open, and is printed on the kitchen ticket but not on the customer receipt.
  - `0208` (POS-8b) adds the new, empty table `business_operations.printers` (14 columns, 6 indexes including the two partial unique ones: active name per business, one active default per business and kind; 7 check constraints; RLS enabled; `set_updated_at_printers` trigger). It holds no device address.
  - `0209` (POS-8c) adds the new, empty, append-only table `business_operations.print_jobs` (13 columns, 6 indexes, 6 check constraints, RLS enabled; `forbid_mutation_print_jobs` and `forbid_truncate_print_jobs` triggers using the existing `forbid_mutation()`; **no new function**). It references `platform.orders` and `business_operations.printers`, so **0208 must apply first** (the gate applies in file order). It stores no print content.
- **New API image** carrying POS-1.6 (currency minor units), POS-4 (register link), POS-5 (tender capture), POS-6b (discounts: owner/admin only), POS-6c (order note), POS-8b (printer routes) and POS-8c (print-job and print-route routes). The web counter UI is a separate artifact (section 6, question 1).
- **Candidate release SHA:** the head of `main` at the time the window is authorised (at the time of writing `8307731f400225da6ac5b9b46bf4f590a571f945`, the POS-9a merge, which contains everything above; it will move if more is merged). It must contain all eight migrations and the `REF_0209_PG16` discovery reference, because the window runs the discovery script from the release folder. The exact SHA is named in the authorisation, and CI on that commit (including its push run on `main`) is re-read on the day. **Order of work: resolve P0, merge what is going into the release, then name the SHA.**
- **Evidence produced for this plan (local PostgreSQL 16.15, no production access):**
  - Reference schema fingerprints for heads 0202 … 0209 were generated from clean migrations with exactly the committed `schema-fingerprint.sql` / `function-fingerprint.sql`; the **method is validated each time**: the same procedure, run after dropping the newest table, reproduces the committed previous reference byte for byte (done for 0201, 0207, 0208).
  - Head hashes: 0202 `670efa2071aece99`, 0203 `4754f82304066378`, 0204 `e63dc272f3feb3cc`, 0205 `b1f501d79c6fd600`, 0206 `c0b9988865306004`, 0207 `bbd6bd1f31ad9ea9`, 0208 `c2daa833c2f83c70`, **0209 `325158ea2a54cde9`**. The discovery script and its guard test know all of them. 0208 and 0209 each add exactly one table (and its indexes, constraints, policy, trigger) in `business_operations`; the function fingerprint is unchanged by both.
  - **Logical rollback proven** (Appendix A, extracted from this document's text and run, result in the verification note at the end of the appendix).
  - **Local test evidence** (2026-10-20/21, throwaway PostgreSQL 16, the `ci.yml` sequence: lint, typecheck, build, browser-secret scan, migration gate, grants, filtered turbo test): exit 0 at the 0208 and 0209 steps (API 617 then 632 tests, database 3556, event-worker 231 then 233, web 301 at 0209). **This is local evidence only; CI has not produced it (section 0).**
- **Not rehearsed:** a run of the gate against a restored copy of production, and the old API (`ba02d16`) against the 0209 schema. The second is expected to work because every change is additive, nothing the old API writes touches the new tables, and it ignores the new columns, but that is reasoning, not a test.
- **Compatibility of releases in either order (reasoned, not rehearsed):** the new web counter treats print routing and the print log as best effort (a failed lookup or log call never delays a print), so a web build that reaches an API or database without 0208/0209 still prints; the Printers screen then says "Printers are not available on this server yet". The new **API** must not run before the migrations (W8 after W5), as in Phase W.

## 2. Preconditions (all must be true before the window is authorised)
| # | Precondition | Who | Evidence |
|---|---|---|---|
| **P0** | **The dependency scan passes on `main` (section 0), so CI runs the migration gate, tests and image build again, and the first green push run on `main` exists** | owner decides, Claude implements | run link |
| P1 | Backup key: an offline copy exists (owner stated done, 2026-10-19). The key is **revoked on the laptop but valid on the VM**; the window backup still encrypts to it and the 2026-10-19 backup was restore-proven. Rotation is a separate, later decision | owner | statement |
| P2 | Everything for the release merged; the release SHA named | owner | merge commit |
| P3 | Window booked, operator named (the owner, on the laptop with the SSH key), about 90 minutes | owner | — |
| P4 | Release folder on the VM from an export of exactly the release SHA: `git archive` on the laptop, `scp`, SHA-256 equal on both sides, unpacked next to (not over) `/home/deploy/infinicus-release-ba02d16` | owner | hashes |
| P5 | Release image **built on the laptop** (the VM has 1.9 GB RAM and no swap), `GIT_SHA` set, tagged `oci-api:latest` and `oci-tools:latest`, saved, copied, hash equal, `docker load` on the VM. Before the load, the running image gets `infinicus-api:rollback-pre-0202` (`f55bbfa6e73a…`); the older `infinicus-api:rollback-pre-0199` (`4fba8110ac9c…`) stays | owner | ids |
| P6 | CI green on the release SHA, **including the push run on `main` and the image build/smoke job**, re-read on the day | Claude / owner | run link |
| P7 | Optional, recommended if time allows: gate rehearsal on a restored copy of the newest backup (Phase R method) | owner | — |
| P8 | Every command defines its own variables (`OCI`, `REL`, `C`); SSH reconnects lose them (lesson of Phase W) | operator | — |
| P9 | The daily offsite backup timer has had a confirmed unattended run. **CONFIRMED 2026-10-21 by the owner's read-only output on the VM (03:24 UTC):** `check-backup-freshness.sh` printed `OK: last successful backup 0h ago (infinicus-production/2026-10-21/20261021T023234Z-daily/manifest.json)`; `infinicus-backup.timer` last fired 2026-10-21 02:3x UTC and next fires 2026-10-22; `infinicus-backup.service` exited 0 for both `--check` and `--verify` at 02:32:37 UTC (objects fetched back and verified, manifest uploaded). Not shown by that output: the run of 2026-10-20 (not needed), and a restore proof of this particular backup (the W4 backup of the window gets its own) | owner | output above |

## 3. The window (all steps on the VM as `deploy`, bash)
`OCI=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci`; `REL=/home/deploy/infinicus-release-<sha7>/infinicus-platform`; `C="docker compose -p oci --env-file $OCI/.env -f $REL/infrastructure/deployment/oci/docker-compose.yml"`.

| Step | Action | Pass condition / stop |
|---|---|---|
| W0 | `[READ]` fingerprint hook through the **release** script (`INFINICUS_DISCOVERY_ONLY=fingerprint`), counts, and in a forced read-only session `select count(*) from platform.orders` and `... business_operations.register_sessions` | `MATCHES_REPOSITORY_0201_PG16`; counts equal `production-pre-0202.profile`; the two POS tables empty (if not empty, record the counts and continue only if the owner agrees; 0202 backfills nothing so existing rows get NULL links); any other red → **STOP** |
| W1 | `[READ]` audit v2 (`f-na05-2-om-integrity-audit-v2.sql`) in a forced read-only session (`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`) | every `C` check 0 except the population counts C01/C01c; `K05` two validated rows |
| W2 | `[READ]` record `docker inspect oci-api-1`, `docker compose images`, `/v1/health`; confirm the rollback tag from P5 points at the running image | tag equals the running image id |
| W3 | Quiesce: `$C stop api` | `postgres` healthy, `api` stopped. **Do not stop postgres or caddy by hand** (`unless-stopped` containers stopped manually do not return after a reboot) |
| W4 | Backup: `COMPOSE_DIR=$OCI BACKUP_LABEL=pre-0202-window BACKUP_ENV_FILE=/etc/infinicus/backup.env bash $REL/infrastructure/backups/backup-offsite.sh --check`, then `--verify`; read the manifest back | `BACKUP COMPLETE`, manifest ledger 201, head `0201_…`, fingerprint `61ef99d74289c3b3`, both objects `verified`. Profile for a later restore proof: `production-pre-0202.profile` |
| W5 | Gate from the release image: `$C --profile tools run --rm --no-deps tools`. **Never pipe or truncate the output** | exactly `apply`/`done` for 0202, 0203, 0204, 0205, 0206, 0207, 0208, 0209 and `Migration gate passed.`; an `apply` without `done`, or `FAILED` → **STOP**, read the PostgreSQL server log, no blind retry |
| W6 | Grants: `grant-app-role.sh` from a `postgres:16` container (same command as Phase W; the admin URL is read from `.env` by the shell and never printed) | ends `Withheld direct writes of activation rows and protected reorder columns from app_role.` The new tables also inherit `app_role` privileges from the default privileges set in Phase W; the script is idempotent and re-run for completeness |
| W7 | `[READ]` verify | fingerprint hook → **`MATCHES_REPOSITORY_0209_PG16` (`325158ea2a54cde9`)**; ledger 209, head `0209_create_print_jobs.sql`; `platform.orders.note` exists (text, nullable) with `orders_note_format`, no order carries a note yet; `order_payments`: RLS enabled and forced, 1 policy, 3 triggers (`forbid_mutation_order_payments`, `forbid_truncate_order_payments`, `order_payments_consistency`), 4 indexes, 16 columns, 0 rows; `has_table_privilege('app_role','business_operations.order_payments','TRUNCATE')` false; `orders.register_session_id` and `register_sessions.currency_code` exist; **`printers`: 14 columns, 6 indexes, 1 policy, RLS enabled (not forced, like `register_sessions`), trigger `set_updated_at_printers`, 7 check constraints, 0 rows; `print_jobs`: 13 columns, 6 indexes, 1 policy, RLS enabled (not forced), triggers `forbid_mutation_print_jobs` and `forbid_truncate_print_jobs`, 6 check constraints, 0 rows; `has_table_privilege('app_role','business_operations.print_jobs','TRUNCATE')` false**; audit v2 as W1; counts equal the profile. Any mismatch → **STOP**, decide rollback (§4) with the API still stopped |
| **Stop point** | If W0–W7 passed the database is migrated. The currently running image (`ba02d16`) is expected to work on it (additive change, section 1). If anything about the new API is in doubt, start the tagged rollback image and stop here. | — |
| W8 | `$C up -d --no-deps api` (the API only) | `/v1/ready` 200; `/v1/health` reports the release SHA; external `/v1/ready` ok |
| W9 | `smoke-test.sh` with `EXPECTED_BUILD_SHA=<release sha>`, then the read-only W7 checks again against the running API. **W9b (a test sale and print through the counter) and W9c (add a printer on the Printers screen) are NOT executable in this window as things stand:** the counter (`apps/web`) has no production host (section 6, question 2), and the production API's CORS allows only the origin `https://infini-cus.com`, so a counter run from a laptop (`localhost`) is refused by the browser. They become possible when a web host exists or an allowed origin is arranged (a separate decision); until then the evidence for tender capture, printing records and the registry on production is the migration gate, the W7 catalogue checks, the smoke test and CI's live-database tests, not a user-level test | pass |
| W10 | Close: keep the output without values; a restore proof of the W4 backup is recommended afterwards (same procedure as the Phase W proof) | — |
| W11 | Repoint the daily backup unit to the new release folder: the installed `infinicus-backup.service` runs `backup-offsite.sh` from `/home/deploy/infinicus-release-ba02d16/...` (its template says to repoint after each release). Not urgent, because the old release folder stays on the VM and the script records the schema fingerprint without refusing on a mismatch (read from `backup-offsite.sh`: it only reads and records the ledger count, head and fingerprint; it fails on prerequisites, not on schema version), so backups continue after the migrations; but the old folder's discovery script no longer names the new head, so repoint it to keep the recorded evidence meaningful. A host change: edit the unit with the owner's explicit go, `systemctl daemon-reload`, then `systemctl start infinicus-backup.service` once and read `check-backup-freshness.sh` | `OK` and a manifest whose `ledger_head` is `0209_create_print_jobs.sql` |

Expected API downtime: W3 to W8, minutes (image built in advance).

## 4. Rollback (decision table)
| Situation | Action |
|---|---|
| Gate refuses or a migration fails (W5) | API is stopped. Each file is its own transaction, so the database stands at the last `done` head: fingerprint verdict `MATCHES_REPOSITORY_020X_PG16` for that head. Read the server log. Owner decides: remediate (separate block), roll back with Appendix A (only the blocks for migrations that did apply, in order), or restart the rollback image (works: earlier heads are additive). |
| Verification fails (W7), API stopped | Appendix A, all four blocks in order (returns exactly `MATCHES_REPOSITORY_0201_PG16`, ledger 201), then restart the rollback image. Full restore from the W4 backup only if the schema is in doubt. |
| New API started, defect found (W8–W9) | Start `infinicus-api:rollback-pre-0202`; the database needs no change. Test rows from W9b/W9c are append-only and stay (harmless to the old API). To remove the schema as well, Appendix A drops the new tables and discards those rows; the owner decides. |
| Only the printer/print-log part is the problem | A0a then A0b alone (nothing else depends on them); the POS-4/5/6c schema stays. |
| Data corruption suspected | Restore the W4 backup on a disposable machine first; never over production unverified. |

## 5. Not part of this window
Cloudflare, DNS, secrets, roles, bucket protection, backup-key rotation, Gate D (real identity), the leftover test containers (`infinicus-api-smoke-test`, `infinicus-restore-test-db`), per-product kitchen routing (a later migration 0210), the native device shell and offline mode — each a separate block.

## 6. Questions for the owner (with a recommendation)
1. **P0, the dependency scan (blocks everything).** *Recommendation:* approve a time-limited allowlist entry for the three advisories now (I implement and test it in a small PR), and schedule a vite upgrade as its own block.
2. **Web counter UI hosting — ANSWERED 2026-10-21.** The owner's statement ("I think INFINICUS has no web") and a screenshot of the Cloudflare Workers & Pages list (7 projects) agree with the repository evidence: none of the listed projects serves `apps/web`. They are the echo-grid projects (a different product), `echogrid-feedback-app`, `infinicusv5` (3 months old, no Git connection) and `infinicus-validation` (the legacy static site, Git-connected, last deployment 10 days ago, so it does not pick up current merges). The `infinicus-security-preview` project that comments on pull requests is not in that list (it may live in another Cloudflare account). **Conclusion: the POS counter is not served to anyone in production; this window releases the API and database only, and no live counter can be running against the old API.** The plan stands as written (W9b/W9c dropped); a web host is its own later block (the NA-04 design H1).
3. **Rehearsal (P7).** *Recommendation:* skip it; all eight migrations are additive, empty-table or nullable-column changes, applied from clean in my local runs, with the W4 backup and Appendix A as cover. Do it only if you want the same assurance as Phase W.
4. **W9b/W9c test actions.** Not executable now (see W9). *Recommendation:* accept the catalogue, smoke and CI evidence for this window and run the user-level test when a web host exists.
5. **Release timing.** *Recommendation:* the same quiet-evening pattern as Phase W; about 90 minutes booked, 30 to 40 expected.
6. **Window scope.** *Recommendation:* keep 0208 and 0209 in this window (one backup, one gate); if you would rather release them later, say so and the plan drops back to 0202–0207 (the release SHA would then have to be the POS-6c merge `cdb3fa0`, which is no longer the head of `main`, so a release branch would be needed: more work, so I advise against it).

## 7. Risks and open items
- **P0** (section 0) and the fact that CI evidence for 0208/0209 does not exist yet.
- The daily offsite backup is running unattended (P9 confirmed 2026-10-21), so the window's W4 backup is no longer the only recovery point; it is still the one taken immediately before the change. The unit still points at the `ba02d16` release folder (W11).
- The backup key is revoked on the laptop (accidental import, owner statement); the VM's copy is valid, so backups continue; rotation is pending.
- The old-API-on-0209 behaviour is reasoned, not rehearsed (section 1).
- The VM has little memory headroom (about 600 MB): no builds or heavy work on it.
- 0208 and 0209 enable but do not force row-level security (the pattern of `register_sessions`); `order_payments` forces it (0205). The application role is not the table owner, so the policies apply to it either way; forcing would only matter to the owner role. Left as is, noted for a later hardening block.

## Appendix A — logical rollback of 0202–0209 (API stopped; run as `admin_role`)
Four blocks, run in THIS order when the whole release is rolled back: **A0a** undoes 0209, **A0b** then 0208, **A1** then 0207, **A2** then 0202–0206. Each one alone is valid only if every block above it has already been run (foreign keys and ledger order). All four were extracted from this document's text and run on a scratch PostgreSQL 16.15 database; the fingerprint reached after each is in section 1 (and the result is recorded in the verification note at the end of this appendix).

**A0a — 0209 only** (drops the print log; any rows in it are discarded):
```sql
BEGIN;
DROP TABLE IF EXISTS business_operations.print_jobs;
DELETE FROM _migrations WHERE filename = '0209_create_print_jobs.sql';
COMMIT;
```

**A0b — 0208 only** (drops the printer registry; run only after A0a, because `print_jobs` references it):
```sql
BEGIN;
DROP TABLE IF EXISTS business_operations.printers;
DELETE FROM _migrations WHERE filename = '0208_create_printers.sql';
COMMIT;
```

**A1 — 0207 only** (returns exactly the 0206 schema; dropping the column discards any notes; run only after A0a and A0b):
```sql
BEGIN;
ALTER TABLE platform.orders DROP CONSTRAINT IF EXISTS orders_note_format;
ALTER TABLE platform.orders DROP COLUMN IF EXISTS note;
DELETE FROM _migrations WHERE filename = '0207_add_order_note.sql';
COMMIT;
```

**A2 — 0202–0206** (run only after A0a, A0b and A1)
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

**Verification note (2026-10-21, scratch PostgreSQL 16.15 database, local, no production access).** The four SQL blocks above were extracted programmatically from this document and run in order against a clean 0209 database; the fingerprint after each equals the committed reference byte for byte:

| After | Fingerprint | Equals committed reference | Ledger |
|---|---|---|---|
| (start, clean 0209) | `325158ea2a54cde9` | 0209 | 209 |
| A0a | `c2daa833c2f83c70` | 0208 | 208 |
| A0b | `bbd6bd1f31ad9ea9` | 0207 | 207 |
| A1 | `c0b9988865306004` | 0206 | 206 |
| A2 | `61ef99d74289c3b3` | 0201 | 201 |

Re-running any block on a database that no longer has the objects raised no error (idempotent drops). Re-applying the migrations to that database through the gate printed exactly `apply`/`done` for 0202 … 0209 and `Migration gate passed.` (the W5 expectation). Running A0b before A0a is refused by PostgreSQL (`print_jobs_printer_id_fkey` depends on `printers`), the transaction rolls back and nothing changes, so the order above is enforced by the database, not only by this text. Not proven: the same on a restored copy of production.

## 8. Not done
No production command was run for this plan; no merge, migration, deployment, backup, tag, cleanup, Cloudflare/DNS/secret/role/grant change. The scratch database used for the rollback proof was local and has been deleted.
