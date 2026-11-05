# BUILD-28 — Billing and Entitlements: Security Controls

## Server-side enforcement, fail-closed

Every entitlement decision is made server-side in `EntitlementService`, never trusted from the client. `enforceActiveSubscription()`/`enforceFeature()` throw rather than return a boolean the caller might ignore (the same fail-closed convention `AuthorizationService.authorize()` established in BUILD-18). Live-verified end-to-end over real HTTP: a suspended tenant's `POST /v1/businesses/:id/decisions` call is rejected with `402` before the route handler's own business logic runs — proven with a request whose body would otherwise be schema-valid but references nonexistent records, confirming the block happens in the `preHandler` chain, not by coincidentally failing later for an unrelated reason.

## Tenant isolation

Every billing table (`subscriptions`, `subscription_status_history`, `usage_records`) enforces RLS scoped to `tenant_id = current_setting('app.tenant_id', true)::uuid`, `FORCE ROW LEVEL SECURITY` (so even the table owner can't bypass it), matching the established convention. Live-verified: a second tenant's `getById()` call for the first tenant's subscription id resolves as not-found (RLS-scoped invisibility), not a cross-tenant read.

## Usage-limit enforcement is race-free under concurrency

`UsageRepository.incrementAndCheck()`'s `INSERT ... ON CONFLICT DO UPDATE` acquires a row-level lock on the tenant/metric/period row, serializing concurrent callers rather than allowing a classic check-then-increment race (two requests both reading "19 of 20 used" and both proceeding). Live-verified: 30 concurrent calls against a limit of 20 produced exactly 20 successes and 10 rejections, with the final persisted quantity at exactly 20 — never more.

## Fail-closed, not fail-open, on a rejected metered action

A rejected `incrementAndCheck()` call runs a compensating decrement inside the same transaction before throwing, so a blocked action's usage is never recorded — the caller's action genuinely did not happen, and the usage counter reflects that truthfully (verified: `getCurrent()` after a rejected attempt still reads the pre-attempt value, not an inflated one).

## Invoice references are references only, never payment data

`billing.subscriptions.external_invoice_reference` is documented (migration `0150`, this table's own `COMMENT ON COLUMN`) as a reference string only — an external processor's invoice id — never raw card/payment data, matching CLAUDE.md §12's "credential records store references, never raw secrets." This build never receives, stores, or logs any actual payment credential; `POST /v1/billing/payment-result` accepts an already-decided outcome (`paid`/`pending`/`failed`), not payment details.

## Audit trail integrity preserved, not compromised, by this build

`billing.subscription_status_history` is append-only (`forbid_mutation` trigger, migration `0153`) — every lifecycle transition (including this build's lazy free-plan provisioning) leaves a permanent record. This build's own use of BUILD-27's fixed `delete-tenant-data.mjs` confirmed live that the new schema integrates correctly with that script's append-only-table handling: a billing test tenant's `subscription_status_history` rows were correctly retained (not deleted, not silently dropped), and the tenant's erasure was honestly reported as partial rather than falsely claimed complete.

## No new secrets, no new attack surface beyond the documented routes

> **SEC-BILL-02A:** the claim below that both mutating routes were adequately protected by `platform:admin` was wrong for these two routes: a tenant owner holds `platform:admin`. `POST /v1/billing/trial` is now restricted to an allowlisted plan and `POST /v1/billing/payment-result` has been removed. See SEC-BILL-02A-SECURITY-CONTRACT.md.

Three new HTTP routes (`GET /v1/billing/subscription`, `POST /v1/billing/trial`, `POST /v1/billing/payment-result`), all behind `app.authenticate` + `app.resolveTenantContext`; the two mutating routes additionally require `platform:admin` (live-verified: a `viewer`-role member's `POST /v1/billing/trial` call is rejected `403`). Request bodies are Zod-validated with bounded string lengths (`externalInvoiceReference` capped at 255 chars, `planCode` at 64), consistent with BUILD-26's bounded-payload requirement.
