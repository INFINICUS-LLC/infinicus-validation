# CORE-ARCHITECTURE-01 / NEW-BDT-01 integrity completion report

Date: 2026-10-23 (Asia/Kuwait). Stack B only. Base: `bfc991419e6e95248359463725bcb5c6bda81103`.
Branch: `core-architecture/new-bdt-01-verification`.

At final remote verification, main advanced to `1c530ebcd4fdc6d721a92d321c6e325f89e8ff5e` through separate Continuous Learning PRs #271 and #272. Their changed paths do not overlap this patch. This branch retains the exact tested base above; no CL changes were rebased, edited, activated or scored here. CI of the proposed merge result remains required.

## Status

COMPLETE for this bounded local implementation and verification block; draft review and new PR CI pending. The full Windows API run is not green (baseline failures detailed below). Full-scope 90% completion is not achieved.

## Scope completed

Current main already contains the requested BI -> Business Digital Twin integration, merged in #270. This block closes two remaining integrity gaps rather than reimplementing it:

- Malformed persisted evidence previously could throw during integrity verification (for example, an object instead of a currency array). The additive performance-evidence validator now returns an invalid verdict for malformed containers, coverage, provenance, impossible calendar dates and cross-check rows. Missing domains remain explicit and carry no figures.
- Assembled evidence now owns a detached copy. Mutating a source BI report or caller-owned period after assembly cannot change its sealed figures or invalidate its digest.
- Added contract and live PostgreSQL tests, including another workspace in the same tenant. Added a reproducible targeted mutation runner that requires passing baselines and restores all mutations in `finally`.
- Reconciled the completion matrix with merged #270; no score credit for this unmerged hardening.

BI remains the only KPI authority. BDT copies the existing financial and sales evidence verbatim, per currency, with source provenance and deterministic evidence digests. No KPI recalculation, currency conversion or new BI authority was added. Evidence determinism means identical report inputs yield identical content and digest; snapshot IDs and observation timestamps remain lifecycle metadata. Digests detect content changes, not malicious administrator re-signing or external source authenticity.

### Prior PR reconciliation

| PR | Verified GitHub state | Main disposition |
|---|---|---|
| #243 | Merged, closed, 2026-10-22 | DAL-owned intake reader and rejection handling retained |
| #244 | Merged, closed, 2026-10-22 | NEW-BI-01 financial report retained |
| #257 | Merged, closed, 2026-10-22; base was `core-architecture/new-bi-01` | Did not merge into main; its replacement on main is BI-SALES-1. Superseded, not revived |
| #270 | Merged, closed, 2026-10-23 | NEW-BDT-01 is current main `bfc9914` |

#270 head `e78174f` passed CI validate, operations-runtime and image smoke tests. Evidence: [CI run 39895545770](https://github.com/INFINICUS-LLC/infinicus-validation/actions/runs/39895545770). These are previous merged-feature results, not CI results for this follow-up.

## Files created

- `infinicus-platform/scripts/test-bdt-performance-mutations.mjs`
- `docs/completion-reports/CORE-ARCHITECTURE-01_NEW-BDT-01-integrity-report.md`

## Files modified

- `infinicus-platform/packages/handoff-contracts/src/bi-performance-evidence.ts`
- `infinicus-platform/packages/handoff-contracts/tests/bi-performance-evidence.contract.test.ts`
- `infinicus-platform/packages/workflow/src/performance/biPerformanceEvidence.ts`
- `infinicus-platform/packages/workflow/tests/bdt.performanceEvidence.test.ts`
- `infinicus-platform/packages/workflow/tests/BusinessPerformanceTwinService.integration.test.ts`
- `docs/architecture/bdt/NEW-BDT-01_BI_TO_BDT_PERFORMANCE.md`
- `docs/architecture/completion-matrix/work-packages.json`
- `docs/architecture/NEW_ARCHITECTURE_COMPLETION_MATRIX.md` (generated)

## Migration range

None added or changed. Existing migrations through 0212 were applied only to a new disposable local synthetic-test database. No production migration was executed.

## Validation

Commands below run from `infinicus-platform/`. Dependencies installed with the frozen lockfile; no dependency changes. Local runtime: Windows, Node 24.16.0, pnpm 10.33.0 (repository version), PostgreSQL 16.15. CI uses Node 22.

| Command | Result |
|---|---|
| `pnpm --filter @infinicus/api... build` | Passed (API and dependency graph) |
| `pnpm --filter @infinicus/api... typecheck` | Passed; handoff-contract types also checked by its build |
| `pnpm --filter @infinicus/handoff-contracts --filter @infinicus/workflow lint` | Passed; two existing unsafe-regex warnings in unchanged financial files |
| `node scripts/test-bdt-performance-mutations.mjs` | 13/13 targeted mutants killed; passing baselines required |
| `node scripts/completion-matrix.mjs --check` | Passed: 69 work packages, 13 guardrail criteria |
| `node scripts/completion-matrix.mjs --write-doc` | Generated matrix matches scoring input |
| `node --check scripts/test-bdt-performance-mutations.mjs` and `git diff --check` | Passed |

## Tests

| Command | Result |
|---|---|
| `pnpm --filter @infinicus/handoff-contracts exec vitest run --maxWorkers=2` | 25 files, 601 passed |
| `pnpm --filter @infinicus/workflow exec vitest run --maxWorkers=2` | 24 files, 384 passed, 1 skipped |
| `pnpm --filter @infinicus/database exec vitest run tests/financial-facts-repository.integration.test.ts tests/sales-facts-repository.integration.test.ts --maxWorkers=2` | 22 passed |
| `pnpm --filter @infinicus/business-operations-runtime exec vitest run tests/FinancialFactsService.test.ts tests/SalesFacts.test.ts --maxWorkers=2` | 28 passed |
| `pnpm --filter @infinicus/api exec vitest run --maxWorkers=2` | 57 files passed, 5 failed; 713 tests passed, 19 failed, 12 skipped (744 total). Six timeouts cleared on rerun; remaining 13 reproduced with original main implementation |
| `pnpm --filter @infinicus/api exec vitest run tests/ac2-bi-evidence.integration.test.ts tests/printers.integration.test.ts --maxWorkers=2` | All 20 passed on full-file rerun, including all six earlier timeout cases |
| `pnpm --filter @infinicus/workflow exec vitest run tests/BusinessPerformanceTwinService.integration.test.ts` | 13 passed on final workspace-isolation fixture |
| `pnpm --filter @infinicus/api exec vitest run tests/businessPerformanceTwin.integration.test.ts` | 10 passed |
| `pnpm --filter @infinicus/api exec vitest run tests/businessPerformanceTwin.integration.test.ts tests/financialIntelligence.integration.test.ts tests/bi-sales-report.integration.test.ts --maxWorkers=2` | Final restored follow-up implementation: 41 passed |

The workflow skip is the existing no-database sentinel (`describe.skipIf(run)`); the real database tests ran. Targeted integrity cases cover malformed containers, impossible dates (including non-leap February 29), valid leap dates, missing-domain details, coverage, provenance, cross-check states/order/duplicates, copy isolation, persisted corruption and workspace isolation. Existing regression covers financial/sales BI authority, exact multi-currency amounts, matching periods/businesses, missing/insufficient evidence, authorization, idempotency, snapshot lifecycle and operational write boundaries.

### Windows baseline comparison

The full API run started at host time 07:24 and ended around 16:13, with reported durations over 31,000 seconds. Six existing printer/inventory-BI tests timed out in that run; both complete files subsequently passed (20/20). The long host-clock interval makes that first run unsuitable as a clean timing baseline.

For the other failures, temporarily restored both changed implementation modules from exact main `bfc9914`, rebuilt handoff-contracts/workflow, and ran the same three affected files. Baseline result: **32 passed, 13 failed, 1 skipped**, with the same 13 failures. The follow-up sources were then restored in `finally` and rebuilt. Failures:

- `buildTraceability.test.ts`: 5 failures; native Windows Node cannot resolve Git Bash `/tmp/...` module paths.
- `deploy-orchestration.integration.test.ts`: 2 failures; native Windows Node cannot resolve Git Bash `/c/.../package.json`.
- `deploymentCompose.test.ts`: 6 failures; text assertions split on LF and compare exact lines while this Windows checkout uses CRLF.

No test or implementation in those files was modified, and no platform/deployment workaround was added to the block. A clean Linux CI run remains required for this draft.

## Security and RLS

Tests used a new local container `codex-stackb-bdt-20261023`, RAM-backed database storage and a random loopback-only port. Application role was independently checked: `rolsuper=false`, `rolbypassrls=false`. Fixture-administrator credentials were synthetic and confined to that container. Malformed-state tests use the fixture administrator to simulate corruption and always restore triggers. No existing database, POS or H-5B container was used.

No Stack A files, frozen BUILD-12 contracts, operational financial/sales writers, POS or H-5B files changed. No production access, deployment, automatic merge, Continuous Learning activation or production data was involved.

## Idempotency and rollback

Existing API idempotency and twin publication transactions are preserved and exercised by regression tests. No schema rollback is required; revert the follow-up commit to restore prior application behavior. The mutation harness restores source files after each mutant and in outer cleanup. The local test container and its volumes were removed after checking its workstream label and resolving its exact container ID; no other container was touched.

## Completion matrix

| Basis | Previously recorded | Reconciled using merged #270 |
|---|---:|---:|
| Full scope (authoritative 90% target) | 30.16% (30.2 displayed) | 30.59% (30.6 displayed) |
| BDT layer | 22.74% | 27.15% (27.1 displayed by the generator) |
| BDT-2 implementation fraction | 0.09 | 0.23 |
| BDT-2 weighted score | 13.7% | 23.3% |
| BI layer | 23.59% | 23.59% |
| Guardrail slice | 78.9% | 78.9% |

Rubric: retain the existing inventory slice and add two partial domain representations (financial and sales, 0.75 unit each), approximately 2.5/11 domain units. Full financial/sales twins, general entity graph and other domains are not claimed. Existing integration/verification/operational dimensions remain unchanged; no duplicate credit for BI calculations or existing twin lifecycle. This draft reconciles evidence already merged on main. Its new hardening receives no additional implementation credit. Matrix documentation itself awaits PR review/merge. Gap to 90% remains 59.41 percentage points.

## Known limitations

- This is a bounded integrity follow-up to an already merged block, not full BDT completion or a new simulation/action capability.
- The frozen BUILD-12 handoff still lacks exact per-currency money. It is not modified or used here; #270's additive read-side integration and its documented boundary remain unchanged.
- No new UI, trend/detail twin, scheduling, automatic publication, simulation handoff, recommendation or operational activation.
- Mutation coverage is the 13 listed targeted faults, not a claim of exhaustive mutation coverage.
- Whole database/BO suites and browser tests were not rerun; relevant BI repository/service tests and full contracts/workflow/API suites were selected for this change. New PR CI remains independent.

## Unresolved defects

No defect attributable to this follow-up remains in completed checks. The 13 Windows baseline failures above remain unresolved in this environment and are disclosed rather than reported as passing. New PR Linux CI and owner review remain pending.

## Queue update

```text
current build: CORE-ARCHITECTURE-01 / NEW-BDT-01 integrity follow-up
next eligible step: draft PR review and CI; retain subsequent domain/simulation work in the governed architecture queue
90% checkpoint: NOT REACHED
merge/deploy/production migrations/Continuous Learning activation: NOT PERFORMED
```
