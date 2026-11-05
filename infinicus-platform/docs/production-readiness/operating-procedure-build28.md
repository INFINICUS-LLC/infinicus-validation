# BUILD-28 — Billing and Entitlements: Operating Procedure

## Starting a tenant's subscription

> **SEC-BILL-02A (supersedes the example below):** `POST /v1/billing/trial` now accepts only an allowlisted self-service plan (currently `free`). `pro`, `enterprise` and unknown plans return 403. A paid or negotiated plan is started by a trusted commercial process, not by the tenant. See SEC-BILL-02A-SECURITY-CONTRACT.md.

Via the API (requires `platform:admin`):

```
POST /v1/billing/trial
{ "planCode": "pro" }
```

A tenant that never calls this is not blocked — `EntitlementService.enforceActiveSubscription()` lazily provisions the `free` plan on first check (see architecture-and-scope-build28.md). Calling `/v1/billing/trial` a second time for an already-subscribed tenant returns `409`.

## Recording a payment result

> **SEC-BILL-02A: REMOVED.** `POST /v1/billing/payment-result` no longer exists (404). A tenant owner could report their own payment as paid. Payment state now changes only through the signature-verified provider webhook (`POST /webhooks/stripe`). The text below is kept as history only.

```
POST /v1/billing/payment-result
{ "status": "paid" | "pending" | "failed", "externalInvoiceReference": "<external processor's invoice id, optional>" }
```

`failed` moves the subscription into `grace_period` (7 days by default) if it was `active`/`trialing`/`past_due`; `paid` clears any grace period and reactivates; `pending` updates `payment_status` only, no lifecycle change. This build does not call any external payment processor itself — a real deployment's payment-processor webhook handler would call this endpoint (or the equivalent `EntitlementService.recordPaymentResult()` call directly) after the processor reports its own result.

## Running the billing lifecycle audit (time-based transitions)

This platform has no background job runner (see BUILD-22/24's own operational-script precedent) — trial expiry and grace-period expiry are driven by a script meant to run on a schedule (daily cron/CI job), not the request path:

```bash
DATABASE_URL="postgresql://app_test_user:PW@HOST:5432/DB" \
ADMIN_DATABASE_URL="postgresql://admin_role:PW@HOST:5432/DB" \
  node infrastructure/deployment/scripts/billing-lifecycle-audit.cjs expire-trials

DATABASE_URL="..." ADMIN_DATABASE_URL="..." \
  node infrastructure/deployment/scripts/billing-lifecycle-audit.cjs expire-grace-periods
```

`expire-trials` moves every `trialing` subscription past `trial_ends_at` into `grace_period` (a courtesy window, not immediate suspension). `expire-grace-periods` moves every `grace_period` subscription past `grace_period_ends_at` into `suspended`. Both print one line per transitioned subscription plus a total count; both exit non-zero only on an unexpected failure (a normal run with zero eligible subscriptions is success, not an error). Both discover candidates via `ADMIN_DATABASE_URL` (bypasses RLS, needed to scan across every tenant) but perform every actual state change through `SubscriptionRepository.transitionStatus()` under `DATABASE_URL` with a real per-tenant context — the same safe, audited, fail-closed code path the API itself uses, never a raw admin `UPDATE`.

## Suspending or reactivating a tenant manually

Via `EntitlementService` directly (no dedicated HTTP route in this build — an operational/support action, not a self-service tenant one):

```ts
await new EntitlementService().suspend(ctx, 'manual_reason');
await new EntitlementService().reactivate(ctx, 'manual_reason');
```

## Checking a tenant's current subscription and usage

```
GET /v1/billing/subscription
```

Returns the subscription's status/trial/grace-period/payment fields, the resolved plan (limits, features, price), and this billing period's usage for every metered metric (`simulation_runs`, `reasoning_runs`). Any authenticated member with an active workspace membership can read this (no extra permission gate) — only mutating routes (`/trial`, `/payment-result`) require `platform:admin`.

## Rollback

See rollback-procedure-build28.md. This build ships 4 new, additive migrations and no modification to any existing route, schema, or migration — a plain revert is safe.
