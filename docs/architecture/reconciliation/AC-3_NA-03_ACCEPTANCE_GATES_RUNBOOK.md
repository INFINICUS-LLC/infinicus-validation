# AC-3 NA-03 — Option B acceptance gates A–E: evidence runbook

Date: 2026-10-15. Base: `main` at `15846f3`. Authority: `AC-3_OPTION_B_OWNER_DECISION.md` (§9 gates), `NEW-ARCH-R0_WEB_ARCHITECTURE_DECISION.md`.

**Status: PREPARED. Every gate is NOT VERIFIED.** This document is a procedure and an evidence register. It contains no production result and no configuration value. Nothing in it has been executed against production, Cloudflare, Supabase or any live database. It authorises nothing beyond what the owner separately approves (see §7). Criterion J remains **OPEN**.

## 0. How this was prepared, and what could not be done
- Prepared from the repository only (documentation, no code, Compose, CI, migration or environment change).
- Claude could not run the read-only public probes for Gate C. The session's network policy denies the host `api.infini-cus.com` (HTTP 403 from the gateway on CONNECT), so no result for it exists. **No result is fabricated.** Either the owner runs the commands below, or the owner adds that host to the environment's allowed domains and asks for the probes to be run (read-only `GET` requests only; no authenticated or state-changing request).
- Rules for everything below: never paste a key, token, URL containing a key, or `.env` content into a report. Report pass/fail, counts, hostnames of public services, and commit SHAs only.

## 1. Gate A — Configuration readiness
Requirement (Option B record §9 A): `SUPABASE_URL` and `SUPABASE_ANON_KEY` correct and reaching the API container; the endpoint is the authorised INFINICUS Supabase project; no development endpoint or other identity provider accepted in production.

Facts from the repository (VERIFIED-IN-REPO): the verifier accepts **one** configured URL (`identityVerifier.ts`: single `SUPABASE_URL`, https required, loopback http only); an unset URL or key makes the exchange answer 503 (closed); the Hetzner and OCI Compose files pass both to the `api` service only and refuse to resolve without them.

Owner checks on the VM (run from the directory the live stack was started from; the live Compose project is named `oci`, so pass `-p oci` if the directory name differs):
```bash
# A1 resolves (prints nothing on success)
docker compose -p oci config --quiet && echo "compose resolves"
# A2 both variables reach the running api container (names only, no values)
docker compose -p oci exec api sh -c 'for v in SUPABASE_URL SUPABASE_ANON_KEY; do [ -n "$(printenv $v)" ] && echo "$v: set" || echo "$v: MISSING"; done'
# A3 the key is an anon/publishable key, not a service/secret key (prefix and role only)
docker compose -p oci exec api sh -c 'printenv SUPABASE_ANON_KEY' | cut -c1-14
docker compose -p oci exec api sh -c 'printenv SUPABASE_ANON_KEY' | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '"role":"[a-z_]*"'
# A4 the host the API verifies against (a public hostname)
docker compose -p oci exec api sh -c 'printenv SUPABASE_URL' | sed -E 's#^https?://([^/]+).*#\1#'
```
Project match (A5): compare the A4 hostname with the Supabase host used by the live site (`createClient(` in the served page; public). Report only "match" or "no match".

| Check | Pass condition |
|---|---|
| A1 | prints `compose resolves` |
| A2 | both `set` |
| A3 | `"role":"anon"` for a JWT-style key, or prefix `sb_publishable_`; **fail** on `service_role` or `sb_secret_` |
| A5 | match, and the project is the production INFINICUS project, not a development or test project (owner confirmation) |
| A6 | `POST /v1/auth/identity-exchange` with a made-up token returns **401** (503 = not configured; 404 = old API without the route). Example: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.infini-cus.com/v1/auth/identity-exchange -H 'content-type: application/json' -d '{"accessToken":"not-a-real-token-for-gate-a-check"}'` |

Owner Step 2 relation: if A2 shows both set, Step 2 is satisfied and nothing further is needed for it.

## 2. Gate B — Legacy endpoint isolation
Requirement: `LEGACY_AUTH_API` and `LEGACY_BUSINESS_API` disabled in Cloudflare **Production and Preview**; `EMAIL_MODE` not `live`; legacy endpoints default-deny; no route bypasses the middleware.

Repository facts (VERIFIED-IN-REPO, see `AC-3_BLOCK5_J4_J5_ASSESSMENT.md`): `functions/api/auth/**` (5 routes) and `functions/api/business/**` (9 routes) are gated by `_middleware.js` and answer 404 unless the flag is exactly `enabled`; `send-email` answers 503 unless `EMAIL_MODE` enables it; `legacy-flags-guard.test.mjs` fails CI if a tracked file enables a flag. The repository cannot show the **production** values.

Owner checks:
1. Cloudflare dashboard, Pages project `infinicus-validation`, Settings → Variables and Secrets. For **Production** and for **Preview** record, for each of `LEGACY_AUTH_API`, `LEGACY_BUSINESS_API`, `EMAIL_MODE`: *absent*, *set to a non-enabling value*, or *enabling* (`enabled` / `live`). Also record whether the separate project `infinicus-security-preview` exists and whether the same variables are set there. Do not record any secret value.
2. Live default-deny confirmation (read-only; expected **404**; any other code is a fail to report):
```bash
for p in auth/login auth/register auth/request auth/verify auth/change-password business/summary business/events business/twin business/decisions business/manage; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://infini-cus.com/api/$p" -H 'content-type: application/json' -d '{}'
done
```
3. `send-email`: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://infini-cus.com/api/send-email -H 'content-type: application/json' -d '{}'` expected 503 (disabled) or a 4xx validation refusal; an unexpected 2xx is a fail. Do not send a real address.
4. Repeat 2 and 3 against one Preview deployment URL if one exists.

| Check | Pass condition |
|---|---|
| B1 six cells (3 variables x 2 environments) | none enabling |
| B2 ten legacy routes | all 404 |
| B3 send-email | 503 or refusal, never success |
| B4 route inventory | no new file under `functions/api/**` outside the gated families (CI structural test passes on `main`) |

## 3. Gate C — Deployment inventory
Requirement: evidence for which application serves `infini-cus.com`, whether Cloudflare Pages auto-deploys `main`, the API version at `api.infini-cus.com`, public-site/API compatibility, and whether `apps/web` is deployed anywhere.

Known (REPO-DOC, `AC-3_COMPLETION_REPORT.md`): GitHub Pages workflow deploy job is skipped unless `PAGES_DEPLOY_FROM_ACTIONS` is `true`; a Cloudflare Pages preview check runs on every PR (project `infinicus-security-preview`); the production serving path is **unconfirmed**.

Owner checks:
```bash
# C1 API build (compare "version" with the SHA on the VM; "unknown" means built without GIT_SHA)
curl -s https://api.infini-cus.com/v1/health ; echo
git -C /opt/infinicus/repo rev-parse HEAD            # on the VM; path per your server
docker compose -p oci images api                      # on the VM: image age
# C2 which page is served: R1 page contains both markers; pre-#131 page lacks the first
curl -s https://infini-cus.com/ | grep -c 'inf_backend_account_v3'
curl -s https://infini-cus.com/ | grep -c 'revokeBackendToken'
# C3 who serves it (headers only)
curl -sI https://infini-cus.com/ | grep -i -E '^(server|cf-ray|via|x-powered-by|last-modified|etag|age)'
```
Dashboard/GitHub evidence to record (yes/no or short text):
- Cloudflare → Pages → `infinicus-validation`: production branch; whether automatic production deployments from Git are on; the latest production deployment's commit SHA and time; custom domains attached (is `infini-cus.com` attached to this project?).
- GitHub → repository Settings → Pages (source), and Settings → Secrets and variables → Actions → Variables: is `PAGES_DEPLOY_FROM_ACTIONS` set, and to what.
- DNS for `infini-cus.com`: which provider answers (Cloudflare proxy or other).
- `apps/web`: any Pages project, VM service, container or DNS name for it. Repository says none (no Dockerfile or deploy workflow); expected answer "not deployed".

| Check | Pass condition (recorded, not assumed) |
|---|---|
| C1 | `version` equals a known `main` SHA at or after `130bf5a` (R1); recorded with date |
| C2 | page marker counts say whether the live page is the old or new generation |
| C3/dashboard | one serving path identified; auto-deploy behaviour known |
| C4 compatibility | page generation and API generation form a supported pair (see §5 matrix); if both are new, state "New/New" |
| C5 | `apps/web` not deployed, or its host is identified |

## 4. Gate D — Real identity-provider verification
**Live requests need separate, explicit owner authorisation before any are made, and a dedicated test identity. Customer accounts are never used.** Not authorised by this document. Claude has not been given a test identity.

Prerequisites to request: (1) an authorised test user in the production Supabase project with a confirmed email, owned by the owner, with a disposable tenant/workspace/business for the test; (2) a second test user for the switching and isolation cases; (3) a written "go" naming the environment and time window; (4) a rollback/cleanup note for the test tenant (a data change is the owner's decision).

| # | Case | Expected result | How observed |
|---|---|---|---|
| D1 | Garbage token to the exchange | 401, no session, no account | HTTP code; no new `identity.users` row |
| D2 | Expired or revoked provider token | 401 | HTTP code |
| D3 | Valid test token | 200, managed email `shadow-…@infini-cus.local`, `rawSessionToken` returned | response shape (do not record the token) |
| D4 | Repeat D3 with the same identity | same managed user id, new session | user id equal |
| D5 | Existing-account compatibility | if the identity previously existed under the legacy derivation, the same managed user is resolved (no duplicate) | user id equals the pre-existing one |
| D6 | Managed account via password login and register | login 401, register 400 | HTTP codes |
| D7 | Session use | `GET /v1/auth/session` 200; a business route without membership 403/404 | HTTP codes |
| D8 | Membership and permission | member with permission succeeds; member without permission 403; other tenant's business 404 | HTTP codes |
| D9 | Logout | `POST /v1/auth/logout` 204; the same token then 401 | HTTP codes |
| D10 | User switching in the browser | after switching users, the first user's server session is revoked (token 401) | the first user's saved session token (read from the test browser's session storage before switching) returns 401 afterwards |
| D11 | Revoked/expired session refused | 401 on any protected route | HTTP code |
| D12 | Unaffected sessions | a second session of the same identity stays valid after D9 on the first | HTTP code |

Any failure stops the test and is reported before anything else is attempted.

## 5. Gate E — Release compatibility, procedure and rollback
The browser/API compatibility matrix, the safe sequencing and the rollback consequence are in `infinicus-platform/docs/production-readiness/ac3-r1-release-compatibility.md` and are **not repeated here**. Two corrections of emphasis after the owner's reports on 2026-10-15 (OWNER-REPORTED, see `PRODUCTION_FACTS_OWNER_REPORTED_2026-10-15.md`: API deployed and health-checked, successful browser sign-in): the system may **already** be in the "New browser / New API" row; Gate C decides this, so do not run the sequencing in that document blindly. If Gate C shows the live page is the old generation, the "Old/New" row applies and the deployment of the page is the urgent step.

Go/no-go checklist before any release step (record yes/no):
1. Gates A, B and C evidence recorded for the current day.
2. A recent restorable backup exists and its restore proof is recorded (the repository documents tooling, not a production proof).
3. The commit to release is identified (SHA) and its CI is green.
4. Rollback target identified (previous page deployment and previous API commit) and the rollback consequence for first-time exchange users accepted by the owner.
5. A low-traffic window chosen; users told that open tabs need a reload.
6. The person who validates after release (Gate D cases that are authorised) is present.
Rollback triggers: any Gate D failure after release; sustained 5xx or `failed_auth` surge in the first hour; sign-in impossible for the test identity.

## 6. Evidence register (all NOT VERIFIED until filled)
| Gate | Evidence item | Collected by | Date | Result | Where stored |
|---|---|---|---|---|---|
| A | A1–A6 | | | NOT VERIFIED | |
| B | B1–B4 | | | NOT VERIFIED | |
| C | C1–C5 | | | NOT VERIFIED | |
| D | D1–D12 | | | NOT RUN | |
| E | Checklist 1–6, rehearsed rollback | | | NOT VERIFIED | |
| Option B final acceptance | Owner written acceptance | owner | | NOT GIVEN | |

## 7. What this document does not do
Does not authorise any live request, deployment, merge, configuration change, secret rotation, test identity, migration, worker activation, or the start of NA-04. Does not close Criterion J. Findings F1–F7 stay open as recorded in the Option B decision record.
