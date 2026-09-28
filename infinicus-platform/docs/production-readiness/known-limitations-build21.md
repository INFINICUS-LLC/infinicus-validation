# BUILD-21 — Governed Application API: Known Limitations

## Pagination is applied after a full repository fetch, not pushed into SQL — CLOSED (post-BUILD-21 follow-up)

Closed: `BusinessRepository.listForWorkspace(ctx, page?)` — the sole
caller of the old in-memory `paginate()` helper, via
`DecisionWorkflowService.listBusinesses` and `GET /v1/businesses` —
now issues a bounded `LIMIT`/`OFFSET` query plus a `COUNT(*)` on the
same transaction client, instead of fetching the full workspace list
for the API layer to slice. Bounds are clamped through the existing
`boundedPage()` helper (`repositories/da/pagination.ts`, reused rather
than duplicated), so a malformed or unbounded caller request still
cannot reach the query directly. The now-unused in-memory `paginate()`
helper has been removed from `apps/api/src/schemas/common.ts`; the
request/response contract for `GET /v1/businesses`
(`paginationQuerySchema`, `businessListResponseSchema`) is unchanged.

This closes the one call site that existed at the time this
limitation was written. Other repository methods returning
recency-ordered lists without pagination at all (as opposed to
paginating in memory) are unaffected and remain out of scope here.

## No email verification / activation flow

`POST /v1/auth/register` creates a user in `pending` status (unchanged
from BUILD-18's `AuthenticationService`), and this build adds no route
to activate one — the live integration test activates users directly
via `UserRepository.activate()` in test setup, not through any HTTP
route. An early draft of this build added a test-only
`/v1/auth/_test/activate/:userId` backdoor route gated by a
`NODE_ENV !== 'production'` check; this was deliberately removed before
completion — test/debug backdoors have caused real production incidents
when the gating logic itself has a bug or `NODE_ENV` is misconfigured,
and no prior build in this sequence has built a real
email-verification flow for this HTTP surface to depend on. Building one
is a reasonable follow-up, explicitly out of this build's scope (adding
later-build functionality is disallowed per spec §3).

## `POST /v1/onboarding` has no idempotency requirement

Documented as a deliberate bootstrapping exception in
`security-controls-build21.md`, not an oversight — the idempotency
mechanism this build introduces is tenant-scoped, and tenant creation is
the one operation with no tenant yet to scope a key to.
`TenantSlugConflictError` (409) is the natural duplicate-prevention
signal for this one route instead.

## The workflow-view response is a summarized aggregate, not the full nested shape

`GET /v1/businesses/:businessId/workflow` returns counts and booleans
(e.g. `hasActiveDigitalTwin`, `latestSimulationStatus`) rather than the
full nested `WorkflowView` object `DecisionWorkflowService.getWorkflowView`
actually returns and that `apps/web`'s BUILD-20 UI renders in full. This
is a deliberate API-layer simplification — designing a stable, versioned
public JSON contract for every nested BI/DT/SIM/ADI/ABA/OM sub-object was
judged out of this build's scope; `apps/web` continues to call
`@infinicus/workflow` directly for its own rich rendering rather than
going through this HTTP API. Widening this response to the full shape is
a reasonable, isolated future follow-up.

## No refresh-token / long-lived-session rotation semantics beyond BUILD-18's

`app.authenticate` validates whatever session semantics
`AuthenticationService.validateSession()` already provides (BUILD-18);
this build adds no new session lifecycle behavior (no refresh tokens, no
sliding expiration) — that remains entirely BUILD-18's responsibility,
unchanged.

## No API-key or service-account authentication path

Only Bearer session-token authentication is wired up
(`app.authenticate`); `AuthenticationService`'s existing API-key/service-
account validation methods (used elsewhere in the codebase) are not
exposed as an alternative authentication path on any route in this
build. Machine-to-machine callers must currently authenticate as a real
user session. Adding an `X-Api-Key` alternative is a reasonable,
isolated future follow-up.

## No integration test for the rate limiter's actual 429 threshold

The rate-limiting test confirms `X-RateLimit-*` headers are present on
every response, but does not drive the request count past the
configured `RATE_LIMIT_MAX` to observe an actual `429 Too Many Requests`
response — doing so reliably in a shared test run without either a very
low configured limit (which would then also throttle the *other* 25
tests sharing the same `app` instance) or a dedicated,
isolated-app-instance test was judged not worth the added test
complexity for this build. `@fastify/rate-limit` itself is a
well-established, independently-tested library; this build's own
integration coverage is intentionally limited to confirming it is wired
in correctly (headers present, configurable via `loadConfig()`).
