# NA-04 — web authentication and API foundation (apps/web, Option B)

Status: CODE COMPLETE, NOT DEPLOYED, NOT ACCEPTED. Nothing here has run against production, Cloudflare or real Supabase. Criterion J remains open. Authority: `NEW-ARCH-R0_WEB_ARCHITECTURE_DECISION.md` (apps/web becomes a client of the `/v1` API through the Option B identity exchange) and `AC-3_OPTION_B_OWNER_DECISION.md`.

## Owner decisions taken for this block
1. **Workspace discovery:** a small read-only API endpoint is added in NA-04. 2. **Migration 0199** (read-only SECURITY DEFINER function; no RLS policy change). 3. **Token custody:** the backend session token is kept **in memory only**; a reload re-exchanges.

## What was added
| Area | Change |
|---|---|
| Database | Migration `0199_create_list_active_memberships.sql`: `tenancy.list_active_memberships(p_user_id)`. Returns only that user's ACTIVE, non-deleted memberships (tenant/workspace ids, names, statuses). Refuses (42501) unless `p_user_id` equals the transaction's `app.user_id`. STABLE, SECURITY DEFINER, `search_path = pg_catalog, pg_temp`, EXECUTE revoked from PUBLIC. No table or policy change. `MembershipRepository.listActiveForUser`. |
| API | `GET /v1/auth/memberships` (session only; the user comes from the validated session, never from the request). Listed in `routePermissions.test.ts` BY_DESIGN as a session route. |
| apps/web `lib/client` | `config` (public values only, fail-closed, refuses secret keys), `apiClient` (bearer; workspace claim headers only when a scope is given; one re-exchange on 401; typed errors; timeouts; `credentials: 'omit'`), `backendSession` (in-memory token; revoke-before-provider-sign-out; never throws; failure never reported as success; late exchange discarded and revoked), `workspaces` (list, remembered selection validated against the fresh list), `authController` (framework-free state machine), `supabaseProvider` (supabase-js adapter). |
| apps/web pages | Route group `app/(client)`: `/sign-in`, `/workspaces`, `/console` (shell with account bar, connection check), plus `app/loading.tsx` and `app/error.tsx`. The older server-rendered pages (`/businesses/**`) are untouched. |
| Dependencies | `@supabase/supabase-js` and `zod` for apps/web. Dependency scan: only the existing allowlisted advisories. |

## Security properties (each has a test)
- The browser sends only the provider access token to the exchange; nothing else influences the account. Workspace choice is a claim re-verified by the API per request (`X-Tenant-Id`/`X-Workspace-Id`); the list endpoint authorizes nothing.
- Backend token is never written to storage, cookie, URL or log (`clientBoundary.architecture.test.ts`); only the two-id workspace selection is kept in `sessionStorage` and is honoured only if still listed.
- Sign-out and user switch revoke the previous backend session on the server; a failed revocation is recorded and warned (no token) and never claimed as success.
- A service/secret Supabase key in the browser configuration is refused.

## Release dependencies — read before any deployment (none authorized)
1. **Migration 0199 must be applied (and `grant-app-role.sh` re-run) BEFORE an API that serves `GET /v1/auth/memberships` is released.** Without it the route answers 500, never data. Applying it to any live database is a separate owner authorization (Guardrail §XIX). It is additive and idempotent; rollback is `DROP FUNCTION tenancy.list_active_memberships(uuid)` with no data impact.
2. **apps/web has no deployment path** (no Dockerfile, no workflow, no host). Where and how it is hosted is an open owner decision; it also needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_BASE_URL` at build time (`apps/web/.env.example`).
3. The API's `CORS_ALLOWED_ORIGINS` must list the web app's origin (headers allowed today: Content-Type, Authorization, X-Tenant-Id, X-Workspace-Id, Idempotency-Key; methods: GET, POST, PATCH, DELETE, OPTIONS). **`PUT` is not allowed**, so later web calls to PUT routes (declared currency, execution activations, reorder baseline) would fail preflight; address before NA-05 uses them.
4. Gates A–D of Option B are still open. This block was verified only against a fake identity provider.

## Not done (deliberately)
Sign-up, password reset and other sign-in methods (the legacy page has them); onboarding; moving `/businesses/**` onto the API (NA-05); any deployment, live migration, Cloudflare/DNS change or merge; retiring the legacy page. Findings F1 (script-readable storage) is improved for the new client (memory only) but still applies to the legacy page; F7 (a reload creates another 24-hour session) is accepted for this client until a refresh design exists; F3 is mitigated in the new client (one re-exchange on 401).

## Verification (local PostgreSQL 16 mirroring ci.yml; not CI)
- New: 6 database tests (function behaviour and refusals), 6 API tests (HTTP, real PostgreSQL), 51 apps/web tests (config 4, API client 6, session manager 11, controller flow 14, workspaces 2, page rendering 6, client boundary 8) plus the updated J-2 guard.
- Whole suites: database 3507 passed / 26 skipped; API 455 / 12; web 74; event-worker 196; business-operations-runtime 612; authentication 58. Lint, typecheck, forced build (including `next build`) and dependency scan pass.
- Mutation controls (each caught, then reverted): late exchange not revoked; provider sign-out before revocation; user switch without revocation; retry without a new session; token written to browser storage; DB function without the user check; DB function returning suspended memberships; route trusting a `userId` query parameter; route without authentication.
- One-off end-to-end run (not committed) of the real web client modules against the real API with a fake provider: sign-in, managed account, workspace discovery and auto-select, 401 healing, user switch revocation, sign-out revocation all behaved as designed.
