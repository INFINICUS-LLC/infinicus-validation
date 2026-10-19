# Phase W — production window plan, migrations 0199 → 0201 (PLAN ONLY)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Status | **PLAN ONLY — Phase W is NOT authorised.** Nothing in this document has been run. It becomes executable only when the owner gives an explicit "authorise Phase W" for a named window. |
| Builds on | `PRODUCTION_RELEASE_SEQUENCE_0199-0201_DESIGN.md` (W0–W11, rollback table), `PHASE_R_REHEARSAL_DESIGN_0199-0201.md` (with its 2026-10-18 corrections), `P3_RELEASE_READINESS_REPORT_0199-0201.md` §3e–§3f |
| Owner decisions accepted (2026-10-18, "go with your recommendations") | (1) release exactly the rehearsed commit; (2) one window, quiet weekday daytime, 90 minutes booked, second person reading along; (3) rollback image tagged before the window and a fresh verified backup right before the migration; (4) bucket protection understood and credentials treated as full access, ideally before the window; (5) private-key offline copy as a precondition |
| Preconditions status (2026-10-19) | P1, P2, P4, P5 and P6 done (P5 confirmed by the owner on 2026-10-19: "I authorise"); P3 (window date, time, people) open; Phase W itself is not yet authorised |
| Operators | the owner (or a named operator) on the VM as `deploy`, plus a second person reading along. Claude never operates on production; it can read pasted output and advise. |

## 1. What is released, and the evidence
- **Release SHA:** `ba02d163a1b574c79844311b8737c73939a2c3dc`. Rehearsed end to end on a restored copy of the head-0198 backup (§3f of the readiness report). Migrations 0199–0201 are unchanged in later commits, which are documentation only.
- **GitHub CI on that SHA:** the `INFINICUS Platform CI` push run 437 on `main` reports **success** (read from GitHub on 2026-10-18).
- **CI note (not a blocker, an open item):** the push run for the POS-2 merge (`8001509`, run 427) failed in the `Test` step, and so did the PR run for #162, while identical trees passed in other runs. The failing test could not be identified from the retrievable log tail (it held only PostgreSQL server output). Treat the test suite as having an unidentified intermittent failure; the release SHA itself is green.
- **What changes in production:** three additive database migrations (one function, constraints on five outcome-monitoring tables; no column, row, policy or role change) and a new API image. The production API currently runs an image of unknown commit (`sha256:4fba8110ac9c…`, created 2026-10-14 21:34 UTC, `/v1/health` = `unknown`). The new image carries the full difference between that build (most likely `130bf5a`) and `ba02d16`; the rehearsal proved the new API works on the migrated schema and the old API works on it too.

## 2. Preconditions (all must be true before the window is authorised)
| # | Precondition | Who | Evidence |
|---|---|---|---|
| P1 | Private backup key has an **encrypted offline copy** and a **revocation certificate**, stored apart from the laptop; a renewal reminder exists (key expires 2028-10-12) | owner | owner statement; no key material in chat |
| P2 | Owner knows what Hetzner "Enable protection" does; decision recorded (enable or not); the full-access keys (`restore-readonly`, the VM key) are known to be full access. Not a gate for the window, strongly recommended before it | owner | owner statement |
| P3 | Window booked, operators named, second person present, owner reachable; recorded here when known | owner | — |
| P4 | Release folder prepared on the VM from an export of exactly `ba02d163…`. **Done 2026-10-19:** `git archive` on the laptop, `scp` to `/home/deploy`, SHA-256 `5221fdc786a9ef4d9fb2195ef6faa9082178139f4e39db7f8a277a3adfcab098` equal on both sides (7,812,596 bytes), unpacked to `/home/deploy/infinicus-release-ba02d16`; migrations 0199-0201 present; `backup-offsite.sh` hash `e111f447…` equals `main`. `/opt/infinicus/repo` (at `130bf5a`, untracked files) was not touched | owner | hashes |
| P5 | Deploy method (section 3a) checked on the VM: `docker compose config --quiet` with the release compose file and the existing `.env` by path passed (`COMPOSE_CONFIG_OK`), project `oci`, network `oci_default`. **Owner confirmed the method on 2026-10-19** ("I authorise"; this confirms the method only, not Phase W) | owner | output |
| P6 | **Done 2026-10-19:** the release image was **built on the laptop**, not on the VM (the VM has 1.9 GB RAM, about 615 MB available, no swap and one CPU, so a build would risk the database and API). Built from a clean worktree of `ba02d163…` (`GIT_SHA` set), tagged `oci-api:latest` and `oci-tools:latest` (one image), id `sha256:f55bbfa6e73a821e81aea65534b72425d87bc39cfa3584a3abdd9f2ef045c286`; saved and compressed (209 MB, SHA-256 `3c9c8e5c08d252ea22234b362174d2bc72e2b8ae67515a6cf3cbeb6ee854ebb1`), copied, hash equal on the VM, loaded with `docker load` (same id on the VM). The running API stayed on `4fba8110ac9c` and healthy; all five containers `Up`. Before the load the running image got the rollback name `infinicus-api:rollback-pre-0199` (it also carries `infinicus-api:candidate-20261014`) | owner | ids |
| P7 | CI green on the release SHA, re-checked on GitHub on the day | Claude / owner | run link |
| P8 | Phase R evidence merged (done: #167, #170) | — | — |

## 3. The window (command sequence; each step needs the previous one to pass)
All steps run on the VM as `deploy`. The compose folder is `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci`; scripts are taken from the **release folder** (the VM checkout's discovery script predates the fingerprint references). `<REL>` means `/home/deploy/infinicus-release-ba02d16/infinicus-platform`.

| Step | Action | Pass condition / stop |
|---|---|---|
| W0 | `[READ]` fresh discovery: `INFINICUS_DISCOVERY_ONLY=fingerprint` hook through the release script, and the full read-only discovery. Compare with the profile. | head 0198, `MATCHES_REPOSITORY_0198_PG16`, counts as in `production-pre-0199.profile`; any red → **STOP** |
| W1 | `[READ]` audit v2 on production in a forced read-only session (`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`) | every check 0 (`C12b` informational); non-zero → **STOP** (observations are immutable; remediation is a separate design task, not a window task) |
| W2 | `[READ]` record `docker inspect oci-api-1`, `docker compose images`, `/v1/health`; confirm `infinicus-api:rollback-pre-0199` still points at `sha256:4fba8110ac9c…` (the tag was created on 2026-10-19 before the new image was loaded) | tag exists and equals the running image id |
| W3 | Quiesce: `docker compose -p oci stop api` | `postgres` healthy, `api` stopped |
| W4 | Backup with the **release-folder** script: `BACKUP_LABEL=pre-0199-window BACKUP_ENV_FILE=/etc/infinicus/backup.env bash <REL>/infrastructure/backups/backup-offsite.sh --check` then `--verify`; read the manifest back | `BACKUP COMPLETE`, manifest head `0198_…`, fingerprint `7fd4c419d738de8a`, freshness OK. The restore of this exact backup was proven in Phase R for the earlier backup; a repeat restore proof is recommended after the window, not during it |
| W5 | Gate: from the release image run `bash /repo/infrastructure/deployment/scripts/migration-gate.sh` with the owner-role `DATABASE_URL` (as the compose `tools` service does). **Never pipe or truncate the output** | exactly `apply`/`done` for 0199, 0200, 0201 and `Migration gate passed.`; an `apply` without `done`, or `FAILED` → **STOP**, read the PostgreSQL server log for the real message; no blind retry |
| W6 | Grants: `grant-app-role.sh` (needs `psql`: run it from the `tools` service or a `postgres:16` container, not the bare API image) | ends `Withheld direct writes of activation rows and protected reorder columns from app_role.` |
| W7 | `[READ]` verify: fingerprint hook → `MATCHES_REPOSITORY_0201_PG16` (`61ef99d74289c3b3`); ledger 201 and head `0201_…`; audit v2 all 0 and `K05` two validated rows; `tenancy.list_active_memberships` security definer, stable, `search_path=pg_catalog, pg_temp`, owner not `app_role`, no EXECUTE for PUBLIC, EXECUTE for `app_role`; `app_role` and PUBLIC hold no privilege on `_migrations`; counts equal the profile | any mismatch → **STOP**, decide rollback (§4) with the API still stopped |
| **Stop point** | If W0–W7 all passed, the database is migrated and the **old API still works** on it (rehearsal R8(b)). If anything about the new API is in doubt, restart the tagged rollback image and stop here. | — |
| W8 | Start the new API: `$C up -d --no-deps api` (the API only; never the worker, Caddy or Postgres) | `/v1/ready` 200; `/v1/health` reports `ba02d163…`; OpenAPI lists `GET /v1/auth/memberships`; unauthenticated call 401; external `/v1/ready` ok |
| W9 | Smoke: the existing smoke script with `EXPECTED_BUILD_SHA=ba02d163…`; a well-formed unauthenticated outcome request returns 401 (a malformed body returns 400 first; that is expected). The real-identity gate (Gate D) is not part of the window | pass |
| W10 | Close: retain evidence (command output without values), tell the owner the result | — |

Expected API downtime: W3 to W8, minutes (the image is built in advance, P6).

## 3a. Deploy method (P5), as checked on the VM
Facts established on 2026-10-19 (owner-run, read-only unless stated): the compose project is `oci` in `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci`; the `tools` image was two weeks old (a gate run with it would have used old migrations) and contains **no `psql`**, so the runbook's "run `grant-app-role.sh` in the tools container" step cannot work as written; production images before this release were `oci-api:latest` = `infinicus-api:candidate-20261014` (`4fba8110ac9c`) and an older `oci-api:rollback-20261014` (`ee6e44c5b7b2`).

Commands (VM, as `deploy`; in a bash session on the VM, not in PowerShell):
```
REL=/home/deploy/infinicus-release-ba02d16/infinicus-platform
OCI=/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci
C="docker compose -p oci --env-file $OCI/.env -f $REL/infrastructure/deployment/oci/docker-compose.yml"
$C --profile tools config --quiet && echo COMPOSE_CONFIG_OK          # parse check (done)
$C stop api                                                           # W3
$C --profile tools run --rm --no-deps tools                          # W5 gate (tools = the new image)
# W6 grants: unchanged script from a postgres:16 container (has psql); the admin URL goes through an exported variable
PW=$(grep '^POSTGRES_ADMIN_PASSWORD=' $OCI/.env | cut -d= -f2-)
export ADMIN_DATABASE_URL="postgresql://admin_role:${PW}@postgres:5432/infinicus"
docker run --rm --network oci_default -e ADMIN_DATABASE_URL -e APP_ROLE=app_role -v $REL:/repo:ro postgres:16 bash /repo/infrastructure/database/scripts/grant-app-role.sh
unset PW ADMIN_DATABASE_URL
$C up -d --no-deps api                                                # W8: the API only; Caddy and Postgres are not touched
```
`--no-deps` is used for the gate and the API start so that Compose does not recreate Postgres or Caddy because the release folder's bind-mount paths differ. The password is read from the existing `.env` by the shell and is never printed or copied. The grants step should be tried once on the day with output checked for the documented final line; if the `.env` password contains characters that break the URL, stop and decide (do not edit `.env` in the window).

**Extra safety (W4b, added by decision P2):** after the W4 backup, copy that backup's three encrypted objects to the laptop through the VM (`rclone copy` to a private folder, `scp`, compare SHA-256 with the manifest, delete the VM temp copy), so a damaged bucket during the window does not lose the pre-migration backup.

## 4. Rollback (decision table)
| Situation | Action |
|---|---|
| Gate refuses or a migration fails (W5) | API is stopped. **A refusal at 0200 leaves 0199 applied** (head `0199_…`, verdict `MATCHES_REPOSITORY_0199_PG16`, no 0200/0201 constraint; rehearsal R9). Read the server log. Owner decides: remediate data (separate block) or restart the rollback image; the old API works on a 0199 database. |
| Verification fails (W7), API stopped | Logical rollback in one transaction (Appendix C of the Phase R design; rehearsal R10: returns exactly `MATCHES_REPOSITORY_0198_PG16`, ledger 198), then start the tagged rollback image. Full restore from the W4 backup only if the schema is in doubt. |
| New API started, defect found (W8–W9) | Start the tagged rollback image; the database needs no change (the old API runs on the migrated schema). |
| Data corruption suspected | Full restore from the W4 backup (recovery point W4; the API was stopped from W3). Restore on a disposable machine first, never over production unverified. |

## 5. Not part of this window
Cloudflare, DNS, secrets, roles, worker activation, web hosting, Gate D (real identity), the POS work, bucket-protection or credential changes, and any restart of the VM (a kernel restart is pending; it is a separate decision).

## 6. Risks and open items
- **Deploy method (P5)** is the main unknown; it must be written down and confirmed before authorisation.
- The rollback image is identified by id only; if the tag step is skipped, rollback depends on rebuilding an unproven commit.
- The rehearsal copy was idle and the API ran with `NODE_ENV=staging`; the production-only database-URL guard and lock behaviour under traffic were not exercised.
- The test suite has an unidentified intermittent failure (§1). It does not affect the migrations, but it can make a CI re-check on the day red; re-check on GitHub and do not infer.
- The VM checkout `/opt/infinicus/repo` is stale and has untracked files; this plan avoids editing it.
- Evidence of production recovery is the restore of a backup of this state on a disposable machine; a repeat restore proof after the window is recommended.

## 7. Not done
No production command was run for this plan; no merge, migration, deployment, backup, tag, cleanup, Cloudflare/DNS/secret/role/grant change.
