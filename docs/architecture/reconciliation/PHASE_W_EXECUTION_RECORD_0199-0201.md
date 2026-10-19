# Phase W execution record: migrations 0199-0201 released to production

| Item | Value |
|---|---|
| Date | Monday 19 October 2026, 13:56-15:58 UTC (16:56-18:58 Kuwait) |
| Operator | the owner, alone, on the laptop; Claude guided one command at a time and read the output. Claude had no production access. |
| Release SHA | `ba02d163a1b574c79844311b8737c73939a2c3dc` (CI run 437 green on that commit) |
| Result | **VERIFIED COMPLETE.** Production is at ledger 201; the new API runs the release commit. |
| Evidence | `OWNER-RUN-OUTPUT` pasted into the working session; values below are quoted from it, no secret or row data. |

## Timeline and results
| Step | UTC | Result |
|---|---|---|
| Pre-flight | 13:57 | Running image `4fba8110ac9c…`; `infinicus-api:rollback-pre-0199` and `candidate-20261014` = `4fba8110ac9c…`; `oci-api:latest` and `oci-tools:latest` = `f55bbfa6e73a…c286`; memory available 627 MB. Backup `--check`: first run failed (see Findings), then `CHECK PASSED`, 15/15. |
| W0 | 13:59 | Fingerprint `7fd4c419d738de8a` = `MATCHES_REPOSITORY_0198_PG16`; counts equal `production-pre-0199.profile`: ledger 198, tenants 16, users 6, businesses 16, outbox 59 (48 + 11), six tables empty. |
| W1 | ~14:03 | Audit v2 (`f-na05-2-om-integrity-audit-v2.sql`, sha256 `75c9d08d…456d`): read-only session, `infinicus`, PG 16.15, head 0198; every C check 0 (C12b 0); K05 empty. |
| W3 | ~14:07 | `docker compose -p oci stop api`: API stopped; Postgres healthy. |
| W4 | 14:08 | `BACKUP COMPLETE`, key prefix `infinicus-production/2026-10-19/20261019T140816Z-pre-0199-window`, ledger 198, head `0198_…`, fingerprint `7fd4c419d738de8a`, `db.dump.gpg` 4,710,564 bytes and `roles.sql.gpg` 1,534 bytes both read back (`verified`). W4b (laptop copy) skipped by decision (test data). |
| W5 | ~15:48 | Migration gate from the release image: `apply`/`done` for 0199, 0200, 0201; `Migration gate passed.` |
| W6 | ~15:50 | `grant-app-role.sh` from a `postgres:16` container (image pulled on the day): 19 schemas granted; final line `Withheld direct writes of activation rows and protected reorder columns from app_role.` |
| W7 | ~15:55 | Fingerprint `61ef99d74289c3b3` = `MATCHES_REPOSITORY_0201_PG16`; ledger 201, head `0201_enforce_om_monitored_action_child_scope_integrity.sql`; `tenancy.list_active_memberships(uuid)`: security definer, stable, `search_path=pg_catalog, pg_temp`, owner `admin_role`, no EXECUTE for PUBLIC, EXECUTE for `app_role`; `app_role` and PUBLIC hold no privilege on `_migrations`; counts unchanged (16, 6, 16, 59); audit v2 all C checks 0; K05 two rows, both validated. |
| W8 | ~15:57 | `up -d --no-deps api` (API only): `/v1/health` 200 with version `ba02d163a1b574c79844311b8737c73939a2c3dc` (was `unknown`); `/v1/ready` 200; unauthenticated `GET /v1/auth/memberships` 401. |
| W9 | ~15:58 | `smoke-test.sh` against `https://api.infini-cus.com` with `EXPECTED_BUILD_SHA`: health 200, ready 200, `/documentation/json` 200, build matches; exit 0. |

API downtime: about 1 h 50 min (14:07 to about 15:58). Roughly 1 h 30 min of it was an SSH disconnect between W4 and W5; the database was untouched during that time.

## Restore proof of the pre-window backup (2026-10-19, laptop)
Backup `infinicus-production/2026-10-19/20261019T140816Z-pre-0199-window`, restored with `rehearsal/phase-r-restore.sh` and the reviewed profile `production-pre-0199.profile` (sha256 `3b68ca9b829c0d4a…`) into a throwaway `postgres:16` container (16.15, `infinicus.restore_target=disposable`, no published port, random password).

- Objects copied from the offsite bucket to the VM, then to the laptop; sha256 of `db.dump.gpg` (`e62fc113…679a`), `roles.sql.gpg` (`4d237da1…f6d7`) and `manifest.json` (`64ed024c…17e7`) identical on bucket copy, VM and laptop and equal to the manifest; sizes 4,710,564 and 1,534 bytes.
- Only the secret subkeys were exported (`--export-secret-subkeys`: primary stub plus encryption subkey `2379B8C95D86BB0B`); the passphrase was typed at a hidden prompt into the container's temporary agent. No key material or passphrase left the laptop.
- Result: `RESTORE_PROOF=PASS` and `PHASE_R=PASS`. Ledger 198, head `0198_link_purchase_order_lines_to_inventory_items.sql`, schema fingerprint `7fd4c419d738de8a` equal to the manifest; 10 row-count rules and 2 outbox classification rules satisfied; 508 tables counted (tenants 16, users 6, businesses 16, outbox 59, `_migrations` 198). Timings (evidence only, not an RTO): download 0.2 s, decrypt 1.8 s, restore 36.8 s, verify 1.8 s, total 40.7 s.
- Cleanup verified: container removed with `-v`; the laptop working folder (including the key export) deleted; `~/phr` and `~/phr.tgz` deleted on the VM; no `phr` container on the VM.

Open item raised by the proof: the laptop keyring shows the backup key `6FA8FA10…F9141B` as **revoked on 2026-10-18**, yet the manifest of the 2026-10-19 backup names it as recipient. A revoked key still decrypts existing backups (proven above), but a revocation not known to the VM means new backups keep encrypting to it. Decision needed from the owner: confirm whether the revocation was intended (rotation) and, if so, rotate the recipient key before the next backup. No key or VM change was made here.

## VM reboot (2026-10-19, ~17:15-17:21 UTC)
- Pre-flight (read-only): running kernel 6.8.0-142, installed 6.8.0-147; uptime about 17 days; `oci-api-1`, `oci-caddy-1`, `oci-postgres-1` all `restart=unless-stopped`; docker and containerd enabled; 15 GB free.
- 13 pending packages applied with `apt-get upgrade` (including docker-ce, containerd.io, compose plugin, apparmor, snapd, tzdata); the Docker daemon restart brought the three `oci-*` containers back healthy within 30 s. The containers were NOT stopped by hand (an `unless-stopped` container stopped manually would not restart on boot).
- `systemctl reboot` at 17:18:21 UTC. After reconnect: kernel 6.8.0-147-generic, uptime 3 minutes, no `reboot-required` file, the three `oci-*` containers up and healthy, `/v1/health` 200 with version `ba02d163a1b574c79844311b8737c73939a2c3dc`, `/v1/ready` 200. Downtime about 3 minutes.
- Side effect: `infinicus-api-smoke-test` and `infinicus-restore-test-db` (`restart=no`, left from earlier rehearsals) stopped with the Docker restart and were not restarted. Neither was deleted; reviewing them (the restore-test one may hold a restored data copy) is a separate decision.
- Open: no scheduled offsite backup timer was found on the VM (only the system `dpkg-db-backup` timer); a cron entry was not checked.

## Findings (none blocked the release)
1. **W4 command needed `COMPOSE_DIR`.** The first `--check` from the home folder failed 6 of 15 checks (database not reachable, versions unreadable): the script reaches Postgres through `docker compose exec` from `COMPOSE_DIR`, which defaults to the current directory. With `COMPOSE_DIR` set to the live compose folder it passed. Nothing was written by either run. The plan (§3, §3b) is corrected in this change.
2. **SSH variables are lost on reconnect** (`OCI`, `REL`, `C`). Twice a step was pasted with empty variables and failed harmlessly on missing paths. For a future window, every command should define its own variables.
3. **Verification query typing slip.** The first W7 query failed (`text || "char"`: `provolatile` needs a cast) and was re-run with casts. The W7 grep also counted the legitimate population counts C01/C01c as non-zero; excluded on the re-check.
4. **`postgres:16` was pulled on the day** for the grants step (it was not on the VM).
5. **The API image has no `wget`**; health and readiness were read with Node `fetch`.
6. The VM reports **"System restart required"** and 13 pending updates (1 ESM). No reboot was done in the window.

## Safety net still in place
- Rollback image `infinicus-api:rollback-pre-0199` (`4fba8110ac9c…`); the old API works on the migrated database (rehearsal R8(b)).
- Pre-window backup `…/20261019T140816Z-pre-0199-window` (restore-proven 2026-10-19, see "Restore proof" below).
- Logical rollback of 0199-0201 (Phase R design, Appendix C) rehearsed in R10.

## Follow-ups
- POS-4/5 migrations (0202-0206) are in draft pull requests only and are NOT applied; they need their own window, authorization, fresh backup and the migration gate.
