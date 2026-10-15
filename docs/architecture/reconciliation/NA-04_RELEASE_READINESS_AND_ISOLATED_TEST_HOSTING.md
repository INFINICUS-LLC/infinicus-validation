# NA-04 release readiness, NA-03 gates A/B/C evidence, isolated test hosting design

Date: 2026-10-15. Base: `main` at `bc33ab9` (NA-04 merged). Mode: read-only verification, non-production rehearsal, planning. **Nothing was applied to production, deployed, merged, configured or restarted by this block. No credential, token, URL of the Supabase project, or environment file was read or recorded.** Criterion J remains **OPEN**. Option B remains **conditionally approved**.

Labels used throughout: **OBSERVED** (seen in this session, with time), **REPO-VERIFIED** (read in the repository at `bc33ab9`), **OWNER-REPORTED** (stated by the owner, no artefact), **OWNER EVIDENCE REQUIRED** (cannot be established from here; never marked PASS), **PROPOSED** (a plan, not done).

## 1. PR #138 (REPO-VERIFIED / OBSERVED)
| Item | Result |
|---|---|
| State | **Merged** into `main` on 2026-10-15 14:42:10Z by the owner's account (not a draft; not merged by Claude). Merge commit `bc33ab9`. |
| Head / base | Head `e06284f` (1 commit); base `e503c10`. 39 files, +2066/−7. No conflicts (it merged). |
| Merged tree = reviewed tree | `git diff e06284f bc33ab9` is empty. |
| CI on `e06284f` | `validate` success (lint, typecheck, build, tests on a fresh database with all 199 migrations), `build-and-smoke-test-image` success, `operations-runtime` success, Cloudflare Pages preview success. No failure. |
| Review threads | None. |

Implementation inspected (not just the report): migration 0199, `MembershipRepository.listActiveForUser`, `GET /v1/auth/memberships`, the browser client (`apps/web/lib/client`, `apps/web/app/(client)`), the architecture guards. Tests re-run on `bc33ab9` this session: web 74 passed; database 3507 passed / 26 skipped; API 455 passed / 12 skipped; lint 30/30 tasks; typecheck 39/39 tasks (local PostgreSQL 16 mirroring ci.yml; not a substitute for GitHub CI, which is green above).

**Finding F-0199-1 (accuracy of a safety claim; no code defect found).** The comments in migration 0199 and in `listActiveForUser` say the function "cannot be used to list another user's memberships even by an application bug that passes a wrong argument". That is stronger than the mechanism. The repository sets `app.user_id` from the *same* argument it passes to the function, so the check is a consistency check: it stops any caller that does not set `app.user_id` (for example a direct SQL caller, an injection, or other code calling the function) and any mismatch between argument and setting, but it does **not** stop the repository itself being called with a wrong user id. The protection against that is the route, which passes only `request.session.user.id` (REPO-VERIFIED; tested by a mutation control). Proposed correction: reword both comments; no behavioural change. Needs owner authorization (a migration comment is part of an immutable merged file; a wording fix belongs in the doc and repository comment, not in 0199).

## 2. Gate A — Supabase configuration
| Check | Result |
|---|---|
| Production API container has `SUPABASE_URL` / `SUPABASE_ANON_KEY` | **OWNER EVIDENCE REQUIRED.** Cannot be seen from outside. Indirect: the deployed API exposes `POST /v1/auth/identity-exchange` (OBSERVED, see §4); the owner reports a successful browser sign-in (OWNER-REPORTED). Neither proves correct configuration. |
| Variables reach the container through Compose | REPO-VERIFIED: both Compose definitions pass them with `${VAR:?}`; the stack cannot resolve without them. Whether the *running* stack was started from that definition is OWNER EVIDENCE REQUIRED. |
| Points at the authorised project; key is anon, not secret | **OWNER EVIDENCE REQUIRED.** Procedure and value-free commands: `AC-3_NA-03_ACCEPTANCE_GATES_RUNBOOK.md` §1 (A1–A6). |
| Invalid token rejected (401, not 503) | **Not performed.** It is a live authentication request; needs separate authorization (Gate D). Owner reported 401 (OWNER-REPORTED). |
**Gate A: NOT VERIFIED.** Presence ≠ correctness; neither is established by observation.

## 3. Gate B — legacy endpoint isolation (OBSERVED 2026-10-15 ~14:5x UTC, read-only `GET`/`OPTIONS`; no `POST`)
| Check | Result |
|---|---|
| `LEGACY_AUTH_API` / `LEGACY_BUSINESS_API` on the production custom domain | The 10 gated paths (`/api/auth/{login,register,request,verify,change-password}`, `/api/business/{summary,events,twin,manage,decisions}`) and the 4 `decisions/*` sub-paths all answer **404 to both `OPTIONS` and `GET`**. REPO-VERIFIED: when the flag is `enabled`, `login` and `summary` define `OPTIONS` handlers that would answer 204, so 404 is what a default-deny gate produces and an enabled route would not. **Strong evidence the flags are not `enabled` for the production deployment; not the dashboard value.** |
| Same for Preview | **Not observable.** The `*.pages.dev` preview hosts are blocked by this session's network policy. **OWNER EVIDENCE REQUIRED** (Cloudflare → Variables, Preview column). |
| `EMAIL_MODE` | **OWNER EVIDENCE REQUIRED.** `/api/send-email` is reachable by design (`OPTIONS` 204, `GET` 405 from the shared anonymous-route gate); the mode is only visible by a `POST`, which was not made. `/api/nurture` and `/api/nurture-batch` answer 503. |
| `ALLOWED_ORIGINS` (legacy Functions) | OBSERVED via `OPTIONS /api/waitlist`: `https://infini-cus.com` and `https://www.infini-cus.com` allowed; `https://next.infini-cus.com` and a foreign origin refused (403). |
| `CORS_ALLOWED_ORIGINS` (API) | OBSERVED via `OPTIONS /v1/auth/memberships`: `https://infini-cus.com` echoed; `https://next.infini-cus.com` and a foreign origin **not** echoed. Allowed methods header: `GET, POST, PATCH, DELETE, OPTIONS` (**no `PUT`**). |
| Repository guard | REPO-VERIFIED: `legacy-flags-guard.test.mjs` fails CI if a tracked file enables a flag. |
**Gate B: PARTIAL.** Production default-deny behaviour observed; Preview and `EMAIL_MODE` need owner evidence. The Swagger UI/spec at `/documentation*` is public (known finding, unchanged).

## 4. Gate C — deployment inventory
| Check | Result |
|---|---|
| Running API commit | **Not identifiable.** OBSERVED `GET /v1/health` → `{"status":"ok","version":"unknown"}`: the image was built without `GIT_SHA` (the build arg defaults to `unknown`; `INFINICUS_BUILD_SHA` is baked from it). **OWNER EVIDENCE REQUIRED:** on the VM, `git rev-parse HEAD`, `docker compose -p oci images api`, `docker inspect` image id and creation time. |
| API generation (fingerprint) | OBSERVED: the deployed API's public OpenAPI lists **96 paths; the route set and methods equal `main`'s exactly except `GET /v1/auth/memberships`** (main has 97). So the running API's routes are `main` before NA-04 (it has identity-exchange and logout, not memberships). This bounds the generation; it cannot distinguish route-neutral commits and is **not** a commit identity. `/v1/ready` → 200. |
| Live page | OBSERVED earlier today: byte-identical to `index.html` on `main` including the R1 code (the pair is New browser / New API). The legacy page does not call `/v1/auth/memberships`, so NA-04 changes nothing for it. |
| Production Git checkout / tracked branch | **OWNER EVIDENCE REQUIRED** (VM). Owner reported the remote was changed to this repository and `main` synchronised to `130bf5a` (OWNER-REPORTED, older than `bc33ab9`). |
| Cloudflare publication mechanism, auto-deploy, custom domain, production branch | **OWNER EVIDENCE REQUIRED** (dashboard). OBSERVED only: `server: cloudflare`; the served page equals `main`, so *some* publish path for `main` is active. |
| DNS provider and records | **OWNER EVIDENCE REQUIRED.** No DNS client is available in this session. `next.infini-cus.com` has no known record. |
| `apps/web` deployed anywhere | REPO-VERIFIED: no Dockerfile, no deployment workflow, no host. **OWNER EVIDENCE REQUIRED** that nothing outside the repository serves it (dashboard / VM). |
| Deployment and rollback arrangements | REPO-VERIFIED: `hetzner/runbook.md` (initial deploy and redeploy order), `deploy.sh`/`version.sh`/`smoke-test.sh`, `docs/incident-response/runbooks/{deployment-rollback,migration-rollback,restore-procedure}.md`, and `ac3-r1-release-compatibility.md`. Not rehearsed on production. A production backup/restore proof is not documented in the repository (OWNER-REPORTED rehearsal only). |
**Gate C: PARTIAL.** API generation and live-page generation established by observation; everything that needs the VM, Cloudflare or DNS is OWNER EVIDENCE REQUIRED.

## 5. Migration 0199 — inspection and non-production rehearsal
Inspected (REPO-VERIFIED): one `CREATE OR REPLACE FUNCTION tenancy.list_active_memberships(uuid)`; `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp`; every object schema-qualified; no dynamic SQL; raises `42501` unless the argument equals `current_setting('app.user_id')`; selects only `m.status = 'active'` rows with non-deleted workspace and tenant for that user; returns ids, names and statuses (no roles, permissions, emails); `REVOKE ALL … FROM PUBLIC`; registers itself in `_migrations`; no table, policy, grant or data statement; idempotent.

Rehearsal environment: a **disposable database created for this purpose on the session's local PostgreSQL 16 cluster** (host 127.0.0.1, database `infinicus_rehearsal`, created and dropped in this session; never pointed at production). Steps and observed results:
| Step | Result |
|---|---|
| Rebuild the "before" state: apply `0001`–`0198` | 198 files applied, 198 registered, function absent |
| Application-role grants, then seed 2 users / 2 tenants / 2 workspaces / 3 memberships (one suspended) | done; data snapshot (counts + md5 per table) and `pg_dump -Fc` backup taken |
| Apply `0199` through the real migration gate, re-run `grant-app-role.sh` | applied; 199 registered; app role holds EXECUTE |
| Catalog | owner = migration admin; `prosecdef` true; `provolatile` = stable; `proconfig` = `search_path=pg_catalog, pg_temp`; ACL = owner + app role only; **PUBLIC has no EXECUTE**; an unprivileged role gets *permission denied* |
| Behaviour as the **application role** | matching user → exactly that user's 2 active workspaces; user with only a suspended membership → 0 rows; asking for another user → `42501`; NULL argument → `42501`; no `app.user_id` → `42501`; empty `app.user_id` → `42501`; soft-deleted tenant excluded; direct read of `tenancy.memberships` across workspaces → 0 rows (policy unchanged) |
| Data impact | snapshot after = snapshot before (identical for users, tenants, workspaces, memberships, roles); only `_migrations` gained a row |
| Idempotency | second direct application OK; the gate then reports *skip* |
| Rollback A (logical) | `DROP FUNCTION` + delete registry row → function absent, 198 registered, data identical; re-apply through the gate and re-grant → works |
| Rollback B (restore) | `pg_restore` of the pre-0199 backup into a second disposable database → function absent, 198 registered, data identical |
| Applicable tests against the rehearsal database | database `membership-list-active` + `auth-repositories`: 71 passed / 1 skipped; API `na04-memberships`, identity-exchange, managed-logout, `routePermissions`: 43 passed |
| PostgreSQL 16 / existing migrations compatibility | PASS (all 198 prior migrations applied unchanged, then 0199) |
Both disposable databases and the probe role were dropped afterwards. **Limits:** the rehearsal owner role was a superuser (as the admin role is in CI); if production's migration owner is a different role, the function runs with that role's rights, and **production's app role must not own the function** (documented precondition). The rehearsal data is synthetic, not a production copy. Nothing here touches production.

## 6. Proposed production release sequence for NA-04 (PROPOSED; every step needs its own owner authorization)
0. **Preconditions:** Gates A, B, C evidence recorded the same day; the commit to release identified (`bc33ab9` or later); the previous API image id recorded; a maintenance window agreed (not strictly required: 0199 is additive and the old API does not call it).
1. **Checkpoint 1 — backup:** `pg_dump -Fc` of the production database on the VM to a root-only path, checksum recorded, restore-proof into a disposable database (as rehearsed above). Copy `.env` aside (mode 600). *Stop if the restore proof fails.*
2. **Record state:** `git rev-parse HEAD`, `docker compose -p oci images`, image ids, `/v1/health`.
3. **Checkout** the reviewed SHA on the VM (fast-forward only).
4. **Build** with the commit stamped: `GIT_SHA=$(git rev-parse HEAD) docker compose -p oci build api tools` (fixes the `version: unknown` traceability gap).
5. **Checkpoint 2 — migration:** `docker compose -p oci run --rm tools` (applies only `0199`). Verify `_migrations` head = `0199`.
6. **Grants:** run `grant-app-role.sh`; verify with read-only catalog queries (properties, PUBLIC has no EXECUTE, app role has EXECUTE) as in §5. *Rollback point: logical rollback A is safe here; nothing else depends on the function yet.*
7. **Checkpoint 3 — API:** `docker compose -p oci up -d api` (seconds). Verify `/v1/health` shows the SHA, `/v1/ready` 200, OpenAPI lists `GET /v1/auth/memberships`, an unauthenticated call → 401. *Rollback: re-create the previous image id; the database needs no change.*
8. **Frontend:** nothing to release. `apps/web` has no host (see §7); the legacy page does not use the new route.
9. **Post-release:** 24 h watch for 5xx and `failed_auth`; Gate D under separate authorization.
Order is fixed: **migration + grants before the API** (otherwise the new route answers 500, never data).

## 7. Rollback and recovery requirements (PROPOSED)
- API: keep the previous image id and tag it before step 4; rollback = `up -d` that image. No data change involved.
- Migration 0199: additive; logical rollback = `DROP FUNCTION tenancy.list_active_memberships(uuid)` plus deleting its `_migrations` row, in one transaction (rehearsed). Full recovery = restore the checkpoint-1 backup (rehearsed in a disposable database, not on production).
- Environment: previous `.env` copy; no new variables are introduced by NA-04 for the API.
- Evidence to retain: command output (without values) for each checkpoint.

## 8. Isolated test hosting — design for `next.infini-cus.com` (PROPOSED; nothing created)
Inspected architecture (REPO-VERIFIED): one Compose project (`oci` on the live host; `hetzner/` is the documented definition) with `postgres:16`, `api`, `tools` (profile), and `caddy:2-alpine` which alone publishes 80/443 and terminates TLS for `api.infini-cus.com`. `apps/api/Dockerfile` is the only image; `apps/web` has none. The event worker is not in the base Compose and **stays off** in any test environment.

Constraints from the directive: no production DNS/endpoint/Compose change and no paid resource without separate approval. Because only one process can own ports 80/443 on the VM, the edge is the real design question:
| Option | Edge | Pros | Cons / needs approval |
|---|---|---|---|
| **H1 (recommended): second Compose project + Cloudflare Tunnel + Cloudflare Access** | `cloudflared` container in the *test* project; no inbound port, no change to the production Caddy | production Caddy/Compose untouched; TLS by Cloudflare; access limited to named users (Access one-time email codes); no new public listener | requires DNS for the zone on Cloudflare (**OWNER EVIDENCE REQUIRED**), a tunnel and an Access policy (owner actions, no cost at small scale) |
| H2: separate small Hetzner VM | own Caddy on own IP | strongest isolation, no noisy-neighbour risk | paid resource: needs approval |
| H3: production Caddy gains two site blocks | existing Caddy | no new components | **modifies the running production Compose/Caddy: not allowed without approval**; shares the edge with production |
H1 detail: Compose project name `infinicus-next` in its own directory (e.g. `/opt/infinicus-next`), its own network, **its own PostgreSQL 16 container and volume**, its own `api` and `web` services, memory/CPU limits so it cannot starve production, no volume or network shared with project `oci`, no route from its containers to the production database. Database content is synthetic (migrations + fixtures); never a copy of production data. Independent `.env` (mode 600) with its own database passwords and its own Supabase **test** project URL and anon key (recommended: a separate Supabase project so test identities never exist in the production auth; using the production project is the alternative and mixes test users into it). `NODE_ENV=production`, `CORS_ALLOWED_ORIGINS=https://next.infini-cus.com` only (plus the API-next hostname if split), prod-like rate limits, `GIT_SHA` stamped. Hostnames: `next.infini-cus.com` (web) and `api-next.infini-cus.com` (API). Build-time public variables for the web image: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_BASE_URL=https://api-next.infini-cus.com` (anon key only; the app refuses a secret key). Independent deploy/rollback: its own script that refuses to run unless the Compose project is `infinicus-next` and the target database host is the test project's, previous image tags retained, database disposable (recreate from migrations) or restored from its own backup.
Required implementation work (NOT done, needs authorization): a web `Dockerfile` (Next.js `standalone` output, non-root, build args for the public variables), the test Compose file and `.env.example`, the deploy/rollback script, tests for the new files. Open facts needed first: VM size/free RAM/disk (**OWNER EVIDENCE REQUIRED**), whether the zone is on Cloudflare, Supabase test project decision.

## 9. Gate D — acceptance procedure for an email-confirmed Supabase test identity (PROPOSED; NO live request made, none authorized)
Prerequisites (owner): a dedicated test user (email confirmed) and a second test user in the project chosen for the environment under test; a disposable test tenant/workspace/business created for them; a written "go" naming the environment, time window and requests; credentials handled by the owner only; **no customer account**. The test never records passwords, access tokens, session tokens or the Supabase URL; it records only status codes, counts and pass/fail.
| # | Case | Expected | Notes |
|---|---|---|---|
| 1 | Valid identity exchange | 200; managed `shadow-…@infini-cus.local` account; session returned | record the user id only |
| 2 | Invalid / expired provider token | 401, no session, no account created | also a malformed body → 400 |
| 3 | Session expiration and revocation | revoked or expired session → 401 on `/v1/auth/session` and `/v1/auth/memberships` | revocation via sign-out (204 then 401). **Expiry by clock needs a 24 h wait or a database edit: run it only in the isolated environment** (edit a test session's `expires_at`); do not edit production sessions |
| 4 | Workspace discovery | `GET /v1/auth/memberships` returns only the test user's active workspaces; user B's list never contains user A's | |
| 5 | Unauthorized workspace selection | a tenant route with a workspace the user is not a member of → 403/404, no data; with a member workspace but no permission → 403 | |
| 6 | Cross-tenant access denial | user A cannot read user B's business by id (404) or with B's tenant/workspace headers (403/404) | |
| 7 | Browser refresh and recovery | after a reload the app re-exchanges from the identity provider's session; a second backend session exists (finding F7); the first remains valid until its expiry or revocation | observe in the web app on the isolated host |
| 8 | User switching and logout | switching users revokes the previous user's backend session (old token → 401); logout revokes the current one (204 then 401); the web app shows signed-out and offers sign-in | needs the web app on the isolated host |
Stop conditions: any unexpected 2xx on a negative case, any 5xx, any data from another tenant → stop and report; do not retry destructively.

## 10. Security findings and proposed corrections (PROPOSED; no code changed)
**S-1 Browser-secret scanner does not scan the real web sources. CONFIRMED on `bc33ab9`.** `check-no-browser-secrets.mjs` scans only `apps/web/src` and `apps/admin/src`; neither exists; a missing directory is silently skipped, so the CI step passes while scanning nothing ("scanned apps/web/src, apps/admin/src"). *Plan:* scan `apps/web/app` and `apps/web/lib` (and `apps/admin/src` when it exists) and make a configured directory that is missing, or that yields zero files, a failure. *Regression tests:* a fixture tree with a `"use client"` file reading a known secret name under `app/` and under `lib/` is rejected; a clean tree passes; a missing configured directory fails; the existing `browser-secret-check.integration.test.ts` keeps passing on the real tree. Interim cover: `clientBoundary.architecture.test.ts`.
**S-2 API CORS does not allow `PUT`. CONFIRMED** (repository `app.ts` and OBSERVED live preflight). Three routes use `PUT`: `/v1/businesses/:businessId/execution-activations`, `/v1/businesses/:businessId/declared-currency`, and the initial reorder-policy baseline. A browser on another origin cannot call them. *Plan:* add `PUT` to the allowed methods. *Regression tests:* a preflight for `PUT` from an allowed origin returns 204 with `PUT` in the allowed methods and the origin echoed; from a foreign origin no `Access-Control-Allow-Origin`; and a test that derives every method registered by the application's routes and asserts each is in the CORS method list, so a future method cannot be forgotten. Not needed for NA-04 itself (the shipped web pages use `GET` only).
**S-3 (new) Running API is not traceable to a commit** (`version: unknown`). *Plan:* build with `GIT_SHA` (§6 step 4); optionally make the deploy script refuse to proceed when `GIT_SHA` is unset. Needs authorization to change the script.
**S-4 (new) Comment accuracy** — see F-0199-1.
**S-5 (known, unchanged)** `/documentation*` (Swagger) is public; F1/F2/F3/F4/F5/F7 as recorded in the Option B decision.

## 11. Owner decisions and blockers
1. Evidence for Gates A, B (Preview, `EMAIL_MODE`), C (VM checkout, image, Cloudflare mechanism, DNS, `apps/web` hosting): **OWNER EVIDENCE REQUIRED**.
2. Authorize (separately) any production step in §6, starting with the backup and its restore proof.
3. Choose the test-hosting option (H1 recommended), confirm the zone is on Cloudflare, and decide whether the test environment uses a separate Supabase project.
4. Authorize Gate D with named test identities and a window.
5. Authorize implementation of S-1, S-2 (and S-3) as small independent blocks.
6. NA-05: the owner earlier authorised it and implementation had started; under this readiness directive it was **paused**. The unvalidated work exists only as a local, unpushed commit in this session's container. Say whether to resume, discard, or push it as a draft.
