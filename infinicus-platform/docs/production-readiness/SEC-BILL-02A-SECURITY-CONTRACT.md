# SEC-BILL-02A — Billing authorization security contract

Status: DEVELOPMENT. Not merged, not deployed. Scope: SF-1 and SF-2 of SEC-BILL-01 only. SF-3 to SF-7 are out of scope and unchanged.

## Findings addressed

| ID | Finding (reproduced on main `1058681a`, disposable PostgreSQL 16) | Fix |
|---|---|---|
| SF-1 | A tenant **owner** could `POST /v1/billing/trial` with `planCode: "enterprise"` and received HTTP 201, `trialing`, unlimited run limits and priority support, with no payment or approval. `pro` also started. An unknown plan answered 404 (a plan-existence oracle). | Public self-service start is restricted to a server-side allowlist (currently `free`). Every other plan is refused with one indistinguishable 403 before any lookup or write. |
| SF-2 | A tenant **owner** could `POST /v1/billing/payment-result` with `status: "paid"`: a `grace_period` subscription returned to `active`/`paid` with its real invoice reference overwritten by text the owner chose. On a *suspended* subscription the status stayed suspended but `payment_status` flipped to `paid` and the invoice reference was overwritten. | The route and its schema are **removed**. There is no tenant-callable payment-result operation. Payment state changes only through the signature-verified provider webhook. |

## Contract

### SF-1 — self-service plan start
1. A client-supplied plan code is a *request*, never proof of eligibility.
2. Eligibility is the exact membership of the code in `SELF_SERVICE_PLAN_CODES` (`packages/billing/src/selfService.ts`): code, frozen, not configurable by environment, request or database.
3. The list is `["free"]`. `enterprise` (negotiated, unlimited), `pro` (paid, 14-day trial), unknown plans and every later plan are **not** self-service.
4. Matching is exact. No normalisation (case, whitespace, Unicode, aliases, prefixes). Non-strings never match.
5. The check is the first statement of `EntitlementService.startSelfServiceSubscription`: a refused plan causes no plan lookup, no subscription write, no history row and no outbox event.
6. Refusal is `PlanNotSelfServiceError` → HTTP 403 with one fixed message that names no plan. Existing and non-existent plans are indistinguishable.
7. Order of checks for a tenant that already has a subscription: authorization (401/403/404) → eligibility (403) → uniqueness (409). An enterprise attempt on a subscribed tenant is therefore 403, not 409, and changes nothing.
8. Unchanged: authentication, `platform:admin` permission (owner only), tenant resolution, subscription uniqueness (409), lazy free-plan provisioning, plan trial durations.
9. Trusted internal callers keep `EntitlementService.startSubscription` (any plan). It is **not** reachable from any API source (guarded).

### SF-2 — payment-result authority
1. A tenant, including its owner, has **no** operation that records, reports or alters a payment result. The tenant owner's `platform:admin` permission is a tenant role, not a payment authority.
2. Payment state (`payment_status`, `external_invoice_reference`, grace period, reactivation after a failed payment) changes only through `EntitlementService.recordPaymentResult`, whose only caller is `ProviderBillingService`, whose only entry is `POST /webhooks/stripe` after exact-bytes signature verification.
3. No trusted operator-payment workflow exists in the repository and none is created here.
4. Unchanged: webhook signature verification, claim/replay/idempotency, trusted customer resolution, suspension precedence, append-only history, entitlement isolation.
5. No database privilege is added or changed.

## Behaviour change (backward compatibility)
* `POST /v1/billing/payment-result` now returns 404. No web, admin or script client calls it (only tests and BUILD-28 documents did).
* `POST /v1/billing/trial` with `pro` or `enterprise` now returns 403 instead of 201. BUILD-28 documented a `pro` trial through this route. That is **no longer available** until the owner decides (OD-1).
* An unknown or differently cased plan code now returns 403 instead of 404.

## Owner decisions recorded
* **OD-1** Should a paid-tier trial (`pro`, 14 days) be self-service? Not approved by any current commercial contract; denied by default. Adding it is a one-line, reviewed change to `selfService.ts`.
* **OD-2** Enterprise start is a commercial/operator process (not self-service). That process does not exist; nothing here creates it.
* **OD-3** If a manual payment-correction process is wanted it needs an authority independent of the tenant (not built here).

## Verification
`apps/api/tests/sec-bill-02a.billing-authority.integration.test.ts` (live PostgreSQL), `packages/billing/tests/selfService.test.ts`, `apps/api/tests/sec-bill-02a.architecture.test.ts`, `apps/api/tests/billing.integration.test.ts` (rewritten to pin the secure contract). Exact counts and mutation evidence are in the PR description and the completion report.
