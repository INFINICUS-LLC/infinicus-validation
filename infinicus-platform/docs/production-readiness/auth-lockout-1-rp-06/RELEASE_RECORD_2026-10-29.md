# AUTH-LOCKOUT-1 — Release Record, 2026-10-29

Status: **EXECUTED AND VERIFIED AT SMOKE-TEST LEVEL.** Record of what the owner ran on `infinicus-prod-01`, following `RELEASE_BUILD_AND_DEPLOY_PROCEDURE.md`, with Claude guiding step by step. Claude has no production access: every production observation below is OWNER-OBSERVED (pasted terminal output), not independently verified.
Labels: VR = verified in the repository, RH = rehearsal, OO = owner-observed production. No secret, key, credential or customer record appears in this file.
Baseline: `main` faea31ef; release candidate `claude/auth-lockout-1-isolated-rc` @ `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` (never merged to `main`).

## 1. Authorization
Given by the owner in the working session on 2026-10-29 (quoted in meaning): migration 0220 and deployment of RC `bea03e66…` on `infinicus-prod-01` today, executed by the owner following the procedure, stop conditions binding. Executor and rollback owner: the owner (no second person; recorded in `OWNER_DECISION_RECORD_2026-10-29.md`). G-4 restore proof passed earlier the same day; G-9 exception approved for exactly 3 advisories.

## 2. Artifacts
| Item | Value |
|---|---|
| Source export | `infinicus-release-bea03e66.tar.gz` sha256 `f28800e0086a3707fd9ebd3c7794d13009a40542defd52a156ba2ed704b03fdf`; reproduced independently from the commit (VR) |
| Image | `oci-image-bea03e66.tar.gz` (210 MB) sha256 `629c675180cd75a9b10a8cd97ce38f7a79a89936101f83244f5d2c6b9fd100da`; image ID `c74e7b97e41a`; embedded `INFINICUS_BUILD_SHA` = RC; no env files in the image (OO) |
| Migration | `0220_normalize_access_event_tenant_context.sql` sha256 `78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472` (OO on the VM) |
| Pre-release dependency scan | 3 un-allowlisted advisories only: `zod` GHSA-mrhx-c7xc-m3w5 (high), `vite` GHSA-9jrq-w75r-8gcw (low), `vite` GHSA-rq7h-c2jc-7f22 (moderate) — exactly the approved exception (re-run by Claude on the RC the same day) |
| Rollback image | tag `infinicus-api:rollback-pre-0220-ccadbf51` → `sha256:e94114e2a96dc5a47126e953a0b953e0ceae76d8d350e2bde428cedc07f5ccf4` (the previous production image, build `ccadbf51…`) |

## 3. Execution (OO)
| Step | Result |
|---|---|
| Phase B, files to the VM | both archives `OK`; no env files; 0 carriage returns; migration hash as above; 210 migration files ending `0209…` and `0220…` |
| W0/W1, repeat of gates G-1..G-6 | ledger 209 / head `0209_create_print_jobs.sql`; fingerprint `325158ea2a54cde9` (`MATCHES_REPOSITORY_0209_PG16`); policy without `NULLIF`; RLS on, not forced; app privileges SELECT/INSERT/UPDATE/DELETE true, TRUNCATE false; 0 long transactions, 0 idle-in-transaction, 0 prepared; running image `e94114e2…ccf4`, health `ccadbf51…` |
| W2 | rollback tag pinned and verified; new image loaded; the running container stayed on the old image |
| W3 | `api` stopped; `postgres` healthy, `caddy` up |
| W4 | backup `infinicus-production/2026-10-29/20261029T170330Z-pre-0220-window`: ledger 209, head 0209, fingerprint `325158ea2a54cde9`; both objects verified; manifest uploaded (recovery point; no point-in-time recovery) |
| W5 | migration gate from the release image: 209 `skip`, exactly one `apply` and one `done` for `0220…`, `Migration gate passed.` |
| W7 | ledger 210 / head `0220_normalize_access_event_tenant_context.sql`; policy contains `NULLIF`; RLS on, not forced; app privileges unchanged; live fingerprint `c4d9f7f8aebfa5c8` (equals the rehearsal value and the `schema_fingerprint` of `production-post-0220.profile`) |
| W8 | new API `Up (healthy)`; `/v1/ready` ready; `/v1/health` version `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` |
| W9 | smoke test: 4 checks OK including the build-version check, exit 0; `LockoutStateUnavailable` count 0; no 5xx lines in the previous 10 minutes |

## 4. Deviation (recorded, no harm)
After W8 passed, a rollback block that was printed in the same instruction message as a conditional ("only if W8 fails") was pasted and run. The API went back to the old image for a short time, the first smoke test failed on the version check (correctly), and the state was confirmed read-only: database at 210, old API healthy, new image still present. The new image was re-tagged, the API recreated, and W8 and W9 were repeated and passed. No data was lost and the database was not changed by the mix-up. The accident also exercised the rollback path once (the old image started and was healthy on the migrated database). Lesson for later procedures: a conditional rollback must never share a message with the step it guards.

## 5. State after the release
- Database: ledger 210, head `0220…`, fingerprint `c4d9f7f8aebfa5c8`.
- API: `bea03e66…`, healthy. `oci-api:latest` and `oci-tools:latest` → `c74e7b97e41a`. The rollback tag is retained; do not delete it.
- Untouched: `postgres`, `caddy`, `/home/deploy/w2clean/infinicus-release-ccadbf5/` (the backup unit runs from it).

## 6. Gates after the release
G-1 PASS (rollback pin done) | G-2, G-3, G-5, G-6 repeated inside the window and PASS | G-4 PASS (earlier restore proof; recorded in `OWNER_DECISION_RECORD_2026-10-29.md`) | G-7, G-8, G-11 as before | G-9 approved (3 advisories; expires at the next release or 30 days) | G-10 given by the owner in the session | G-12 window executed, executor = rollback owner.

## 7. Not verified, and follow-ups
1. **No real login was tried** (no synthetic account was created). The fail-closed lockout is covered by rehearsal and the clean logs, not by a live login. The old-policy hazard (503 on a reused connection) is the reason 0220 had to precede the new API; it did.
2. **Backups:** the W4 backup has head 0209 and the next daily should have head 0220. After the next daily run (about 02:38 UTC) check its manifest (ledger 210, head 0220) and run a restore proof with `production-post-0220.profile`; the profile's source fingerprint is now confirmed on production.
3. **Watch the logs** for `LockoutStateUnavailable` and 5xx on `/v1/auth/login` for a while.
4. **Dependency exception** expires at the next release or 30 days (the `zod` and `vite` upgrades are separate work; the repository's own allowlist entries marked "review by 2026-11-06" are unrelated).
5. **Cleanup after a stable period** (not the rollback image): the staged release files in the VM home folder and the temporary copies on the owner's laptop.
6. **Hygiene, still open:** the two `rclone` history lines, revoking the old Anthropic and Resend keys, `chmod 600` on two env backups.
7. **Separate work, not in this release:** AUDIT-LP-1 rollout (its own window; the grant script on the VM still re-grants UPDATE/DELETE until replaced), NEW-BDT-SIM-01, and migrations 0210–0219 (the next release from `main` applies them and skips 0220).
