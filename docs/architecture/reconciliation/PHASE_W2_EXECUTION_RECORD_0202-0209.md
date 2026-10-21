# Phase W2 — execution record, migrations 0202 → 0209 (production, 2026-10-21)

| Field | Value |
|---|---|
| Date | 2026-10-21 (UTC) |
| Authorised by | The owner, explicit "I authorise Phase W2", followed by "go W3", "BOTH AUTHORISED" (W10 and W11) in the same session |
| Operator | The owner, on their PC with the VM SSH key; Claude read each output and gave one command at a time |
| Plan | `PHASE_W2_WINDOW_PLAN_0202-0206.md` (covers 0202–0209) |
| Release SHA | `ccadbf51be90c35377e21b73ceda77a1d455a805` (CI push run 505 on `main`: `validate` and `build-and-smoke-test-image` both success) |
| Result | **Window completed. Database at ledger 209, head `0209_create_print_jobs.sql`, fingerprint `325158ea2a54cde9` (`MATCHES_REPOSITORY_0209_PG16`). API running the release image; public smoke test passed.** |
| Not done | Restore proof of the W4 backup (needs the private key; owner-run, section 5). W9b/W9c (no production host for the counter). Row counts were not re-read after the API started. |

## 1. Timeline (UTC, from the operator's output)
| Step | Result |
|---|---|
| P4/P5 (release folder, image) | **Redone** because the first copies were rejected (section 3). |
| P6 | CI green on the release SHA (run 505). |
| W0 | `MATCHES_REPOSITORY_0201_PG16` (`61ef99d74289c3b3`); ledger 201 / head `0201_…`; `platform.orders` 0 rows, `register_sessions` 0 rows. |
| W1 | Audit v2 (file SHA-256 `75c9d08d…456d`): every `C` check 0 (population C01/C01c = 3, C12b = 0), `K05` two validated rows. |
| W2 | Running image `sha256:f55bbfa6e73a…` = tag `infinicus-api:rollback-pre-0202`; health version `ba02d163…`. |
| W3 | `stop api` (exit 137 after the 10 s grace period; harmless). Postgres healthy, Caddy up. |
| W4 | `--check` passed (15/15). `--verify`: key prefix `infinicus-production/2026-10-21/20261021T141842Z-pre-0202-window`, ledger 201, fingerprint `61ef99d74289c3b3`, `db.dump.gpg` (4 719 381 B) and `roles.sql.gpg` (1 534 B) both verified, manifest uploaded. |
| W5 | `apply`/`done` for 0202 … 0209 in order, then `Migration gate passed.` |
| W6 | Grants on 19 schemas; final line `Withheld direct writes of activation rows and protected reorder columns from app_role.` |
| W7 | Fingerprint `325158ea2a54cde9`; ledger `209 / 0209_create_print_jobs.sql`; `orders.note` text nullable, `orders_note_format` present, 0 notes; `order_payments` rls+forced, 16 cols, 4 idx, 1 policy, 3 triggers; `printers` rls (not forced), 14 cols, 6 idx, 1 policy, 1 trigger, 7 checks; `print_jobs` rls (not forced), 13 cols, 6 idx, 1 policy, 2 triggers, 6 checks; all new tables 0 rows; `app_role` has no TRUNCATE on any; audit v2 as W1. |
| W8 | `up -d --no-deps api`: `Up (healthy)`, image `sha256:e94114e2a96d…`, `/v1/health` version = release SHA, `/v1/ready` 200. |
| W9 | `smoke-test.sh` against `https://api.infini-cus.com` with `EXPECTED_BUILD_SHA`: health, ready, `/documentation/json` 200, build matches, exit 0. |
| W11 | systemd drop-in `/etc/systemd/system/infinicus-backup.service.d/release.conf` repoints `ExecStartPre`/`ExecStart` to the clean release folder. One manual start: `BACKUP COMPLETE`, manifest `ledger_head 0209_create_print_jobs.sql`, `schema_fingerprint 325158ea2a54cde9`, `verified true`; freshness check `OK … 0h ago`. |

Downtime (API stopped to healthy): roughly 10 minutes (stopped shortly before 14:17:49Z, healthy before 14:30Z). Exact start and end times were not captured.

## 2. State left on the VM
- Running API image `e94114e2a96d` (tags `oci-api:latest`, `oci-tools:latest`), `INFINICUS_BUILD_SHA=ccadbf5…`.
- Rollback images kept: `infinicus-api:rollback-pre-0202` (`f55bbfa6e73a`, the previous release), `rollback-pre-0199`, `oci-api:rollback-20261014`.
- Clean release folder: `/home/deploy/w2clean/infinicus-release-ccadbf5/` (4 668 files under `infinicus-platform`, 0 with carriage returns; archive SHA-256 `856b03085a3e75904fe58d2a3312651d5d5cc9672c3cecafd0eea25c4f99c44f`). The image archive is `/home/deploy/oci-image-ccadbf5.tar.gz` (SHA-256 `7cf8f5e24ebbf4d8cf55a61e4c0c2df39ec0f194666bb8f3c11acff35504457c`).
- **Rejected, still on disk, do not use:** `/home/deploy/infinicus-release-ccadbf5/`, `…-ccadbf5.tar.gz`, `…-ccadbf5-lf.tar.gz` (Windows line endings). Renaming or deleting them is a separate, owner-approved step.
- The previous `oci-api:latest` (`9eec2a2e8c71`, built from the rejected export) is untagged and can be pruned later.
- Backup unit now uses the `w2clean` path through the drop-in; to undo, delete `release.conf` and `systemctl daemon-reload`.

## 3. Finding: Windows line endings in the release export (would have broken the window)
- The first release folder and image had been prepared from `git archive` run on Windows with `core.autocrlf=true`. That converted text files to CRLF. The committed objects are LF (0 carriage returns, checked on Linux). On the VM `production-readonly-discovery.sh` failed to parse (`$'\r': command not found`) at W0 before any database call.
- Two checks on the PC gave false comfort: Git Bash `sha256sum -t` and `grep -c $'\r'` both hide carriage returns (text mode). The earlier "P4 verified" was therefore wrong and was withdrawn. **Only a Linux-side check is reliable** (`grep -c $'\r'` / `grep -rlI $'\r'` on the VM).
- Fix used: `git -c core.autocrlf=false -c core.eol=lf archive …`, verified on the VM (0 files with CR), then the image was rebuilt from that clean export (`docker build -f apps/api/Dockerfile --build-arg GIT_SHA=<sha> -t oci-api:latest -t oci-tools:latest .` on the PC; the compose build needs production secrets, so it was not used), saved, copied, hash-checked and loaded.
- Plan changes to make: P4 must export with `core.autocrlf=false` and verify "0 files with CR" **on the VM**; P5 must build from that export.

## 4. Other plan corrections observed
- The health check can be read without a host port: `docker exec oci-api-1 node -e "fetch('http://localhost:3000/v1/health')…"`.
- W6 and the W5/W8 commands worked as written once `REL` pointed at the clean folder.
- `docker stop` waits 10 s then kills the API (exit 137); acceptable, but a shorter wait or a graceful stop timeout could be set later.
- W11 is safer as a drop-in than as an edit of the installed unit.

## 5. Open items (all owner-side; none started)
1. **Restore proof of the W4 backup** (`restore-proof.sh`): run it on a machine that holds the private backup key and a disposable local PostgreSQL 16, never on the production VM; the backup is not "recoverable" until this passes. The 2026-10-21 daily backup (`…T143056Z-daily`) records the 0209 schema and can be proved the same way.
2. Rename or remove the rejected CRLF folders and archives on the VM, and prune the untagged image `9eec2a2e8c71`.
3. Backup-key rotation (the key is revoked on the laptop but valid on the VM) remains a separate decision.
4. W9b/W9c (a test sale and printer setup through the counter) still need a counter host and an allowed CORS origin; they are not part of this window.
5. Per-product kitchen routing (0210) and offline selling (0211+) are not authorised and not started.

## 6. What this record does not claim
No row counts were re-read after the API started (NOT RUN). The restore proof was NOT RUN. Exact downtime was not measured. Nothing in this record changes production.
