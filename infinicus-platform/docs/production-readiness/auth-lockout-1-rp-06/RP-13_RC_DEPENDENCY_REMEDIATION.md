# AUTH-LOCKOUT-1.RP-13 — Patch-Level Dependency Remediation on the RC (final RC `bea03e66`)

Status: DEVELOPMENT ON THE RELEASE-CANDIDATE BRANCH ONLY + EVIDENCE. No migration, deployment or production access.
Authorization: owner chose Option 2 of `DEP-REM-1_TRIAGE.md` and authorized RP-13. Not an authorization to release.
Labels: VR = VERIFIED — REPOSITORY, VC = VERIFIED — CI, RH = VERIFIED — REHEARSAL (disposable local PostgreSQL 16 + local Docker, synthetic data).

## 1. Final RC identity

| Item | Value |
|---|---|
| Branch | `claude/auth-lockout-1-isolated-rc` (release branch; never merged to `main`) |
| Final commit | `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` |
| History on the base `ccadbf51` | `c5936cef` (AUTH-LOCKOUT-1 patch) → `d41b08e4` (migration-contiguity test, RP-10) → `bea03e66` (this block) |
| Delta vs `ccadbf51` | 14 files, +289/−84 (VR) |
| This block's change | `package.json` (fast-uri overrides), `apps/web/package.json` (next), `apps/api/package.json` (fastify), `pnpm-lock.yaml`. No source, test or migration file. |

Changes: `next` `^15.5.24` → `^15.5.28` (resolves 15.5.28); `fastify` `^5.12.5` → `^5.12.6` (resolves 5.12.7); root `pnpm.overrides`
`fast-uri` 3.x `3.1.8 → 3.1.9`, 4.x `4.1.5 → 4.2.3` (the same overrides `main` uses). Lockfile changes are limited to `next`, `@next/swc-*`, `fastify`
and `fast-uri` (VR, diff reviewed). Fastify resolved to 5.12.7, one patch above the requested floor.

## 2. Dependency scan

| State | Un-allowlisted advisories |
|---|---|
| `ccadbf51` and RC `c5936cef`/`d41b08e4` (CI runs 40623929732, 40624732139, 40630982518) | 14 (VC) |
| RC `bea03e66` (local scan, RH; CI run 40656714935 fails at the same step) | 3 |

Remaining (exception scope after this block): `zod` GHSA-mrhx-c7xc-m3w5 (high; fix needs zod ≥ 4.6.6, a major upgrade, see DEP-REM-1 Tier 2) and `vite`
GHSA-9jrq-w75r-8gcw (low), GHSA-rq7h-c2jc-7f22 (moderate) (dev toolchain only; fix needs the vitest 4 upgrade, Tier 3). Cleared: both `next` advisories
including the only critical one, the `fastify` advisory, and all eight `fast-uri` entries. The image built from this commit contains `fastify@5.12.7`,
`fast-uri@3.1.9` and `fast-uri@4.2.3` (checked inside the running container, RH).

## 3. Evidence on `bea03e66`

| Evidence | Result | Label |
|---|---|---|
| Workspace build | 30/30 tasks | RH |
| CI Test command (same filters as `ci.yml`), DB at 0209+0220 | all packages pass: observability 18, configuration 46, event-contracts 38, data-acquisition-runtime 94, authorization 25, onboarding 29, handoff-contracts 549, web 324, event-worker 233, workflow 274, business-operations-runtime 612, authentication 60 | RH |
| database package | 90 files, 3562 passed, 26 skipped (clean re-run on a fresh DB) | RH |
| api package | 53 files, 633 passed, 12 skipped | RH |
| continuous-learning layer | 26/26 block tests passed | RH |
| Image | `infinicus-api:rc-bea03e66`, id `sha256:61df0ceae7e5aa8ef64325c871ddb7f0e5db464cba4a8480e47f42bdf87812e4`, built with `GIT_SHA=bea03e66…` | RH |
| Container start, health, smoke | `/v1/ready` 200; `/v1/health` version = `bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5`; `smoke-test.sh` with `EXPECTED_BUILD_SHA` all 4 checks passed | RH |
| Lockout in the container (synthetic account) | register 201; login 200; 5 wrong passwords 401; correct password after 5 failures → HTTP 429 `AccountLockedError`; unknown email 401; 0 `LockoutStateUnavailable` log lines | RH |
| CI run 40656714935 | fails at "Dependency vulnerability scan"; later steps not reached | VC |

Honest note on the run history: the first full run of this commit showed two database-package timeouts (`cl-repositories` 5 s, `delete-tenant-data` 60 s) while an
image build and smoke test were running in parallel on the same machine. Both files passed when run alone (124 passed, 2 skipped), and a complete re-run of the
database, api and continuous-learning suites with nothing else running passed with no failure. The timeouts are attributed to that load (INFERRED); no code
changed between the runs.

Caveats: the image carries the sandbox proxy CA (not a production artifact; production image must be built clean on the release host or CI). `dast-scan.sh`
was not run. CI cannot reach the Test step while any scan entry remains, so the Test-step evidence is local.

## 4. Effect on earlier documents

- Final RC identity everywhere is now `bea03e66` (supersedes `c5936cef` in RP-08 and `d41b08e4` in RP-11 for identity; their evidence tables describe those earlier commits).
- Exception scope for gate G-9 shrinks from 14 advisories to 3 (`zod` high, `vite` low and moderate). The owner's written confirmation, if given, should name these 3.
- The RP-06 patch file (`auth-lockout-1-isolated-release.patch`) still describes the first 9-file auth patch only; the later commits are listed in §1.

## 5. Remaining before any production step (unchanged ownership)

Owner-run gates G-1 to G-6 (`rp12a-collect.sh` output), written confirmation of the 3-advisory exception, G-10/G-12 approvals, a clean production image build
from `bea03e66`, and separate authorization for execution. Verdict stays NO-GO / INSUFFICIENT EVIDENCE until then.
