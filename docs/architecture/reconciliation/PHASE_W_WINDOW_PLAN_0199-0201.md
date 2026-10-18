# Phase W — production window plan, migrations 0199 → 0201 (PLAN ONLY)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Status | **PLAN ONLY — Phase W is NOT authorised.** Nothing in this document has been run. It becomes executable only when the owner gives an explicit "authorise Phase W" for a named window. |
| Builds on | `PRODUCTION_RELEASE_SEQUENCE_0199-0201_DESIGN.md` (W0–W11, rollback table), `PHASE_R_REHEARSAL_DESIGN_0199-0201.md` (with its 2026-10-18 corrections), `P3_RELEASE_READINESS_REPORT_0199-0201.md` §3e–§3f |
| Owner decisions accepted (2026-10-18, "go with your recommendations") | (1) release exactly the rehearsed commit; (2) one window, quiet weekday daytime, 90 minutes booked, second person reading along; (3) rollback image tagged before the window and a fresh verified backup right before the migration; (4) bucket protection understood and credentials treated as full access, ideally before the window; (5) private-key offline copy as a precondition |
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
| P4 | Release folder prepared on the VM **before** the window from an export of exactly `ba02d163…` (for example `git archive` on the laptop, copied with `scp` to `/home/deploy/infinicus-release-ba02d16`, SHA-256 compared), not by editing the existing checkout (`/opt/infinicus/repo` is at `130bf5a` with untracked files) | owner | hashes match |
| P5 | **Open item — deploy method.** How the API image is built and started from a release folder (the `.env` of the oci compose project, the project name `oci`, build command) is confirmed against `infrastructure/deployment/oci/runbook.md` and what was done on 2026-10-14; the exact commands are written into this plan before authorisation | owner and Claude | commands recorded here |
| P6 | New API image built from the release folder **before** the window (`GIT_SHA=ba02d163… docker compose -p oci build api tools`, no start); image id recorded | owner | image id |
| P7 | CI green on the release SHA, re-checked on GitHub on the day | Claude / owner | run link |
| P8 | Phase R evidence merged (done: #167, #170) | — | — |

## 3. The window (command sequence; each step needs the previous one to pass)
All steps run on the VM as `deploy`. The compose folder is `/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci`; scripts are taken from the **release folder** (the VM checkout's discovery script predates the fingerprint references). `<REL>` means `/home/deploy/infinicus-release-ba02d16/infinicus-platform`.

| Step | Action | Pass condition / stop |
|---|---|---|
| W0 | `[READ]` fresh discovery: `INFINICUS_DISCOVERY_ONLY=fingerprint` hook through the release script, and the full read-only discovery. Compare with the profile. | head 0198, `MATCHES_REPOSITORY_0198_PG16`, counts as in `production-pre-0199.profile`; any red → **STOP** |
| W1 | `[READ]` audit v2 on production in a forced read-only session (`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000'`) | every check 0 (`C12b` informational); non-zero → **STOP** (observations are immutable; remediation is a separate design task, not a window task) |
| W2 | `[WRITE-local label]` record `docker inspect oci-api-1`, `docker compose images`, `/v1/health`; **tag the running image**: `docker tag sha256:4fba8110ac9c7f68434eb95b38d542bb353a5218314411ee7f5378e5bb9f19a7 infinicus-api:rollback-pre-0199` (check that the id still equals the running image first) | tag exists; id recorded |
| W3 | Quiesce: `docker compose -p oci stop api` | `postgres` healthy, `api` stopped |
| W4 | Backup with the **release-folder** script: `BACKUP_LABEL=pre-0199-window BACKUP_ENV_FILE=/etc/infinicus/backup.env bash <REL>/infrastructure/backups/backup-offsite.sh --check` then `--verify`; read the manifest back | `BACKUP COMPLETE`, manifest head `0198_…`, fingerprint `7fd4c419d738de8a`, freshness OK. The restore of this exact backup was proven in Phase R for the earlier backup; a repeat restore proof is recommended after the window, not during it |
| W5 | Gate: from the release image run `bash /repo/infrastructure/deployment/scripts/migration-gate.sh` with the owner-role `DATABASE_URL` (as the compose `tools` service does). **Never pipe or truncate the output** | exactly `apply`/`done` for 0199, 0200, 0201 and `Migration gate passed.`; an `apply` without `done`, or `FAILED` → **STOP**, read the PostgreSQL server log for the real message; no blind retry |
| W6 | Grants: `grant-app-role.sh` (needs `psql`: run it from the `tools` service or a `postgres:16` container, not the bare API image) | ends `Withheld direct writes of activation rows and protected reorder columns from app_role.` |
| W7 | `[READ]` verify: fingerprint hook → `MATCHES_REPOSITORY_0201_PG16` (`61ef99d74289c3b3`); ledger 201 and head `0201_…`; audit v2 all 0 and `K05` two validated rows; `tenancy.list_active_memberships` security definer, stable, `search_path=pg_catalog, pg_temp`, owner not `app_role`, no EXECUTE for PUBLIC, EXECUTE for `app_role`; `app_role` and PUBLIC hold no privilege on `_migrations`; counts equal the profile | any mismatch → **STOP**, decide rollback (§4) with the API still stopped |
| **Stop point** | If W0–W7 all passed, the database is migrated and the **old API still works** on it (rehearsal R8(b)). If anything about the new API is in doubt, restart the tagged rollback image and stop here. | — |
| W8 | Start the new API: `docker compose -p oci up -d api caddy` (never the worker) | `/v1/ready` 200; `/v1/health` reports `ba02d163…`; OpenAPI lists `GET /v1/auth/memberships`; unauthenticated call 401; external `/v1/ready` ok |
| W9 | Smoke: the existing smoke script with `EXPECTED_BUILD_SHA=ba02d163…`; a well-formed unauthenticated outcome request returns 401 (a malformed body returns 400 first; that is expected). The real-identity gate (Gate D) is not part of the window | pass |
| W10 | Close: retain evidence (command output without values), tell the owner the result | — |

Expected API downtime: W3 to W8, minutes (the image is built in advance, P6).

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
