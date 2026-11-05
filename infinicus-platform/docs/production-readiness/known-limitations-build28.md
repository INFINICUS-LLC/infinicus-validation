# BUILD-28 — Billing and Entitlements: Known Limitations

- **(SEC-BILL-02A) The `payment-result` route described below has been removed; the Stripe sandbox webhook (STRIPE-SBX-01) is now the only path that records payment results.**
- **No real payment processor integration.** `POST /v1/billing/payment-result` accepts an already-decided payment outcome, matching what a real payment processor's webhook would report — but this build does not itself charge a card, integrate Stripe/any processor's API, or validate a webhook signature. A future build would need to add that integration and call this same `EntitlementService.recordPaymentResult()` entry point from a webhook handler.

- **No plan upgrade/downgrade for an existing subscription.** `SubscriptionRepository` supports creating a subscription and transitioning its lifecycle `status`, but changing an existing subscription's `plan_id` (e.g. free → pro without canceling and recreating) is not implemented. Kept out to hold this build to its smallest coherent scope; a real implementation would need to decide proration rules, which is itself out of scope (see below).

- **No proration, tax calculation, or invoice-document generation.** `billing.subscriptions.external_invoice_reference` stores a reference to an externally-generated invoice; this build does not generate invoice documents, calculate tax, or prorate a mid-period plan change.

- **Grace period length (7 days) is a hardcoded constant**, not per-plan or environment-configurable. A real production deployment may want this to vary by plan tier or region; tracked here rather than silently under-engineered (see configuration-build28.md).

- **The billing lifecycle audit script requires external scheduling.** `billing-lifecycle-audit.cjs`'s two commands (`expire-trials`, `expire-grace-periods`) must be invoked by an external scheduler (cron, a CI scheduled job, etc.) — this platform has no in-process background job runner (a known, standing limitation across every prior operational script in this codebase, e.g. BUILD-22's retention pruning, BUILD-24's secret rotation). Failing to schedule it means trials and grace periods never automatically expire.

- **No billing admin UI.** This build is API + server-side enforcement only; `apps/web`/`apps/admin` gained no new screens for viewing or managing subscriptions. An operator or support engineer must use the HTTP routes or `EntitlementService` directly.

- **No dedicated HTTP routes for suspend/reactivate/cancel** (only `EntitlementService.suspend()`/`reactivate()`/`cancel()` at the code level, exercised by this build's own tests and by `billing-lifecycle-audit.cjs`). These are treated as operational/support actions, not self-service tenant actions, in this build's scope — a future build could add `platform:admin`-gated HTTP routes for them following the exact same pattern as `/v1/billing/trial`.

- **Usage-limit enforcement is wired for two metrics only** (`simulation_runs`, `reasoning_runs`) — the two that map cleanly to real, existing domain actions with a plan-limit concept. `enforceUsageLimit()` (the `apps/api` preHandler factory) exists and is proven correct by this build's own tests but is not yet attached to a specific HTTP route, because no existing `apps/api` route directly exposes "create a simulation run" or "create a reasoning run" as its own endpoint today (those are reached through the deeper `DecisionWorkflowService` aggregate operations). A future build exposing those as first-class routes should wire `app.enforceUsageLimit('simulation_runs')` into them directly.
