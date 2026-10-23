# CL intake boundary CI fix — completion report

Date: 2026-10-23 (Asia/Kuwait). Tested base: `a126a4961c404c5822d16201d574f579e7ec255e`.
Branch: `fix/cl-intake-evidence-boundary`. Status: local checks passed; draft PR / Linux CI pending.

## Problem and scope completed

The CI runs for #273 failed because CL-01 directly imported and constructed an OM verification reader and the learning boundary, and defaulted to a concrete CL repository. This violated existing ownership and dormant-learning guards introduced before CL-01. The code paths came from separate #271/#272 changes, not the BDT integrity patch.

CL intake now requires two explicit capabilities: an OM-owned release factory and an intake persistence writer. It receives released evidence references through the existing gate's sink; it no longer reads OM verification facts, constructs the gate, or provisions a writer by default. Invalid or omitted dependencies fail immediately. No production factory or consumer is wired.

OM owns a new type-only `LearningReleaseFactory` composition seam. The gate implementation, eligibility decision, outcome vocabulary, handoff contracts and all existing architecture guards remain unchanged. CL-02 quarantine and failure propagation remain intact. No new runtime gate, alternate eligibility rule or activation is introduced.

## Files

Modified:
- `infinicus-platform/layers/continuous-learning/src/CLIntakeService.ts`
- `infinicus-platform/layers/continuous-learning/tests/cl-intake.test.mjs`
- `infinicus-platform/packages/outcome-monitoring-runtime/src/LearningReleaseBoundary.ts` (type alias only)
- `.github/workflows/build-32.yml` (adds CL and OM-runtime trigger paths: its ownership guards scan those sources, so their changes must run the job)

Created: this report.

## Validation and tests

Commands run from `infinicus-platform/` unless noted.

| Command/check | Result |
|---|---|
| `pnpm --filter @infinicus/layer-continuous-learning... build` | Passed, including the intake and its dependency graph |
| `pnpm --filter @infinicus/business-operations-runtime... build` | Passed |
| `pnpm --filter @infinicus/layer-continuous-learning --filter @infinicus/outcome-monitoring-runtime lint` | Passed |
| `pnpm --filter @infinicus/outcome-monitoring-runtime typecheck` | Passed; CL types checked by build |
| `pnpm --filter @infinicus/layer-continuous-learning test` | 8/8 intake tests and 26/26 block test files passed |
| `pnpm --filter @infinicus/outcome-monitoring-runtime exec vitest run --maxWorkers=2` | 90 passed, 7 database-dependent tests skipped (no database configured for this fix) |
| `pnpm --filter @infinicus/business-operations-runtime exec vitest run tests/ac2-chain-ownership.architecture.test.ts` | 10 passed |
| `pnpm --filter @infinicus/handoff-contracts exec vitest run --maxWorkers=2` | 601 passed |
| Targeted fault injection in the isolated checkout | 3/3 killed: implicit dependencies accepted, OM gate skipped, quarantine reasons erased. Passing baseline required; original source restored and rebuilt in cleanup |
| Diff checks | Passed; original guard tests and frozen handoff contracts have no diff |

The three previously failing suites (`p0-6d.architecture`, `cl-boundary-1.architecture`, `ac2-chain-ownership.architecture`) all pass unchanged. Intake tests use the real OM boundary with injected synthetic readers and writer spies. They cover verified release and lineage, pending outcome refusal, tenant/workspace isolation, lookup failure, malformed handoff, quarantine, persistence failure and a gate returning without invoking its sink.

## Security, idempotency and rollback

The single OM gate retains responsibility for looking up scoped evidence and refusing any unverified or unavailable source. CL sees released references only. No repository queries, persistence logic, idempotency keys or replay semantics changed. The constructor now requires `(releaseFactory, writer)` instead of optional `(sourceReader, writer)`; all repository callers were tests and are updated. Future production composition remains deliberately unwired and subject to the existing architecture guards.

No migrations, production database access, infrastructure changes, deployment, merge, CL activation, Stack A or POS/H-5B changes. No local database was provisioned for this fix. Reverting this application change requires no schema rollback, but would restore the CI failures.

## Known limitations and remaining verification

No live database regression was run locally because this fix adds no persistence or query behavior; Linux CI remains required for full database verification. The operations CI path filter previously omitted both CL and OM runtime; the two added paths ensure this patch and future changes in those guarded sources trigger the check. No architecture guard was relaxed to make tests pass. No additional full-scope or operational credit is earned: the recorded matrix remains 30.6%, and 90% is not reached.

## Queue

Current: CL intake boundary CI repair. Next: verify both Linux CI jobs on the draft PR; owner review and merge. No automatic merge or activation.
