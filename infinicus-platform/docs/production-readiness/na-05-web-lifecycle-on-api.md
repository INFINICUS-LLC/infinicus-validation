# NA-05 — first-lifecycle screens move onto the /v1 API (apps/web)

Status: CODE COMPLETE, NOT DEPLOYED, NOT ACCEPTED. Nothing here has run against production, Cloudflare or real Supabase. Criterion J remains open. Authority: `NEW-ARCH-R0_WEB_ARCHITECTURE_DECISION.md` (apps/web is a client of the `/v1` API through the Option B identity exchange).

## What changed
| Area | Change |
|---|---|
| apps/web screens | `/businesses`, `/businesses/[businessId]/workflow` and `/businesses/[businessId]/history` are now client pages in the `(client)` route group (same URLs, same sections and wording as before: data review, BI evidence, digital twin, simulation, ADI recommendation, ABA review, outcomes; per-stage history). They load through the API in the selected workspace, with loading, error and empty states. The decision and outcome forms post to `POST /v1/businesses/:id/decisions` and `/outcomes` with an `Idempotency-Key`; a retry of the *same* submission is a replay (stable key and record codes), an edited form is a new submission. |
| apps/web removed | The old server-rendered pages, server actions, `lib/context.ts`, `lib/db.ts`, `lib/serverContext.ts`, `lib/permissions.ts`, the `inf_session`/`inf_workspace` cookie contract and the direct PostgreSQL connection are **deleted**. apps/web no longer depends on `@infinicus/*` packages or `pg`; `next.config.mjs` no longer transpiles platform packages. There is now exactly one identity path into the data: the API. |
| API (additive, read-only) | `GET /v1/businesses/:id/workflow` keeps every existing count/boolean field and adds the detail the screen renders (business detail, BI evidence, latest digital-twin snapshot, simulation runs and result, latest recommendation and decision, outcomes). New `GET /v1/businesses/:id/history` (per-stage lists, most recent first). Both require authentication, an active membership and **all seven layer read permissions** (owner ruling F2) and a business in the caller's workspace. `POST .../decisions`: `assignmentCode` is now optional and the **server** defaults it to the owner approver assignment (the assignment is still verified against the authenticated user). |
| Not touched | Authorization rules, migrations, the legacy page, the identity exchange, CORS (the screens use only GET and POST). |

## Security properties (each has a test)
- No identity or scope from the URL or a form: no `searchParams`, no tenant/workspace/user inputs; the only route parameter is the business id, validated as a UUID before use. The workspace claim comes from the controller's selected workspace and is re-verified by the API on every request.
- The decision body carries no approver, assignment, tenant or workspace; the approver is always the signed-in principal.
- Every response is validated against a schema before rendering; a drifting server shows an error, not a half-rendered page.
- Failures become sentences with a correlation reference; server text is never echoed.
- A guard (`noServerAccess.architecture.test.ts`) fails if apps/web regains a server-side data path.

## Release dependencies — none authorized
1. The API change is additive and has no migration; it can be released independently of apps/web. apps/web has no host or deployment path yet (open owner decision; see `NA-04_RELEASE_READINESS_AND_ISOLATED_TEST_HOSTING.md`).
2. Until the API with the new fields is deployed, the new workflow screen shows an error (the old API returns only counts). Release the API first.
3. Migration 0199 and the memberships route from NA-04 are prerequisites for sign-in and workspace selection.
4. The screens use only GET/POST, so S-2 (CORS PUT) is not required for them.

## Findings
- **F-NA05-1 (pre-existing API defect, not fixed here):** `POST /v1/businesses/:id/outcomes` with a `monitoredActionId` that does not exist answers **500 `internal_error`**, not a 4xx. The screen degrades to "The service had a problem" with a reference. Proposed fix: map the missing-action case to 404/409 with a test (small API block).
- Forms still ask the user to paste an intake-package or monitored-action UUID (unchanged from the old screen); discovering these ids needs list endpoints that do not exist yet.
- Findings F1/F2/F3/F7 as recorded; sign-up, password reset and onboarding are still not in the new app.

## Verification (local PostgreSQL 16 mirroring ci.yml; GitHub CI is the authority)
See the pull request description for the exact numbers. Mutation controls were run for the new guards and screens, and a one-off (uncommitted) run of the real web modules against the real API confirmed the list, workflow, history and decision contracts.
