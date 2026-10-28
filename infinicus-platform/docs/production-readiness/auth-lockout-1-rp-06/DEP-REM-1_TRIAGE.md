# DEP-REM-1 — Dependency Advisory Triage for the Deployed Base (`ccadbf51`) and the AUTH-LOCKOUT-1 RC

Status: ANALYSIS AND DOCUMENTATION ONLY. No change to the RC, `main`, a lockfile, a migration or production.
Authorization basis: owner request to proceed with possible development while RP-12A waits for production evidence.
Companion to `RP-08_RC_BUILD_AND_CI_EXCEPTION.md` (the exception covers the 14 advisories listed there).
Labels: VR = VERIFIED — REPOSITORY, RH = VERIFIED — REHEARSAL (scratch checkout, nothing pushed), VC = VERIFIED — CI, INF = INFERRED.

## 1. Where the 14 advisories come from

`pnpm audit` and `infrastructure/deployment/scripts/check-dependency-vulnerabilities.mjs` run on the RC checkout reproduce exactly the 14 entries of CI
runs 40623929732 and 40624732139 (RH, VC). They arise from the dependency set of `ccadbf51`; the AUTH-LOCKOUT-1 patch changes no dependency file (VR).
`main` carries newer versions and its CI is green (run 700 on 10634e36, VC):

| Package | `ccadbf51` (deployed base) | `main` | Advisory patched from | Entries |
|---|---|---|---|---|
| `next` (apps/web) | 15.5.27 | 15.5.28 | 15.5.28 | 2 (critical GHSA-2464-fhr4-w9xw, high GHSA-p3m5-59mp-jv5r) |
| `fastify` (apps/api) | 5.12.5 | 5.12.6 | 5.12.6 | 1 (low) |
| `fast-uri` (transitive; 3.x and 4.x) | 3.1.8 / 4.1.5 | 3.1.9 / 4.2.3 (pnpm overrides) | 4.2.3 | 8 (moderate/low, 4 advisories × 2 copies) |
| `zod` (api, web) | 3.25.76 | 4.6.7 | 4.6.6 (major version) | 1 (high GHSA-mrhx-c7xc-m3w5) |
| `vite` (transitive via vitest 1.6) | 5.4.21 | 7.3.7 (with vitest 4.1.12) | 6.4.4 | 2 (low GHSA-9jrq-w75r-8gcw, moderate GHSA-rq7h-c2jc-7f22) |

## 2. Reachability in the production deployment (INFERRED from repository evidence)

| Package | Where it runs | Assessment |
|---|---|---|
| `next` | `apps/web` only. The OCI deployment (`deployment/oci/docker-compose.yml`) runs postgres, api, tools and caddy; the web app is the separate Cloudflare Pages site. No `"use server"` in web source (only an architecture test mentions it); no `next.config` image settings. | Not part of the VM API runtime. Present in the API image only because the Dockerfile copies the whole workspace (`COPY . .`) and installs devDependencies; never executed there. Exposure of the Pages site depends on how it is built and served (not assessed here). |
| `fastify` | API runtime | Low severity (header validation bypass). Reachable in principle by any request. |
| `fast-uri` | transitive (schema `$ref`/URI handling in the validator stack) | Moderate/low; attacker-controlled URIs reaching it are not evident (INF); fix is a safe patch override already used on `main`. |
| `zod` | API request validation | High (memory exhaustion on oversized constrained collections). Unauthenticated routes (`/v1/auth/register|verify-email|login`) validate strings only. Array-bearing bodies are on authenticated routes; the request body is bounded by Fastify's body limit (no custom `bodyLimit` is set in `apps/api/src`, so the framework default applies — to be confirmed on the running build). |
| `vite` | dev/test toolchain (vitest) only | Never started as a server; not executed in the production runtime (same rationale as the existing allowlist entries). |

## 3. Remediation tiers and rehearsal results

Rehearsal on a scratch checkout of the RC (changes were NOT committed, pushed or applied to the RC; the checkout was restored afterwards):

**Tier 1 — patch-level, low risk:** `apps/web` next `^15.5.28`; `apps/api` fastify `^5.12.6`; root `pnpm.overrides` `fast-uri@>=3.0.0 <4.0.0 → 3.1.9`,
`fast-uri@>=4.0.0 <5.0.0 → 4.2.3` (the same overrides `main` uses).
- Result (RH): `pnpm install --no-frozen-lockfile` succeeds; the dependency scan drops from **14 to 3** un-allowlisted entries
  (cleared: both `next` entries including the critical one, the `fastify` entry, all 8 `fast-uri` entries).
- Remaining (RH): `zod` GHSA-mrhx-c7xc-m3w5 (high) and the 2 `vite` entries (low, moderate).
- Build: 30/30 tasks; `api.integration`, `security.integration`, `lockoutUnavailable` tests 46 passed/2 skipped; `apps/web` tests 324 passed (RH). The full suite was not re-run.

**Tier 2 — `zod` 3.25.76 → ≥ 4.6.6 (major):** `main` did this in #345 with accompanying code/test adjustments (e.g. route-authority field audit in #343).
Backporting it to a base that is 135 commits behind is not a dependency bump; it needs code changes and a separate review.

**Tier 3 — `vite` ≥ 6.4.4:** only via the vitest 1.6 → 4.x upgrade that `main` already carries (tracked as issue #24). Dev-only.

## 4. Options for the RC (owner decision; nothing applied)

1. Keep the RC as is, with the approved exception for all 14 advisories (status quo, Option 3 of RP-08).
2. Apply Tier 1 to the RC (3 `package.json` edits + lockfile), keep the exception only for the remaining 3 (`zod` high, `vite` low and moderate).
   This removes the only critical advisory and 11 of 14 entries from the exception. It changes the RC beyond the auth patch: lockfile and three manifests,
   a new RC commit, and a re-run of the RP-09/RP-11 evidence on the new commit. It would need written owner approval before any push.
3. Release from `main` instead (all advisories resolved, CI green) — this is the full sequential release with migrations 0210–0221 and is no longer
   authentication-only.

Recommendation: option 2 if a CI exception of any size is uncomfortable, because it is the smallest change that removes the critical advisory and the
`next`/`fastify`/`fast-uri` findings without touching application code; option 1 if minimal delta to the deployed code matters more.

## 5. Not done

No RC change, no allowlist change, no `main` change, no dependency installed outside a discarded scratch checkout, no production access.
Reachability statements are inferences from the repository; none was tested against the running production build.

## 6. Outcome

The owner chose option 2 and authorized RP-13. Tier 1 was applied to the RC as commit `bea03e66`; see `RP-13_RC_DEPENDENCY_REMEDIATION.md`.
