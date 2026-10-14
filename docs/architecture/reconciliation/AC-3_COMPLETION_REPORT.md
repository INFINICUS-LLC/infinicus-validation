# AC-3 Completion Report — Criterion J final verification (Block 6)

Date: 2026-10-14. Verified head: `ccr-9ed397ed-7fggdr` = `main` (`2b2a0f1`, contains Blocks 1–4) + Block 5 (PR #132, open). Environment: local PostgreSQL 16 rebuilt from scratch (migration gate + app-role grants), mirroring `.github/workflows/ci.yml`. **No production access, no deploy, no migration applied anywhere but this local database.**

## Verdict
**Criterion J is NOT declared closed.** Every gap that can be closed in code is closed and verified. Closure is gated on four things the repository cannot supply: owner confirmation of the legacy production flags (J-4), the J-5 scope ruling, owner approval of the Block 4 design (Option B), and the coordinated production release of Block 4 (API config first, then the page).

## Per-gap status
| Gap | Fix | Status | Evidence |
|---|---|---|---|
| J-1 business scope (Stack B) | `BusinessScopeGuard.assertBusinessInScope` at every business-scoped workflow entry; foreign and unknown business give the same 404, no write | **VERIFIED COMPLETE (code)** | `ac3-j1-j6-business-scope` 19 tests; mutation M1 (guard disabled) fails 5 |
| J-6 approver grantee membership | `assertActiveWorkspaceMember`; one 400 for every ineligible reason | **VERIFIED COMPLETE (code)** | same suite; mutation M2 fails 3 |
| J-2 `apps/web` identity | identity/scope from session → membership → permission only; no query/form/body identity | **VERIFIED COMPLETE (code)**; deployment state of `apps/web` unknown | `noBrowserIdentity.architecture` + context tests (web 23 pass); mutation M3 fails 1 |
| J-3 derived shadow password | provider-verified token exchange; managed accounts have no password login | **IMPLEMENTED — release and owner approval pending** | `ac3-j3-identity-exchange` 19 + verifier 7 + `browser-credentials` 13; mutation (login block removed) fails 1 |
| J-7 API-base override | override honoured only on localhost for a loopback http origin; removed on the real site | **VERIFIED COMPLETE (code)** | real expression executed in `vm` under hostnames/overrides |
| J-4 legacy auth/business | default-deny middleware, structural test, repo guard against enabling | **CODE SAFE — production flag state UNKNOWN (open)** | `functions-routes` + `legacy-flags-guard`; mutation (flag in `wrangler.toml`) fails 2 |
| J-5 anonymous marketing endpoints | shared gate on all five; `send-email` disabled by default | **DOCUMENTED — scope ruling pending** | `functions-routes`/`functions-guard`; gap: no recipient-ownership proof if `EMAIL_MODE=live` |

## Verification run on the verified head
| Check | Result |
|---|---|
| `pnpm lint` (30 tasks) | PASS — 0 errors; warnings are pre-existing `no-console` / `detect-unsafe-regex` |
| `pnpm typecheck` (39 tasks, forced) | PASS |
| `pnpm build` (30 tasks, forced) with `DATABASE_URL` unset | PASS |
| `pnpm workspace:validate` | PASS |
| `check-no-browser-secrets.mjs` | PASS |
| `check-dependency-vulnerabilities.mjs` | PASS — 6 advisories, all allowlisted with reasons (two vite dev-server items, tinypool temporary until 2026-11-06) |
| CI package test set, 39 tasks, forced, fresh database | PASS — database 3501 (26 skipped), api 419 (12 skipped), business-operations-runtime 612, handoff-contracts 549, workflow 274 (1 skipped), event-worker 196, data-acquisition-runtime 94 (1 skipped), authentication 58 (1 skipped), configuration 46, event-contracts 38, onboarding 29 (1 skipped), authorization 25 (1 skipped), web 23, observability 18 |
| Root `node --test`: functions-routes, functions-guard, browser-credentials, legacy-flags-guard | PASS — 145/145 |
| Root `node --test`: build-public 40, github-pages 8, public-output-http 5 | PASS |
| Mutation controls M1, M2, M3 and the Block 4 / Block 5 controls | each caught; each reverted, tree clean |
| GitHub CI on PR #131 head | PASS (merged). PR #132 head `0cd2738`: `functions-routes` PASS |

## What is NOT verified (and why)
- Production values of `LEGACY_AUTH_API`, `LEGACY_BUSINESS_API`, `EMAIL_MODE`, `ALLOWED_ORIGINS` — no production access.
- Whether `apps/web` is deployed anywhere.
- Block 4 against a real Supabase project: the verifier is tested against a fake `fetch` only. The real contract (`GET /auth/v1/user`, `email_confirmed_at`) must be confirmed with a real test user during the release (step 2 below).
- Browser behaviour of the rewritten bridge was checked statically and by executing its URL expression; it was not driven in a real browser.

## Known limitations (carried forward)
`sessionStorage` is readable by same-origin script (short-lived revocable token) · `infinicus_user` still persists the provider id in `localStorage` (low) · a cached token that the API rejects is not retried inside its 10-minute window (low) · legacy shadow accounts keep an unusable old password hash · migrated legacy ids bind to the first user to exchange on a browser · legacy `auth/**` and `business/**` code is intentionally unhardened and stays default-deny · `change-password` calls in `account.html` / `landing.html` return 404 while default-deny holds · robustness: invalid foreign keys on some workflow routes surface as 500 instead of 404/409.

## Release procedure for Block 4 (one release)
1. Deploy the API with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set.
2. Verify: a made-up token gives 401 (503 means the config did not load); a real test user's access token gives 200 and a working session.
3. Then publish `index.html`. Rollback: API and page together; no data or migration changes.

## Open owner decisions
1. Approve Option B (no `SHADOW_ACCOUNT_SECRET`). Recommendation: approve.
2. Set `SUPABASE_URL` / `SUPABASE_ANON_KEY` in production and run the release procedure.
3. Confirm `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` are unset in production (Production and Preview). Recommendation: confirm, then delete the legacy code.
4. Rule J-5 out of scope for Criterion J. Recommendation: yes; keep `EMAIL_MODE` disabled until double opt-in.
5. Is `apps/web` deployed? If yes, confirm the session cookie (`inf_session`) is set by the platform.
6. Schedule the low and medium follow-ups above.

## Closure checklist for Criterion J
- [ ] PR #132 merged after CI and review
- [ ] Decision 1 and decision 3 recorded by the owner
- [ ] Block 4 released per the procedure, with the real-user check recorded
- [ ] Decision 4 recorded
When these are recorded, Criterion J can be declared closed by the owner; this report does not do so.
