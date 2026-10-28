# AUTH-LOCKOUT-1 — Release Gate Matrix after RP-12A / RP-12B (RP-13)

Status: EVIDENCE RECONCILIATION ONLY. Not a release authorization. Production verdict: **NO-GO**.
Labels: VR = VERIFIED — REPOSITORY, VC = VERIFIED — CI, RH = VERIFIED — REHEARSAL (disposable local infrastructure, synthetic data), OO = OWNER-OBSERVED —
PRODUCTION (operator-run output; the coding environment has no production access and did not verify it), INF = INFERRED, UV = UNVERIFIED, BL = BLOCKED.
Release candidate: `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`. Baseline: `main` at the time of writing plus the evidence in this directory.

| Gate | Requirement | Status | Evidence and class | Open action |
|---|---|---|---|---|
| G-1 | Running build identity; rollback image retained | **PASS** (identity), rollback pending | OO (RP-12A, 2026-10-28 13:46Z): container `oci-api-1` healthy, image `sha256:e94114e2…ccf4`, embedded `INFINICUS_BUILD_SHA=ccadbf51…`, public `/v1/health` reports the same. OO (RP-12B): running image contains only `.env.example`. | Pin the running image with a new tag inside the window, before the new image is loaded (`RELEASE_BUILD_AND_DEPLOY_PROCEDURE.md` §5, W2). Not yet done. |
| G-2 | Ledger 209 / head 0209 / fingerprint | **PASS** | OO: 209 rows, head `0209_create_print_jobs.sql`, no 0210–0220; combined fingerprint `325158ea2a54cde9` equals the 0209 reference (RH baseline; the VM's older discovery script printed NO_REFERENCE_MATCH only because it lacks that reference). Backup manifest of 2026-10-28 02:38Z records the same ledger head and fingerprint. | Repeat inside the window. |
| G-3 | Original unsafe audit policy; restricted app role | **PASS** (state confirmed as the pre-0220 baseline) | OO: policy without `NULLIF`; RLS on, FORCE off; owner `admin_role`; `app_role` not superuser, no BYPASSRLS; SELECT/INSERT/UPDATE/DELETE granted, no TRUNCATE; no triggers or rules. | None for the release. Audit privilege hardening is separate (AUDIT-LP-1). |
| G-4 | Fresh backup and verified recovery | **BLOCKED** | OO: last backup 2026-10-28 02:38:37Z, 11 h old at observation, `verified:true`, encrypted offsite, both artifacts re-downloaded and verified; timer enabled. No restore proof of any backup after 2026-10-21 is on record on the VM; `archive_mode=off` (no PITR); VM is 1 vCPU/1.9 GB. VR: the repository profile records a restore proof on 2026-10-21 at the same schema head. | Owner decision and, if chosen, a restore proof on separate hardware (`RECOVERY_READINESS_PLAN.md`); on-demand backup inside the window. |
| G-5 | `app_role` denied ledger access | **PASS** | OO: no privilege on `public._migrations`; empty ACL. | None. |
| G-6 | No blocking transactions or locks | **PASS** (snapshot) | OO: no transaction older than 30 s, no idle-in-transaction, no locks on `audit.access_events`, no blocked sessions, no prepared transactions at 13:46Z. | Repeat inside the window (a clean snapshot is not a guarantee). |
| G-7 | Release candidate identity | **VERIFIED** | VR: branch `claude/auth-lockout-1-isolated-rc` @ `bea03e66…`; 14 files, +289/−84 vs `ccadbf51`; AUTH-LOCKOUT-1 patch (sha256 `c899bd16…de00`), migration-contiguity test, patch-level dependency fixes. | Export checksum recorded at build time. |
| G-8 | Isolated migration procedure | **VERIFIED IN REHEARSAL** | RH: 0220 applied by `psql` and by the RC runner; idempotent; rollback restores fingerprint `325158ea2a54cde9`; runner of `main` afterwards applies exactly 0210–0219 and skips 0220; lock timeout behaves as designed. | Procedure re-expressed for the OCI containers in the corrected procedure. |
| G-9 | Dependency advisory exception | **OWNER APPROVAL PENDING** | VC: CI fails at the dependency scan on the RC and on the unpatched base. RH/VC: after the patch-level fixes 3 entries remain: `zod` (high, needs a major upgrade) and 2 `vite` (dev-only). The exception was agreed in principle (Option 2); no written confirmation exists in the record. | Written owner confirmation naming the 3 advisories, the test-only commit `d41b08e4` and the dependency commit `bea03e66`. |
| G-10 | Final production authorization | **PENDING** | No evidence. | Owner decision after G-4, G-9, G-12. |
| G-11 | Architecture isolation | **VERIFIED** | VR: RC excludes NEW-BDT-SIM-01 and migrations 0210–0219; frozen contracts untouched. | None. |
| G-12 | Maintenance window and rollback owner | **PENDING** | No evidence. | Owner names both. |

## Additional findings carried into the release record

| ID | Finding | Class | Handling |
|---|---|---|---|
| F2 | `/opt/infinicus/repo` is stale (HEAD `130bf5ac`, 2026-10-14); the running image was built from an exported tree without `.git`; compose project `oci` was started from that tree's single compose file with `--env-file` in `/opt/infinicus/repo/…/oci/.env`. | OO | Corrected procedure builds from a hashed export and reproduces that invocation. |
| F3 | `.dockerignore` patterns were root-anchored, so nested env files entered images. The running image is clean; one retained older image (`oci-api:rollback-20261014`) contains a real `.env`. | OO + RH | SEC-DOCKER-1 (fix and tests, separate PR); hygiene plan for the historical image. |
| F9 | Two environment backup files are mode 664. | OO | Hygiene plan (owner action). |
| F6 | The VM is small (1 vCPU, 1.9 GB RAM, no swap); a restore test container was previously OOM-killed. | OO | The image is built off the VM and loaded (as in the 2026-10-21 window); restore proofs run on separate hardware. |
| F5 | No event-worker container; 59 outbox events pending, unchanged since 2026-10-21. | OO | Not a release item; noted. |

## Verdict

Technical design applicability is confirmed by production evidence: the live state equals the rehearsed baseline. Release remains **NO-GO**: G-4 is blocked, G-9,
G-10 and G-12 are pending, and the corrected procedure has to be reviewed. Nothing here converts a pending gate to PASS.

## RP-14 update (2026-10-28)

| Gate | RP-14 result | Evidence |
|---|---|---|
| G-4 | **BLOCKED (unchanged).** No authorized backup, restore host or key existed in the session, so no restore was run. Tooling compatibility is now verified: the installed `backup-offsite.sh` is byte-identical to `main`'s and a rehearsal of that backup script plus `main`'s `restore-proof.sh` on a synthetic ledger-209 database passes; the older `restore-proof.sh` and the default profile fail (false negatives), so the procedure fixes the script version and the profile. | `RP-14A_RECOVERY_EVIDENCE.md` (RH) |
| G-1, G-2, G-3, G-5, G-6 | unchanged (owner-observed at RP-12A; re-check in the window) | — |
| G-7, G-8, G-11 | unchanged; RC identity re-confirmed as `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` | VR |
| G-9, G-10, G-12 | still pending; nothing in RP-14 changes them | — |
| Hygiene H1/H3 | assessed from the evidence available; owner checks outstanding (see `RP-14B_EXPOSURE_ASSESSMENT.md`) | — |

Verdict stays **NO-GO**.
