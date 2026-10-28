# AUTH-LOCKOUT-1.RP-11 — Release Readiness Package (final RC `d41b08e4`)

Status: EVIDENCE PACKAGE ONLY. Not a release authorization. No production access, migration or deployment was performed.
Labels: VR = VERIFIED — REPOSITORY, VC = VERIFIED — CI, RH = VERIFIED — REHEARSAL (disposable local PostgreSQL 16 + local Docker, synthetic data),
OO = OWNER-OBSERVED — PRODUCTION, UV = UNVERIFIED, BL = BLOCKED.

## 1. Artifact identity

| Item | Value |
|---|---|
| RC branch / commit | `claude/auth-lockout-1-isolated-rc` @ `d41b08e4db13343570ce1cdd2ff84d27b36324d1` (VR) |
| Base (deployed build, OO) | `ccadbf51be90c35377e21b73ceda77a1d455a805` |
| Delta | AUTH-LOCKOUT-1 patch (9 files, sha256 `c899bd16…de00`) + 1 test-only commit (`migration-stage2a.test.ts`) (VR) |
| `0220` sha256 | `78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472` (VR) |
| Local rehearsal image | `infinicus-api:rc-d41b08e4`, id `sha256:3964278b6a2a2b15e1358fe55666a131f0ddb942357f1363e70ae0838bd187b3`, built with `GIT_SHA=d41b08e4…` (RH) |
| Image caveat | the sandbox proxy CA was added to a local base image to allow `pnpm install`; this image is NOT a production artifact. Production image must be built clean on the release host or CI. |

## 2. Evidence on the final commit

| Evidence | Result | Label |
|---|---|---|
| Workspace build | 30/30 tasks | RH |
| CI Test command (15 package filters, same as `ci.yml`) at DB 0209+0220 | 39/39 tasks, exit 0. database 3562 passed/26 skipped (90 files); api 633/12 skipped (53 files); business-operations-runtime 612; workflow 274; handoff-contracts 549; web 324; event-worker 233; data-acquisition-runtime 94; authentication 60; configuration 46; event-contracts 38; authorization 25; onboarding 29; observability 18; layer-continuous-learning blocks all pass | RH |
| Contiguity guard | passes on the RC; mutation checks (partial gap 0215, unrelated gap 0150) still fail; main's real 221-file list has no violation | RH |
| Container start + readiness | `/v1/ready` 200; `/v1/health` reports `d41b08e4db13343570ce1cdd2ff84d27b36324d1` | RH |
| `smoke-test.sh` with `EXPECTED_BUILD_SHA` | all 4 checks passed, including commit match | RH |
| Lockout behavior in the container (synthetic account) | register 201; login 200; 5 wrong passwords 401; correct password after 5 failures → HTTP 429 `AccountLockedError`; unknown email 401; 0 `LockoutStateUnavailable` log lines | RH |
| Negative control (RC against DB without 0220) | login returns 503 and DB-02 fails 4/6 (run at test level on `c5936cef`; the test files are unchanged by the later commit) | RH |
| 0220 apply by `psql` or runner; idempotent; rollback restores fingerprint `325158ea2a54cde9` | see RP-06 §2.3 | RH |
| CI on the RC (run 40630982518) | fails only at "Dependency vulnerability scan"; control run on unpatched `ccadbf51` fails identically | VC |
| Dependency scan | 14 advisories un-allowlisted (RP-08 §2); reachability not assessed; exception approved in principle by the owner (Option 3), written confirmation pending | VC / UV |
| DAST scan (`dast-scan.sh`) | not run | UV |

## 3. Approval gates (from RP-06 §6) — status

| Gate | Requirement | Status |
|---|---|---|
| G-1 | running image/health reports `ccadbf51…`; previous image retained | UV (owner-run) |
| G-2 | ledger 209 / head 0209 / fingerprint `MATCHES_REPOSITORY_0209_PG16` | UV (owner-run) |
| G-3 | live policy equals the 0011 original; `relforcerowsecurity` false; `app_role` not superuser/bypassrls | UV (owner-run) |
| G-4 | fresh backup + passed restore proof; WAL/PITR state recorded | UV (owner-run) |
| G-5 | `app_role` has no access to `_migrations`; admin role confirmed | UV (owner-run); RH confirms the expected behavior locally |
| G-6 | no old transaction on `audit.access_events`; window agreed | UV (owner-run) |
| G-7 | RC branch exists from `ccadbf51`; delta limited to the listed files | VR — satisfied |
| G-8 | pending-migration set on the RC checkout is exactly `{0220}`; `0220` hash matches | VR/RH — satisfied (re-check on the release host) |
| G-9 | CI green | REPLACED by the exception: not satisfiable until DEP-REM-1; compensating evidence in §2 |
| G-10 | owner approves base, patch hash, Procedure P, rollback B, window, new expectations profile | pending |
| G-11 | NEW-BDT-SIM-01 absent from the RC; no frozen-contract change | VR — satisfied (RC contains no BDT/Simulation changes) |
| G-12 | rollback owner and stop conditions named | pending |

## 4. What remains before any production step

1. Owner-run read-only gates G-1 to G-6; their output attached to the release record.
2. Written owner confirmation of the dependency-scan exception (14 advisories, scan step only) and of the test-only commit on the RC.
3. A clean production image built on the release host or CI from `d41b08e4`; `smoke-test.sh` with `EXPECTED_BUILD_SHA`; image digest recorded.
4. Owner decisions G-10 and G-12; a maintenance window; a fresh backup and restore proof (G-4).
5. Separate authorization for execution (schema step first, then API), per RP-06 §6D.
6. DEP-REM-1 (dependency remediation) as an independent block, if the owner wants it.

## 5. Verdict

The RC is complete and, on disposable infrastructure, behaves as designed. Production release readiness is NOT established:
production-side facts are owner-observed only, gates G-1 to G-6 and G-10 to G-12 are open, and CI cannot be green because of the
inherited dependency advisories. Verdict: NO-GO pending those items.
