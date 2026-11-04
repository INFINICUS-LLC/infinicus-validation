# STRIPE-SBX-01 — Stripe sandbox webhook integration (development candidate)

Status: DEVELOPMENT ONLY, Stripe SANDBOX ONLY. No live mode, no deployment, no production migration, no Stripe API call, no Dashboard mutation. Nothing activates a provider.

## Pathway

```
Stripe sandbox
  -> POST /webhooks/stripe                       (unauthenticated in the user-auth sense; the Stripe signature IS the authentication)
  -> exact raw-bytes signature verification      (route-scoped buffer parser; 300 s tolerance)
  -> structural validation + live-mode refusal
  -> StripeWebhookAdapter                         (the only Stripe-aware code: event -> provider-neutral command)
  -> ProviderBillingService                       (provider-neutral: claim -> trusted link -> EntitlementService -> finish)
  -> EntitlementService (unchanged)               (recordPaymentResult / cancel / suspend)
  -> billing.subscriptions                        (unchanged; one row per tenant)
```

## Decisions

| Topic | Decision |
|---|---|
| Route | `POST /webhooks/stripe`. Provider-facing URLs are registered in the provider's dashboard and must outlive the versioned user API, so it is deliberately not under `/v1`. |
| Raw body | The JSON parser is replaced **inside one encapsulated plugin** (`parseAs: 'buffer'`, 1 MiB limit). No other route's parsing changes; a guard prevents any other parser registration. |
| SDK | `stripe` **23.1.0**, exact pin, `apps/api` only. Its pinned API version is `2026-10-28.endive`, the version the sandbox UI shows (verified from the package, asserted in a test). |
| Environment | `STRIPE_SECRET_KEY` (sandbox keys only; `sk_live_`/`rk_live_` refused at startup; not used for API calls in this block) and `STRIPE_WEBHOOK_SECRET`. Names only in `.env.example`; both are in `SECRET_INVENTORY` so value-based redaction applies. Unset webhook secret → the route answers 503 (fail closed). |
| Identity | Tenant identity comes **only** from `billing.provider_customers`, created by a trusted server-side flow under an authenticated tenant context. Never from e-mail, names, metadata, `client_reference_id` or any client-supplied tenant id. |
| Commercial model | No Stripe product, price or plan is read anywhere. The temporary Explorer / Starter / Growth / Pro products are not architecture. Mapping Stripe product/price → internal commercial mapping → entitlement profile is POS2-02. |

## Event mapping

| Stripe event | Provider-neutral command | Effect |
|---|---|---|
| `invoice.paid` | `payment_result: paid` | `EntitlementService.recordPaymentResult(…, 'paid', <Stripe invoice id>)` |
| `invoice.payment_failed` | `payment_result: failed` | `recordPaymentResult(…, 'failed', <Stripe invoice id>)` (grace period) |
| `customer.subscription.created` | `subscription_established` | links the provider subscription id to the **trusted customer's** tenant; **no lifecycle change** |
| `customer.subscription.updated` | `subscription_state_observed` | `canceled` → canceled; `unpaid` → suspended; `active` / `trialing` / `past_due` → reconciliation only (a grace period is never regressed); `incomplete`, `incomplete_expired`, `paused`, any unknown status → refused with a fixed code |
| `customer.subscription.deleted` | `subscription_ended` | canceled (idempotent) |
| `checkout.session.completed` | `checkout_completed` | requires `mode = subscription` and trusted customer; **confirms** an existing link or waits for the subscription event; never creates a link or grants anything |
| anything else | `unsupported` | recorded and refused |

A subscription id is accepted only if it is unlinked or linked to the **same** customer (`CUSTOMER_SUBSCRIPTION_MISMATCH` otherwise). `updated` / `deleted` for a never-linked subscription are refused (`SUBSCRIPTION_NOT_LINKED`), not guessed.

## Replay protection (`billing.provider_events`)

Unique `(provider, event_id)`; immutable `event_type` + SHA-256 `payload_hash` of the delivered bytes; state `claimed → processed | failed`, `failed → claimed` (retry), attempt count, fixed `result_code`. **No payload, customer data or secret is stored.**

* `claim_provider_event` is atomic: `CLAIMED` / `DUPLICATE` (success, nothing applied) / `IN_PROGRESS` (fresh claim held → HTTP 409, Stripe retries) / `CONFLICT` (same id, different type or body → HTTP 409, nothing changes).
* A failed event, or a claim older than five minutes (crashed attempt), is re-claimed with the attempt count incremented.
* Refusals that retry cannot fix (unknown customer, unmapped state, …) are **durably recorded as `failed` with a fixed code and acknowledged with 200**: no silent loss, and no endless retry storm. A redelivery re-claims and re-evaluates (for example once the trusted link exists).
* Unexpected errors record `INTERNAL_ERROR`, answer a generic 500 and are retried by Stripe.
* Effects are idempotent, so a crash between applying an effect and finishing the ledger row is safe.

## Database (migration 0226, additive; renumbered from 0225, which POS2-02 took first)

`billing.provider_customers` (unique `(provider, customer id)`), `billing.provider_subscription_links` (unique `(provider, subscription id)`, composite FKs pin **tenant and provider** to the customer and the optional internal subscription to the same tenant; **no tenant-level uniqueness**, so a tenant may hold many provider subscriptions), `billing.provider_events`; one composite unique key `(id, tenant_id)` on `billing.subscriptions` (additive). All three tables ENABLE + FORCE RLS; the identity tables are append-only; the ledger is writable only inside the governed functions (transaction-local marker **and** current_user = function owner, as migration 0196) and the application role has its direct write privileges revoked by `grant-app-role.sh`.
Five narrow `SECURITY DEFINER` functions pin `search_path = pg_catalog, pg_temp`, qualify every relation, return only identifiers/closed outcomes and are not executable by PUBLIC. `billing.subscriptions` is **not** redesigned (POS2-02 owns multi-product subscriptions).

## Known limits / owner follow-ups

* No Checkout/customer creation exists yet: **no production path creates a `provider_customers` row**, so in any environment every webhook is recorded as refused until the trusted checkout flow (a later block) calls `ProviderBillingRepository.registerCustomer`. Tests use that same boundary with synthetic ids.
* A tenant with no `billing.subscriptions` row is refused (the customer cannot be resolved to a billing workspace); the checkout flow must provision it (it already lazily does on first entitlement check).
* A suspended subscription (Stripe `unpaid`) is **not** automatically reactivated by a later `invoice.paid` (`recordPaymentResult` reactivates only from grace / past_due / trialing). Reactivation policy is unapproved and deliberately not invented here.
* One internal subscription per tenant means `subscription_ended` for any linked provider subscription cancels the tenant's single internal subscription. Per-subscription effects need POS2-02.
* Stripe's `api_version` on a delivered event is not enforced (the endpoint's own version governs the payload); field reads are defensive for both older and newer invoice shapes.
* The global per-IP rate limiter applies to the route; a 429 is retried by Stripe.
* Production/live use needs: owner-approved activation, a live-key policy (live keys are refused today), webhook secret rotation procedure, retention for `provider_events`, and the dispatch/tenant-erasure treatment of the new tables.

## Verification

See the PR description / completion report for the exact commands and counts.
