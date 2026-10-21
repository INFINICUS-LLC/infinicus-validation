# CI-SEC-1 - assessment of GHSA-9jrq-w75r-8gcw and GHSA-rq7h-c2jc-7f22

Date: 2026-10-21. Workstream CORE-ARCHITECTURE-01. **Assessment only: no dependency, lockfile, allowlist or workflow file is changed by this document.** Tracked under issue #24.

## 1. Why main is red

Since main run #523 (2026-10-21 18:42 UTC) the job `validate` fails at "Enforce security gates". The dependency scan (`check-dependency-vulnerabilities.mjs`, which runs `pnpm audit`) reports two advisories published after the current allowlist was written, and it fails closed as designed. Everything else on main is green: on run #528 (the merge of OM-OBS-1) lint, typecheck, build, the migration gate, grants and the full Test step all succeed, and only the gate step fails (which also skips `build-and-smoke-test-image`). The same is true of the PR #225 head run. Reproduced locally: the script prints `Dependency scan FAILED - 2 un-allowlisted advisory(ies)` naming exactly these two.

## 2. The advisories

| | GHSA-9jrq-w75r-8gcw (CVE-2026-112945) | GHSA-rq7h-c2jc-7f22 (CVE-2026-112946) |
|---|---|---|
| Package | vite | vite |
| Severity | low | moderate |
| Affected versions | <= 6.4.3 | <= 6.4.3 |
| Patched | >= 6.4.4 | >= 6.4.4 |
| Flaw | A malicious site can make a Vite dev server load attacker script into a page it serves | `/@fs/` can return host files outside `server.fs.allow` when a root-relative path matches an absolute system path (non-Windows) |
| Needed to be exploitable | The app uses Vite in middleware/SSR mode and passes the browser's unchanged request URL to `server.transformIndexHtml`, the page has an inline module script, and the page holds sensitive values or critical actions | The Vite dev server is explicitly exposed to the network (`--host` / `server.host`), a project file's root-relative URL equals a readable absolute host path, the file is not in `server.fs.deny`, non-Windows |

## 3. Affected versions and dependency paths

`pnpm audit` finds one version, **vite 5.4.21**, through `apps/api > vitest > vite` and `apps/admin > vitest > vite`. It is transitive: `vite` is declared by no workspace manifest. It arrives with `vitest 1.6.1` (declared `^1.6.x` by the workspace packages), whose `vite` and `vite-node` ranges are `^5.0.0`. The same vite 5.4.21 already carries five allowlisted advisories (three permanent entries, three issue-#24 TEMPORARY entries).

## 4. Reachability (verified, not assumed)

- **Test runs (CI and local):** every package test script is `vitest run` (verified across manifests). In vitest 1.6.1 `vitest run` builds its Vite server with `middlewareMode: true`, `hmr: false`, `watch: null` (`vitest/dist/vendor/cli-api.*.js`, around the `createServer` calls) and the `api` option defaults to `{ middlewareMode: true }` when `--api`/`--ui` are absent. No port is bound and no HTML is served. The only `server.listen()` in that file is the **browser-mode** path; no vitest config in the repository enables browser mode (the two `vitest.config.ts` files set only timeouts), and no script uses `--ui`, `--api` or `--browser`.
  - GHSA-9jrq-w75r-8gcw needs an HTML-serving dev server and a browser: **not reachable**.
  - GHSA-rq7h-c2jc-7f22 needs a network-exposed dev server: **not reachable**.
- **CI:** GitHub-hosted runners are ephemeral and accept no inbound connections; only `vitest run` executes vite code. **Not reachable.**
- **Production runtime:** this is *not* zero exposure in the sense of presence. `apps/api/Dockerfile` runs `pnpm install --frozen-lockfile` (devDependencies included) in the build stage and the runtime stage copies `/repo` including `node_modules`. The vulnerable files therefore sit on the production image filesystem. The container runs `node dist/server.js`; nothing starts, imports or serves Vite. The risk is presence only (an attacker who already has code execution in the container gains nothing from an unstarted dev server).
- **Local development:** `vitest run` only. A developer who runs a separate Vite dev server is outside this repository's scripts.

## 5. Does a patched release exist, and can a targeted correction remove the finding?

Yes. `vite >= 6.4.4` exists, installs and builds here. A **pnpm override** of the single transitive package removes the vulnerable code without upgrading vitest.

Trial (in a scratch worktree; the repository on disk is unchanged): adding `"vite": "6.4.4"` to the root `package.json` `pnpm.overrides` resolves vite 6.4.4 and, through it, esbuild 0.25.12. Results:

| Check | Result |
|---|---|
| `pnpm audit` vite and esbuild advisories | **all removed**: both new advisories, plus the six already-allowlisted vite entries and the esbuild entry |
| Remaining advisories | tinypool 0.8.4, two critical (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr), already under TEMPORARY entries expiring 2026-11-06 |
| `turbo run build` | pass |
| Tests with vite 6.4.4 on vitest 1.6.1 | configuration 46, observability 18, event-contracts 38, handoff-contracts 567, OM runtime 97, web 331, api 663, authorization 25, event-worker 235, workflow 274: all pass |
| Parallel run | four first-DB-test failures, all `Test timed out in 5000ms` (default timeout, contended local database); each package passes when run alone. Environmental, not caused by vite |

A second override, `"tinypool": "2.1.2"` (the patched release), was also tried: with both overrides the repository's own dependency scan prints **"Dependency scan passed - 0 advisories found"**, and the packages sampled with it (configuration 46, handoff-contracts 567, event-contracts 38, OM runtime) pass. See section 8 for the wider run.

## 6. Caveats of the override

- It pairs `vitest 1.6.1` (declares `vite ^5`) with vite 6: **outside vitest's supported range**. Everything exercised passed, but the CI set in full on both overrides, the image build and the remaining packages have to be confirmed in CI before it is relied on.
- `tinypool 2.1.2` is likewise outside `vitest 1.6.1`'s declared `^0.8.3`.
- It is a stopgap. The durable fix remains the issue #24 plan (vitest 4.1.x). The overrides should be deleted with that upgrade.
- The change touches the root `package.json` and `pnpm-lock.yaml`, which POS sessions also depend on: needs a cross-session notice and a short freeze, as the #24 plan already requires.

## 7. Decision options

1. **Recommended - real fix first:** a small PR that adds the `vite` override (and, if the owner agrees, the `tinypool` override), regenerates the lockfile, and keeps the gate fully closed. After CI is green, a follow-up PR deletes the allowlist entries that no longer match anything. No exception is created. Residual risk: a small, tested version-skew between vitest and vite for a test-only toolchain; removable at the #24 upgrade.
2. **Narrow exception (only if the owner declines or the override fails in CI):** add the two advisories as TEMPORARY entries, expiring no later than 2026-11-06, tracked under issue #24, with the reasoning in section 4. The existing fail-closed gate and the expiry guard stay unchanged. Draft entries (NOT applied):

```js
{
  githubAdvisoryId: 'GHSA-9jrq-w75r-8gcw',
  package: 'vite',
  expires: '2026-11-06',
  reason: 'TEMPORARY (issue #24, review by 2026-11-06). Needs a Vite dev server in middleware/SSR mode that passes the browser request URL to transformIndexHtml and serves HTML to a browser. vite 5.4.21 is only a transitive dependency of vitest@1.6.1; `vitest run` uses a middlewareMode server with no port bound and serves no HTML; no vite/--ui/--api/browser mode is used anywhere (verified in vitest source and every test script). Present in the API image filesystem (devDependencies are installed) but never started. Fix needs vite >= 6.4.4 (issue #24). Remove when the vitest/vite toolchain is upgraded.',
},
{
  githubAdvisoryId: 'GHSA-rq7h-c2jc-7f22',
  package: 'vite',
  expires: '2026-11-06',
  reason: 'TEMPORARY (issue #24, review by 2026-11-06). Needs a Vite dev server explicitly exposed to the network (--host/server.host). vite 5.4.21 is only a transitive dependency of vitest@1.6.1; no vite server is listening or exposed in CI, local test runs or the API image (never started). Fix needs vite >= 6.4.4 (issue #24). Remove when the vitest/vite toolchain is upgraded.',
},
```

3. Do nothing: main stays red and `build-and-smoke-test-image` stays skipped on every push. Not recommended.

## 8. Residual risk

- With option 1 and a green CI: no known advisory remains in the audit; residual risk is the unsupported vitest-vite pairing (test-only), plus the long-term need to complete issue #24.
- With option 2: low. Both advisories are unreachable in CI and production as shown; the files remain present on the production image until #24 lands; the expiry guard forces a decision on 2026-11-07 at the latest.

## 9. What was not done

No allowlist change, no manifest or lockfile change in the repository, no workflow change, no vitest upgrade, no production or image action.
