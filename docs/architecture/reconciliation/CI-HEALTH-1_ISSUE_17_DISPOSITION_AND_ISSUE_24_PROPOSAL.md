# CI-HEALTH-1 - issue #17 disposition and issue #24 upgrade proposal

Date: 2026-10-21. Base: `main` at `cfb85c4`. Block CI-HEALTH-1 of CORE-ARCHITECTURE-01. Evidence was gathered on a fresh local PostgreSQL 16 (migrations 0001-0209) and from the GitHub CI history; commands are given so each line can be repeated. Nothing here changes a dependency version.

## 1. What the CI defect was

On 2026-10-20 the dependency scan failed on `main` (runs #195 to #207). Because it was an ordinary step, the job stopped there: the migration gate, grants, tests and image build were skipped (their absence is what #209 described). A single scan finding therefore hid every other result. #209 allowlisted three new advisories; runs #505 to #507 are green.

## 2. Issue #17 - disposition by item (current `main`)

| # | Item in the issue | Result | Evidence |
|---|---|---|---|
| 1 | Web build type failure: `apps/web/app/businesses/page.tsx` treats `PagedBusinesses` as an array | **OBSOLETE (not reproducible)** | `pnpm typecheck` 39/39 and `pnpm build` 30/30 pass at this head, including `@infinicus/web` (`next build`). The CI build step that the issue says fails passes (CI runs #505, #506, #507). |
| 2 | API tests hard-code `ssl: true` | **OBSOLETE** | `grep -rnE "ssl: *true" apps packages --include=*.ts` finds no test or source occurrence; SSL comes from `DB_SSL` in `packages/configuration`. All API tests pass against a non-SSL PostgreSQL (api 652 passed). |
| 3 | Empty-string UUID in audit/auth fixtures | **OBSOLETE** | No `actorId/userId: ''` fixture exists (`grep -rnE "(actorId\|userId\|actor_id\|user_id): *''"` finds only a test that asserts `''` is rejected). Full suite: 0 failures. |
| 4 | `"test": "vitest run"` without a local `vitest` | **OBSOLETE** | A scan of every `apps/*`, `packages/*`, `layers/*` manifest finds no package with a vitest test script and no vitest dependency. |
| 5 | Fastify `disableRequestLogging` deprecation | **STILL REPRODUCIBLE - FIXED IN THIS BLOCK** | Fastify 5.12.5 emitted `FSTDEP023` 53 times in one test run. `apps/api/src/app.ts` now sets the same behaviour through `LogController` (no Fastify upgrade). Test `apps/api/tests/requestLoggingConfig.test.ts` fails if the deprecated option returns or request logging is re-enabled (both mutations caught). |

The issue also asks for "report exact current results; do not rely on historical green logs": the figures above are from this session's runs. Recommendation: close #17 after the owner has read this table (item 5 is fixed by this block's PR).

## 3. CI behaviour after this block

- Browser-secret check, a new offline allowlist-compliance check and the dependency scan each run to completion with `continue-on-error`, so lint, typecheck, build, the migration gate, grants and tests always run and report.
- A final step, "Enforce security gates" (`if: !cancelled()`), writes a gate table to the job summary and **fails the job if any gate failed**. `validate` therefore still fails exactly as before and still blocks `build-and-smoke-test-image`. No gate can turn into a pass.
- `continue-on-error` is used only on those three gates. Lint, typecheck and build remain blocking (the tests need the build output).

## 4. Allowlist expiry guard

Each TEMPORARY entry in `check-dependency-vulnerabilities.mjs` carries `expires: 'YYYY-MM-DD'` (the review-by date, inclusive). From the following UTC day the entry allowlists nothing and the guard fails with a message naming the entry. Structural errors also fail: a TEMPORARY entry without `expires`, an impossible date, a reason that states a different date, duplicate advisory ids. The date is the real UTC date; there is no flag or environment override. `--allowlist-only` runs the check offline. 12 unit tests (`node --test`) cover boundary, expiry, malformed data and the no-override rule.

**Expected consequence:** on 2026-11-07 CI will fail by design unless issue #24 is closed or the owner renews the dates. That is the purpose of the guard.

## 5. Issue #24 - upgrade proposal (NOT part of this block)

Current: `vitest ^1.6.x` declared by 22 workspace manifests (dev dependency), resolving `vite 5.4.21`, `esbuild 0.21.5`, `tinypool 0.8.4`. Only two `vitest.config` files exist (a 180 s test timeout and a 60 s hook timeout in one); two test files use `vi.mock`/spies. The audit lists 9 advisories, all via `vitest`:

| Advisory | Package (found) | Patched |
|---|---|---|
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (critical) | tinypool 0.8.4 | >= 2.1.2 |
| GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm | vite 5.4.21 | >= 6.4.4 |
| GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff | vite 5.4.21 | >= 6.4.3 |
| GHSA-67mh-4wv8-2f99 | esbuild 0.21.5 | >= 0.25.0 |

**Target:** `vitest 4.1.x`. Reasons: vitest 3.2.x still depends on `tinypool ^1` (no patched 1.x exists, so 3.x would not clear the two critical findings); vitest 4.1 has no `tinypool` dependency and accepts `vite 6 || 7 || 8`, which resolves the vite and esbuild findings; its Node range (`^20 || ^22 || >=24`) fits the Node 22 used by CI and the API image. `vitest 5` needs Node >= 22.12 and is newer than needed; not recommended for this step.

**Plan (each step its own owner-authorized change):**
1. Cross-session notice to the POS session: the change touches the `package.json` of POS-owned packages (`apps/web`, `apps/api`), `pnpm-lock.yaml` and CI. Agree a freeze window; do not run it in parallel with POS merges.
2. Pilot on the packages with no database dependency (`configuration`, `observability`, `event-contracts`). Record config and behaviour differences.
3. Move the remaining packages in groups; `@infinicus/database` last, because its suite is long and uses live PostgreSQL and a 180 s timeout.
4. Verify: lint, typecheck, build, the full CI test set (same counts as today: database 3556, api 652, bo-runtime 621, handoff 549, web 324, workflow 274, event-worker 233 ...), image build, `pnpm audit` clean.
5. Delete the five TEMPORARY entries and the esbuild entry if the audit no longer reports it; close #24.
Rollback: revert the lockfile and manifests commit; nothing else depends on the change. Risk: vitest 1 to 4 default/behaviour changes (pool defaults, mock hoisting, snapshot/formatting) can cause test-only failures; the pilot exists to find them. Schedule: the guard makes 2026-11-06 the deadline; the upgrade needs roughly two to three owner-reviewed PRs.
