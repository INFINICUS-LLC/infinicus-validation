# CI RELIABILITY AND HYGIENE OBSERVATIONS

**Status:** RECORD ONLY. Nothing here was investigated further or changed. Each item says what was seen, what is known, what is not, and the trigger for investigating it. Evidence is from GitHub Actions on `INFINICUS-LLC/infinicus-validation`, 2026-10-07.

## 1. migration-gate idempotency test failed once (not reproduced)

| Field | Value |
|---|---|
| Test | `packages/database/tests/migration-gate.integration.test.ts` > "is idempotent — a second run against the same database also exits 0 with nothing new to apply" (line 68: `expect(stdout).toContain('Migration gate passed.')`) |
| Where | PR #14 head `581f6a7`, push-event run `37627359510`, `validate` job `112812456931`, first attempt (13:20:36Z) |
| Symptom | The gate's captured stdout held the `Running migration gate…` header and the per-migration `skip` lines but not the final `Migration gate passed.` line. The assertion on the previous `exits 0` check did not fail. |
| Not reproduced | The same commit passed in the parallel pull-request run (`37627366409`, `validate` job `112812480986`), and the failed job passed on its single re-run (`validate` job `112814179700`). The same test passed in earlier runs before the CI filter was added. |
| Known | The failing test is in `packages/database`, not in the newly added `@infinicus/data-acquisition-runtime` package; that package's 94 tests passed in every run. |
| Not known | Why the success line was missing. Whether running `data-acquisition-runtime` in parallel with `database` tests (same job, same service Postgres) raises its likelihood: it passed twice with the filter present, so no causal link is shown. No hypothesis was verified. |
| Investigate if | the same test fails again on any commit, or fails twice in a row anywhere. Then capture the job's full `stdout`/`stderr` of the second gate run, and compare timing against the `database` suite. A failure that repeats must not be answered by raising a timeout. |

## 2. Lockout tests exceeded the 5 s default (resolved, monitored)

`AuthenticationService.integration.test.ts` lockout tests timed out at 5000 ms in CI runs 207, 214 and 215 and passed locally in about 2 s (bcryptjs, about 7 operations per test). PR #26 gave the two affected tests an explicit 20 s per-test timeout; no assertion, threshold, bcrypt cost or logic changed, and mutation checks confirmed the tests still fail on their assertions. After the fix the authentication test file took about 51 to 52 s in CI (22 s locally), with every test inside its limit.
**Investigate if** any lockout test times out at 20 s, or shows an assertion failure, deadlock or abnormal runtime. Do not raise the timeout again; report instead.

## 3. Log noise: "[auth] lockout check failed (treating as not locked) … invalid input syntax for type uuid: ''"

About 33 to 39 occurrences per CI run, all from the `@infinicus/api:test` step (stack: `AuthenticationService.login` line 144). It was already present in the PR #23 and PR #14 runs before PR #26. The lockout check is written to fail open and only logs. Not changed.
**Follow-up:** a small separate look at which API tests pass an empty user id, and whether the fail-open path is exercised in production. Belongs with the identity block (V-05/V-04).

## 4. No workflow ran `@infinicus/data-acquisition-runtime` (fixed on PR #14)

The package held the webhook header-policy tests and the live-database webhook tests, yet no workflow listed it. PR #14 adds `--filter=@infinicus/data-acquisition-runtime` to the `validate` test step. Until PR #14 merges, `main` still has the omission.

## 5. Repository hygiene (kept out of every remediation PR)

- The repository root has no `.gitignore`; local builds recreate an untracked `.turbo/` cache that the session's stop hook flags. It is deleted, not committed. Proposed as a small separate hygiene change (add `.turbo/` at the root).
- `infinicus-platform/.gitignore` already ignores `.turbo/` for builds run inside that folder.
