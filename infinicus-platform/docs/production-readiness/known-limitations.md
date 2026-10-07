# BUILD-18 — Authentication and Authorization: Known Limitations

These are deliberate scope boundaries, architectural constraints inherited
from the frozen Stage 1 schema, or gaps that a future build must close —
not defects in what was actually built (all defects found during this
build's own testing were fixed before completion; see
`test-evidence.md`).

## No HTTP layer yet

`guards.ts` (`createAuthGuard`, `createPermissionGuard`) is
framework-agnostic by design because `apps/api` has zero HTTP framework
dependency chosen yet (root `CLAUDE.md` §4 explicitly defers that
choice). This means:

- There is no actual HTTP route, cookie-parsing, or header-extraction
  code in this build — a future build must wrap these guards in
  whichever framework is chosen.
- API-key tenant resolution (see below) cannot be fully implemented
  until that HTTP layer exists, since it depends on request-level
  context (subdomain, path, or header) that only an HTTP framework can
  supply.

## API-key verification requires tenant context to already be known

`identity.api_key_references` is RLS-scoped through the owning service
account's tenant. `ApiKeyRepository.verify(ctx, keyPrefix, keyHash)`
therefore requires a `TenantContext` to already be constructed by the
caller — it cannot resolve "which tenant does this bare API key belong
to" on its own. This is a structural property of the frozen schema, not
a bug in this build. A future HTTP-layer build must resolve tenant
context (e.g. via subdomain or workspace-slug routing) before calling
`verify()`.

## No multi-factor authentication

The frozen `identity.users` schema has no columns supporting TOTP,
WebAuthn, or recovery codes. Adding MFA would require a schema change,
which is out of scope for this build (BUILD-18 explicitly reuses the
existing schema without modification).

## No account lockout / rate limiting — CLOSED (post-BUILD-18 follow-up)

Closed: `AuthenticationService.login` now reads back the `failed_auth`
access events it already records and locks the account (throws
`AccountLockedError`, mapped to HTTP 429) after 5 `bad_password`
failures within a 15-minute sliding window — implemented as a pure
function of `audit.access_events`, no new migration or `locked_until`
column required. Deliberately scoped to `bad_password` failures only,
never `unknown_email` (no `userId` to count against) or an
already-`account_locked`/`account_not_active` failure (would let an
attacker keep an account locked indefinitely). See
`AuthenticationService.login`'s lockout comment and
`AccessEventRepository.countRecentFailedPasswordAttempts`'s doc
comment for the full reasoning. Global per-IP request throttling
(independent of this per-account check) is unchanged — still handled
by `apps/api`'s existing `@fastify/rate-limit` plugin registration.

## No password reset flow

`changePassword` requires knowing the current password. There is no
"forgot password" / reset-token flow in this build — it would need an
email-delivery integration that does not yet exist in the platform.

## `AuthorizationService`'s unused `InvitationExpiredError`

`packages/authorization/src/errors.ts` exports `InvitationExpiredError`,
but the actual expired-invitation rejection path currently surfaces as
`InvitationStateConflictError` from `@infinicus/database` (thrown by
`InvitationRepository.accept()`, which checks both status and
expiration in one place). The two errors are not currently unified. A
future change could have `AuthorizationService.acceptInvitation` catch
and re-map this to the domain-specific error, but that was judged
unnecessary scope-creep for this build — the exported class remains
available for a caller that wants a more specific catch, and the actual
behavior (rejecting an expired invitation) is fully tested and correct.

## Session/API-key hashing uses SHA-256, not a memory-hard KDF

This is an intentional design choice (documented in
`security-controls.md`), not an oversight — session tokens and API keys
already carry 256 bits of random entropy, so SHA-256 is appropriate for
their high-frequency lookup pattern. It is called out here only because
a reviewer unfamiliar with the entropy argument might otherwise flag it
as a password-hashing anti-pattern.

## No UI

No login page, registration form, invitation-acceptance page, or admin
role-management UI was built. This build is the service/repository
layer only, matching its specification's scope (§2 lists "server-side
authorization," "route/API guards" — not UI routes/states, which the
spec's own freeze-checklist §4 lists as "if any," and none were
required here since no frontend route consumes this build yet).
