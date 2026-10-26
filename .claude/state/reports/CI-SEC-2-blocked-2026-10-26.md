# CI-SEC-2 — Dependency security remediation: blocked compatibility review

Date: 2026-10-26 (Kuwait)
Status: BLOCKED BEFORE DEPENDENCY EDITS — OWNER REVIEW REQUIRED
Authorization: DEVELOPMENT ONLY

## Outcome and references

Authoritative main was fetched and checked at `6a89cca7e6cf843c34cce5c670695ea37e025fbf` (PR #341).
No open pull requests were returned by GitHub's open-PR inventory. Inspection of fetched branches and commit history found no completed CI-SEC-2 remediation.
Branch: `development/ci-sec-2-dependency-compatibility-review`, created from that exact commit.
This draft PR documents the investigation only. It does not remediate vulnerabilities and must not be treated as security clearance.

The owner's instruction to stop on unresolved compatibility/security conflicts applies: the patched Zod major does not satisfy the installed Fastify Zod provider's peer contract. No dependency edits or upgrade trials were made after identifying that conflict.

## Package and advisory evidence

| Package | Installed | First security fix / candidate | Applied |
|---|---|---|---|
| zod | 3.25.76 | 4.6.6 (latest stable observed: 4.6.7) | No |
| fast-uri, major 3 | 3.1.8 | 3.1.9 | No |
| fast-uri, major 4 | 4.1.5 | 4.2.3 | No |

The live npm audit returned 9 findings: 1 high, 4 moderate, 4 low. These represent five unique GHSA identifiers; each fast-uri advisory is reported once for each installed major.

| Advisory | Package | Severity | Affected range returned by audit | Patched range |
|---|---|---|---|---|
| GHSA-mrhx-c7xc-m3w5 | zod | high | <4.6.6 | >=4.6.6 |
| GHSA-w74x-v6f9-j3xg | fast-uri | moderate | >=3.0.0 <3.1.9; >=4.0.0 <4.2.3 | >=3.1.9; >=4.2.3, in respective major |
| GHSA-xhq7-xmqj-769h | fast-uri | low | >=3.0.0 <3.1.9; >=4.0.0 <4.2.3 | >=3.1.9; >=4.2.3, in respective major |
| GHSA-wjr9-j795-jxcr | fast-uri | moderate | >=3.1.3 <3.1.9; >=4.0.1 <4.2.3 | >=3.1.9; >=4.2.3, in respective major |
| GHSA-333x-w4r6-6crp | fast-uri | low | >=3.0.0 <3.1.9; >=4.0.0 <4.2.3 | >=3.1.9; >=4.2.3, in respective major |

All nine remain unresolved. No allowlist entries were added, renewed, removed or changed.

## Dependency graph and compatibility blocker

`pnpm why zod fast-uri --recursive` confirms:

- Zod 3.25.76 is used by apps/api, apps/web, packages/database and packages/data-acquisition-runtime, plus fastify-type-provider-zod and zod-to-json-schema.
- fast-uri 3.1.8 enters through ajv 8.20.0 and json-schema-resolver 3.0.0 / @fastify/swagger 9.8.1.
- fast-uri 4.1.5 enters through @fastify/ajv-compiler 4.0.7 and fast-json-stringify 7.1.3.

The lockfile records `fastify-type-provider-zod@4.0.2` with peers `fastify: ^5.0.0` and `zod: ^3.14.2`. Zod >=4.6.6 cannot satisfy that Zod peer range. The live npm registry lists 3.25.76 as the newest stable Zod 3 version; there is no published stable Zod 3 fix in the inspected metadata.

This is a declared peer incompatibility, not a measured failed Zod 4 upgrade. No experimental upgrade was performed. The API installs the provider's validatorCompiler, serializerCompiler and jsonSchemaTransform in apps/api/src/app.ts, so forcing the peer would affect request validation, response serialization and OpenAPI generation.

Source inspection also found one-argument z.record calls in API schemas such as businesses.ts, dataAcquisition.ts and abaAuthoring.ts. These require explicit compatibility assessment in a Zod migration; no schema or frozen contract was changed.

Dependency settings currently exist in both infinicus-platform/package.json and pnpm-workspace.yaml. The lockfile's effective fast-uri overrides are 3.1.8 and 4.1.5, while the workspace file retains older exact-version rules. A future remediation must verify effective resolution and avoid unrelated settings cleanup.

## Verification actually executed in this session

Commands below were run from the repository root unless stated otherwise. pnpm commands used the downloaded pinned pnpm 10.33.0 executable, not the host's pnpm 11.25.0.

| Command / check | Result |
|---|---|
| git fetch origin main; git rev-parse HEAD; git status --short | Exact baseline verified; clean before report creation |
| Pinned pnpm --version | 10.33.0 |
| pnpm audit --json (in infinicus-platform) | Exit 1; 9 findings: 1 high, 4 moderate, 4 low |
| pnpm why zod fast-uri --recursive (in infinicus-platform) | Exit 0; dependency paths above confirmed |
| node infrastructure/deployment/scripts/check-dependency-vulnerabilities.mjs (in infinicus-platform, pinned pnpm on PATH) | Exit 1; same 9 unallowlisted findings |
| node --test infinicus-platform/infrastructure/deployment/scripts/check-dependency-vulnerabilities.test.mjs | Exit 0; 12 passed, 0 failed, 0 skipped |
| node infinicus-platform/infrastructure/deployment/scripts/check-dependency-vulnerabilities.mjs --allowlist-only | Exit 0; 2 existing entries, none expired |
| node scripts/build-control/build-preflight.mjs CI-SEC-2 | Exit 0; 219 migrations, highest 0219; legacy queue reports BUILD-33 as ready, not advanced |
| node --test scripts/build-control/tests/build-preflight.test.mjs | Exit 0; 5 passed, 0 failed, 0 skipped |
| node infinicus-platform/scripts/validate-workspace.mjs | Exit 0; 38 passed, 0 failed |
| node scripts/build-control/check-frozen-migrations.mjs /tmp/ci-sec-2-evidence/frozen-baseline.json | Exit 0; 232 tracked files matched hashes derived from the starting commit: 219 migrations and 13 locked architecture specifications |
| pnpm install --frozen-lockfile (in infinicus-platform) | Started, then interrupted after the stop decision; exit 130. No successful install claimed; tracked manifests and lockfile unchanged. |
| Initial frozen-check invocation without a baseline argument | Exit 2 (usage); rerun with generated baseline passed as above |

Migration 0219 SHA-256:
`e04f71a3a85fbd86b5c889448237fcec663d2930c71b27c66fc7597e2468ae08`

Aggregate migration-set SHA-256 reported by preflight:
`04d21dfaeab9fc9072c2dc65da7eb03e99ebdad05075812f0fe5b7c960fb1e00`

Not run in this session after the stop decision: patched lockfile generation, lint, typechecks, builds, static export, complete architecture/regression suites, PostgreSQL migration/integration tests, image smoke tests or DAST. No pass is claimed for a patched dependency graph.

## GitHub CI evidence

The existing main run [40220891210](https://github.com/INFINICUS-LLC/infinicus-validation/actions/runs/40220891210) belongs to the exact starting commit, not to a remediation.

Its validate job completed with failure. Logs show lint (30/30 tasks), typecheck (40/40 tasks), build (30/30 tasks), static export, browser-secret check, allowlist compliance, migration gate, grants, PostgreSQL tooling and regression tests (41/41 tasks) passing. The dependency scan printed the nine findings, and Enforce security gates failed on DEPENDENCY_SCAN=failure. Image build/smoke was skipped.

The API's dependency-scan step conclusion appeared as success in the jobs response despite the logged failure and final enforcement failure. The log and enforcement outcome establish that the scan did not pass. No scan workflow was modified.

This report-only branch does not match the platform CI's changed-path filters. Do not represent checks on this documentation PR as validation of dependency fixes. Final PR URL, head SHA and observed PR-check status are provided in the owner handoff rather than embedded self-referentially in this commit.

## Architecture reconciliation and recommended resolution

Reviewed the root execution instructions, platform CLAUDE.md, locked Master Architecture Manifest, Layer Guidance / Cold-Start Standard and Dual-Mode Experience Standard.

No architecture change was implemented. Domain/layer ownership, canonical contracts/events, source-of-truth rules, authorization, tenant isolation, provenance, experience modes and all frozen files remain unchanged.

Recommended owner decision: authorize a bounded Zod 4 compatibility migration within CI-SEC-2, including a Fastify-compatible provider version supporting patched Zod, schema/type adaptations preserving existing accepted/rejected payload behavior, response serialization and OpenAPI regression evidence. First inspect that provider's current primary documentation and peer requirements; no replacement version is selected or verified by this report.

Resume only after the compatibility scope is resolved. Then apply the fast-uri same-major fixes, upgrade all four Zod consumers coherently, regenerate with pnpm 10.33.0, and run security, typecheck/build, architecture, request/response/OpenAPI and full CI regression checks. If existing schema semantics cannot be preserved, stop again rather than changing frozen contracts.

A separately authorized fast-uri-only block could remove eight findings while leaving the Zod high finding open; that would not complete CI-SEC-2.

## Changed files and residual risk

Only this investigation report was added. No application source, dependency manifest, lockfile, migration, architecture contract, security gate, allowlist or queue state was modified.

All nine findings remain present; development and release readiness must not be inferred from this PR. No production access, deployment, database access, automatic merge or next block was performed.

Current Module: CI-SEC-2 — Dependency Security Remediation
Completed Blocks: Investigation and compatibility/security evidence only; remediation not completed
Remaining Blocks: Compatible Zod migration decision, dependency fixes, lockfile regeneration and full validation
Next Recommended Block: Owner review of the bounded Zod 4 compatibility migration scope
Estimated Remaining Blocks: Undetermined until compatibility scope is approved
