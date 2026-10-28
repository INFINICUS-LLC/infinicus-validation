# AUTH-LOCKOUT-1.RP-08 — Release Candidate Build and CI Exception Record

Status: DOCUMENTATION ONLY. No migration, deployment, container restart or production access. Companion to
`ISOLATED_SECURITY_RELEASE_DESIGN.md` (RP-06). Evidence labels as defined there.

## 1. Release candidate

| Item | Value |
|---|---|
| Branch (remote) | `claude/auth-lockout-1-isolated-rc` (not for merge: `main` already contains #348) |
| Commit | `c5936cefe1aad5503132f538bb01fc8fd0679211` |
| Base | `ccadbf51be90c35377e21b73ceda77a1d455a805` (deployed build, OWNER-OBSERVED) |
| Delta vs base | 9 files, +215/−18; `git diff --stat ccadbf51 c5936cef` (VERIFIED — REPOSITORY) |
| Patch sha256 (matches RP-06) | `c899bd167cd6dc227044dae8236f5d88433fb757a024ada4972611ad8333de00` |
| `0220` file sha256 | `78a17188e4f01e7dbe78fb422578864345607c9a4eefeb30ea7f9913d1222472` |
| Dependency/lockfile/CI-script files changed | 0 (VERIFIED — REPOSITORY) |
| NEW-BDT-SIM-01 / migrations 0210–0219 present | no (gate G-8 / G-11 inputs) |

## 2. CI results (VERIFIED — CI)

| Run | Ref | Result | Failing step |
|---|---|---|---|
| 40623929732 (#704) | RC `c5936cef` | failure | Dependency vulnerability scan |
| 40624732139 | control: unpatched `ccadbf51` (workflow_dispatch) | failure | Dependency vulnerability scan |

Steps that passed on the RC before the failure: install, lint, typecheck, build (30/30 tasks), browser-secret check.
Steps NOT REACHED in CI (skipped after the failure): create least-privilege role, migration gate, grants, Test, image build and smoke test.
The control run fails identically on the unpatched base, so the failure is inherited from `ccadbf51`'s dependency set and
is not introduced by the AUTH-LOCKOUT-1 patch. The advisory database is live: `ccadbf51` passed on 2026-10-21 and fails now.

Un-allowlisted advisories reported on both runs (14 entries, 8 distinct packages/advisory families):
`next` GHSA-2464-fhr4-w9xw (critical, image-optimization RCE with SVG) and GHSA-p3m5-59mp-jv5r (high, Server Actions DoS);
`zod` GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion on oversized collections); `fastify` GHSA-389g-gv7q-r4x8 (low);
`vite` GHSA-9jrq-w75r-8gcw (low) and GHSA-rq7h-c2jc-7f22 (moderate); `fast-uri` GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h,
GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp (moderate/low). Reachability in the production API has NOT been assessed.

## 3. Owner decision (Option 3) and its meaning

The owner chose: release the authentication fix on the RC with a documented CI exception, and treat dependency remediation
as a separate block. Recorded consequences:

1. The RC is not changed to carry dependency upgrades, and no allowlist entry is added to the RC.
2. The standard CI gate "Dependency vulnerability scan" will not be green for the RC. This is an approved exception only
   for the AUTH-LOCKOUT-1 isolated release, scoped to the 14 advisories above as observed on 2026-10-28 on the control run.
   Any additional or different finding is outside the exception.
3. Because CI stops at that step, evidence that CI would normally produce must be supplied another way before production
   (approval checklist gates G-9, M-15, M-17 are re-scoped below). The exception waives the scan result only; it waives
   no test, no migration gate and no smoke test.
4. Dependency remediation (`next`, `zod`, `fastify`, `fast-uri`, `vite`, and reachability of each advisory in the API and
   web runtimes) is a separate, not-yet-authorized block (proposed name DEP-REM-1). It is not started.

## 4. Evidence that replaces the skipped CI steps

| Skipped CI step | Replacement required before production | Current status |
|---|---|---|
| Migration gate | Rehearsal on a disposable DB: RC runner/psql applies exactly `{0220}`; second run no-op | VERIFIED — REHEARSAL (RP-06) |
| Grants | `grant-app-role.sh` of the RC tree on the disposable DB | VERIFIED — REHEARSAL |
| Test (full suite) | Full RC test suite run on a disposable PostgreSQL 16 DB at 0209+0220, results attached | NOT RUN in full. Run so far: authentication package (60 passed/1 skipped), 30 API files that call `/auth/login` (420 passed/7 skipped), DB-02 RLS test (6/6) |
| Image build + smoke test | Build the image from the RC commit with `GIT_SHA`, run `smoke-test.sh` with `EXPECTED_BUILD_SHA` on a disposable stack | NOT RUN |

M-8 (negative control) — VERIFIED — REHEARSAL: the RC against a database WITHOUT 0220 returns HTTP 503 on login in
`api.integration`/`security.integration` tests and fails 4 of 6 DB-02 tests; with 0220 they pass. This confirms the
deploy-order rule: schema (0220) first, then the RC image.

## 5. Corrections to the RP-06 document

- RP-06 §1.1 describes the NEW-BDT-SIM-01 hand-off route on `main` as ungated. PR #352 (SEC-01, merged) makes it default-deny
  (no confidence policy configured → refused) and adds migration 0221. The route is still registered on `main`, `main` still
  carries migrations 0210–0221, and the isolated RC still excludes all of it. The RC design is unchanged.
- RP-06 §6 gate G-9 ("CI fully green on the RC commit") is replaced by this document's §3–§4: green CI is not achievable
  until DEP-REM-1; the approved exception and the replacement evidence apply instead.

## 6. Remaining items before any production step (all need separate authorization)

1. Full RC test suite on a disposable DB; image build and smoke test on a disposable stack (§4).
2. Owner-run production gates G-1 to G-6 (read-only).
3. Owner to confirm in writing the exception in §3, including the 14 advisories, before the production window.
4. Housekeeping: decide whether to delete `claude/auth-lockout-1-rc-control` (no longer needed) and keep the RC branch until release.
5. DEP-REM-1 scoping, if the owner wants it.
