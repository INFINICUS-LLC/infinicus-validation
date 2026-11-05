# SEC-BILL-02A — PRODUCTION HOTFIX DECISION RECORD

Status: **DECISION REQUIRED FROM THE OWNER. NOTHING HAS BEEN DEPLOYED.** Prepared in a development session with no production, DNS, Cloudflare, Stripe or credential access.

## 1. Affected production commit (verified from authorized metadata only)
* The public liveness endpoint `GET https://api.infini-cus.com/v1/health` reported `version: bea03e66f00889fdfa6fa5aa69e3feaa3ee7b4e5` on 2026-11-04 (one read-only GET).
* That commit is `fix(deps): patch-level advisory fixes on the AUTH-LOCKOUT-1 RC` (2026-10-28). It is **not** on `main`'s history; `main` is 210 commits ahead. Its highest migration is `0220`.
* It does **not** contain the Stripe webhook route or migrations 0221-0226 (no payment processor integration exists in the deployed code).
* **Not assumed equal to main.** The two affected routes and schema are byte-identical between `bea03e66` and `main`, but `EntitlementService`, both error files and the package index differ, so the main-based fix does **not** apply to the deployed commit.
* **Verification limits:** the identifier is what the running image reports (set at image build). The running process, its database, any later redeploy and the live data were not inspected. Re-check `/v1/health` immediately before acting.
* **Empirical confirmation on the deployed build:** `bea03e66` was built unmodified in a disposable environment with its own 210 migrations. Both findings reproduce there (enterprise and pro start with HTTP 201; a forged `paid` clears a grace period and overwrites the invoice reference).

## 2. Vulnerabilities
* **SF-1** — `POST /v1/billing/trial` accepts any plan code from a tenant owner. Reproduced: `enterprise` → 201, `trialing` (30 days), unlimited simulation/reasoning limits, priority support; `pro` → 201, `trialing` (14 days). No payment or approval.
* **SF-2** — `POST /v1/billing/payment-result` lets a tenant owner report their own payment. Reproduced: a `grace_period` / `failed` subscription becomes `active` / `paid`, grace cleared, and the real invoice reference replaced by owner-chosen text. A *suspended* subscription stays suspended but its `payment_status` becomes `paid` and the invoice reference is overwritten.

## 3. Severity and exploit prerequisites
* **Severity: High** (authorization bypass of billing state). No direct monetary loss path exists in the deployed code because no processor is integrated, but it defeats plan limits, dunning and billing evidence.
* **Prerequisites:** an authenticated user holding the **owner** role of a tenant (the only role with `platform:admin`; admin/member/viewer get 403; a foreign tenant header gets 404; unauthenticated gets 401).
* SF-1 additionally needs the tenant to have **no subscription row yet** (a second call returns 409; first billing access lazily provisions `free`).
* **Exploitation in production: unknown, not investigated** (no production data access). See the owner-run read-only indicator queries in section 10.

## 4. Affected routes
`POST /v1/billing/trial`, `POST /v1/billing/payment-result`. (`GET /v1/billing/subscription` is unaffected.)

## 5. Exact corrective changes
Two artifacts, both in this PR:
* **For `main` (development):** the PR itself.
* **For the deployed commit (`bea03e66`): `SEC-BILL-02A-BACKPORT-bea03e66.patch`** (9 files, +/- 48/25 in source plus tests). SHA-256 `22557de9d849c292dcc713a337e149e511c9034100de2b92f587cfe7c9891ad0`. `git apply --check` succeeds on a pristine checkout of `bea03e66`.
* Behaviour: a new `EntitlementService.startSelfServiceSubscription` allows only plan codes in a frozen server-side list (`['free']`) by exact match and refuses everything else with one fixed 403 (`PlanNotSelfServiceError`) before any lookup or write; the trial route calls it. The `payment-result` route and its body schema are removed. No migration, no database privilege change, no configuration change, no Caddy/Cloudflare/DNS change.

## 6. Backward-compatibility implications
* `POST /v1/billing/payment-result` returns 404. No web, admin or script client calls it (verified by search); only BUILD-28 tests and documents did.
* `POST /v1/billing/trial` with `pro` or `enterprise` returns 403 (BUILD-28 documented a `pro` trial through this route). `free` is unchanged. Unknown or differently cased codes now return 403 instead of 404.
* **Existing subscriptions are not changed.** Any enterprise/pro subscription already created through the hole stays in place; remediating those is a data decision for the owner (OD-4).

## 7. Regression evidence
* On the **deployed commit** with the backport (disposable DB at its own schema level): reproduction now shows 403 for enterprise, pro, casing variants and unknown plans, and 404 for the payment route with tenant state unchanged; its billing and route-permission tests pass (18); policy unit tests pass (5); lint, typecheck and build pass.
* On **main**: see the PR description for the full suite, mutation, lint, typecheck, build and hosted-CI results of the exact head.

## 8. Required deployment procedure (for the owner / operator; not performed)
1. Re-confirm the running commit from `/v1/health`. If it is not `bea03e66`, **stop**: the backport was built for that commit only.
2. Check out `bea03e66`, apply the patch (`git apply SEC-BILL-02A-BACKPORT-bea03e66.patch`), run `pnpm install --frozen-lockfile`, lint, typecheck, build and the billing tests.
3. Build the API image with a new, traceable `GIT_SHA` build argument (so `/v1/health` identifies the hotfix), not the same identifier.
4. Deploy with the existing runbook (`infrastructure/deployment/<host>/runbook.md` redeploy order). **No migration is run.** Production database, Caddy, Cloudflare and DNS are untouched.
5. Do not deploy `main`: it carries 210 commits and migrations 0221-0226 that were never approved for production.

## 9. Rollback considerations
No schema or data change, so rollback is redeploying the previous image tag (`bea03e66`). Rolling back **re-opens both vulnerabilities**; roll back only for an operational fault, and record it. The patch is small enough to re-apply.

## 10. Post-deployment verification plan
1. `GET /v1/health` reports the new identifier.
2. With a dedicated **test tenant** owner (never a real customer): `POST /v1/billing/trial {"planCode":"enterprise"}` → 403; `{"planCode":"pro"}` → 403; `{"planCode":"free"}` → 201 on a fresh test tenant; a second call → 409.
3. `POST /v1/billing/payment-result` as that owner → 404; the test tenant's subscription row unchanged.
4. `GET /v1/billing/subscription` → 200 for the owner; a viewer remains refused on the mutating route.
5. **Indicator queries for earlier exploitation** (owner-run, **read-only**, on the production database; not run here). The deployed code has no payment processor, so every `paid` record is by definition tenant- or operator-reported:
   * `SELECT s.tenant_id, p.code, s.status, s.created_at FROM billing.subscriptions s JOIN billing.plans p ON p.id = s.plan_id WHERE p.code IN ('enterprise','pro') ORDER BY s.created_at;`
   * `SELECT tenant_id, subscription_id, from_status, to_status, reason, occurred_at FROM billing.subscription_status_history WHERE reason = 'payment_succeeded' ORDER BY occurred_at;`
   * `SELECT tenant_id, payment_status, external_invoice_reference, updated_at FROM billing.subscriptions WHERE payment_status = 'paid';`

## 11. Residual risks
* SF-3 to SF-7 (legacy `emit_*` functions, plan-catalog DML for the application role, unauthenticated provider functions, direct identity-table writes, multi-product cancellation) are **not** addressed.
* The trusted internal `startSubscription` (any plan) remains; there is no operator process for enterprise or payment correction (by design here).
* Subscriptions already created through SF-1 remain until the owner decides (OD-4).
* The hotfix is built for one commit; any other deployed image needs its own check.

## 12. Explicit owner authorization requirement
**Deployment of this hotfix requires the owner's explicit written authorization.** This record is not an authorization and nothing has been deployed, merged or configured.
