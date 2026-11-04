# POS2-01: Current POS + entitlement reconciliation

Workstream: INFINICUS POS 2.0 program. Baseline: `main` at `b737122`. Status: DEVELOPMENT. Nothing here is deployed, priced, sold or applied to any database.

**Governing document.** The POS 2.0 proposal named in the directive was not attached to the session that wrote this note; only the directive's own text was available. Where this note says "target" it means the directive. Reconcile against the proposal itself before POS2-02.

State words used below, never mixed: **EXISTS** (code on `main`), **DESIGNED** (a merged design or decision, no code), **MISSING** (nothing found), **PRODUCTION VERIFIED** (nothing in this list: the session cannot reach production, so no row is production verified). Production is not asserted anywhere here; the last migration reported deployed (0209) is not verifiable from a session.

## 1. Current POS capability inventory (from code on `main`)

| Capability | Current implementation | Layer / owner | Tests | State | POS 2.0 target and gap | Action |
|---|---|---|---|---|---|---|
| Catalogue | `business_operations.products` (0161), create/list/patch routes, counter panel | BO | API + web | EXISTS | Same; no station, no stock link | Keep |
| Pricing authority | Server copies catalogue name and price onto the line as a snapshot (`OrderRepository.addLineItem`) | BO | repo + API | EXISTS | Server authority already holds | Keep |
| Currency | Order currency; exact minor units (KWD 3, USD 2, JPY 0) in `currency/minorUnits`; declared business currency (0185) | BO | unit + DB | EXISTS | Holds | Keep |
| Order construction | Orders, line items, quantity change, remove line, note (0207), complete, void | BO | API + repo | EXISTS | Holds | Keep |
| Discounts | `POST .../discounts`, `bo:admin` only (cashier role lacks it) | BO | API | EXISTS | Supervisor threshold missing | POS2-06 |
| Notes | Order note route | BO | API | EXISTS | Holds | Keep |
| Tender / split tender | `order_payments` (0203-0206): up to 10 per order, cash/card/other, change for cash only, exact integer minor units, card-number shape refused | BO | unit + DB | EXISTS | Holds | Keep |
| Register | `register_sessions` (0165-0168), orders linked (0202), open/close/summary | BO | API + web | EXISTS | Cash-drawer reconciliation exceptions missing | POS2-06 |
| Receipts / printing | Web receipt, ESC/POS, printer registry (0208), print jobs (0209), device bridge and Android shell | BO + web | web + API | EXISTS (device build CI-verified only) | Holds | Keep |
| Kitchen routing | One default kitchen printer for the whole ticket | BO + web | web | EXISTS (single printer); per-product routing DESIGNED (#360), not built | Per-product stations | Owner rulings first |
| Cash drawer | ESC/POS drawer pulse command only | web | web | EXISTS (pulse only); no drawer accounting | Drawer events | Later |
| Device shell | Capacitor shell, device bridge | web | CI build | EXISTS | Holds | Keep |
| Offline behaviour | `offline_sales` intake (0210), review evidence (0217-0218, disabled), POS-9 decision record, connectivity helper in web | BO + web | API + DB | EXISTS (intake) / DESIGNED (device-side completion) | Encrypted device queue, caps, reconciliation | POS2-08 |
| Inventory effects | Order completion writes order events and payments; **no inventory movement** | none | none | MISSING | Completed sale posts an inventory effect through the existing inventory authority | POS2-04 |
| Refund / reversal | `void` of an open order only; no refund of a completed sale | none | none | MISSING | Evidence-preserving reversal | POS2-05 |
| Tax | `DisabledTaxPolicyAuthorityResolver` and a non-authoritative synthetic harness; no merchant tax in orders | BO | unit | DESIGNED (disabled) | Merchant tax model, separate from SaaS tax | POS2-07 |
| Cashier / manager roles | `bo:write` (cashier) and `bo:admin` (discounts, printers); no supervisor/manager split | Auth | API | EXISTS (two levels) | Four operational roles and thresholds | POS2-06 |
| Customers | `customerId` accepted and stored on an order; no customer routes or repository found | BO | none | MISSING (column only) | Customer records | Later |
| Staff | Read-only workforce assignments screen | BO | web | EXISTS (read) | Cashier identity on sales exists via actor | Later |
| Branch | No branch concept in the UI or the order model | none | none | MISSING | Multi-branch | POS2-02 decisions |
| Reporting | BI sales report, sales history, finance overview (web, read-only) | BI | API + web | EXISTS | Holds | Keep |
| Subscription gating | See sections 2 and 3 | Billing | partial | EXISTS (tenant-level, coarse) | Capability entitlements | POS2-02 |
| Intelligence integration | Twin, ADI, ABA, outcome monitoring routes exist and share the same gate | various | many | EXISTS | Separate entitlement | POS2-02 |

## 2. Current subscription architecture (traced end to end)

- **Data:** `billing.plans` (0150, seeded `free`, `pro`, `enterprise` with `limits` and `features` JSON) and `billing.subscriptions` with **one row per tenant** (`UNIQUE tenant_id`), status `trialing | active | past_due | grace_period | suspended | canceled`.
- **Decision point:** `packages/billing/src/EntitlementService.enforceActiveSubscription`. It refuses only `suspended` and `canceled` (HTTP 402, `SubscriptionSuspendedError` / `SubscriptionCanceledError`). A tenant with no row is lazily provisioned on the `free` plan, so nobody is blocked for never having engaged with billing.
- **Route wiring:** `app.requireActiveSubscription()` (`apps/api/src/plugins/billing.ts`) sits in the preHandler chain after authentication, tenant context and the permission check and before business scope and idempotency. It is applied to state-changing routes only; reads (order list, product list, register summary, print routes, sales report) are not gated.
- **Unused machinery:** `plan.features` and `hasFeature / enforceFeature`, `plan.limits` and `recordUsageAndEnforceLimit / enforceUsageLimit` exist and are tested but **no route calls them**. `maxUsers` and `maxWorkspaces` are not enforced anywhere. The plan catalogue therefore has no commercial effect today beyond suspended/canceled.
- **Provider coupling:** none. No Stripe call, price id or product name exists in the gate; `billing/payment-result` records a result posted to it. The gate is already provider-neutral.
- **Web:** the web package has no subscription or entitlement awareness; a 402 surfaces as a generic error.

## 3. POS to intelligence coupling

- **The same single concept gates both.** POS Core writes (orders, products, register sessions, printers, print jobs, offline sales: 14 gate sites in 6 files) and intelligence writes (decisions, twin, recommendations, ABA, execution activations, data acquisition, inventory evidence, handoffs) all use `requireActiveSubscription()`. There is no distinction between them.
- **Consequence:** the subscription is tenant-wide and all-or-nothing. Suspending a tenant stops POS and intelligence together; a `free` tenant has both. A business cannot currently buy POS without intelligence, or the reverse, because there is one row per tenant and no capability concept.
- **Tests that define behaviour:** `packages/billing/tests/EntitlementService.integration.test.ts` (status gate, lazy provisioning and its race, features, usage limits, payment lifecycle); `apps/api/tests/billing.integration.test.ts` (one gated route: `/decisions`, 402); architecture guards `ac1-adi-producer`, `ac2-bdt-state`, `ac2-bi-evidence`, `bdt.performance`, `p0-6h` assert the literal text `requireActiveSubscription(), app.requireIdempotencyKey` on **intelligence** routes. **No test existed for a suspended tenant on any POS route**; this block adds them.

## 4. What this block delivered (the smallest safe seam)

1. `packages/billing/src/capabilities.ts`: the capability vocabulary (`pos.core`, `pos.inventory`, `pos.multi_branch`, `pos.restaurant`, `pos.offline`, `intelligence.explorer|starter|growth|pro`, `enterprise.custom_integrations|custom_limits`) and a pure `entitlementProfileFor(status)`.
2. `EntitlementService.enforceCapability(ctx, capability)`; `CapabilityNotEntitledError` (HTTP 403).
3. `app.requireCapability(capability)` beside the unchanged `requireActiveSubscription`.
4. The 14 POS Core gate sites (every state-changing handler in six files) now use `requireCapability('pos.core')` in the same chain position. Intelligence routes are untouched, so the architecture guards on them still pass.

**Compatibility profile.** Every functional subscription holds every capability; suspended, canceled and unknown statuses hold none. `enforceCapability` first runs `enforceActiveSubscription`, so a suspended or canceled tenant gets the identical 402 and message. No tenant's behaviour changes. The profile is explicitly labelled `compatibility` so it cannot be mistaken for a commercial entitlement.

Not delivered, by design: no schema change, no plan or price change, no Stripe, no capability data on plans, no web change, no read gating, no use of `pos.offline` or other capabilities yet.

## 5. Entitlement contract (stable surface)

```
Capability       = 'pos.core' | 'pos.inventory' | 'pos.multi_branch' | 'pos.restaurant' | 'pos.offline'
                 | 'intelligence.explorer' | 'intelligence.starter' | 'intelligence.growth' | 'intelligence.pro'
                 | 'enterprise.custom_integrations' | 'enterprise.custom_limits'
EntitlementProfile = { basis: 'compatibility'; capabilities: ReadonlySet<Capability> }
entitlementProfileFor(subscriptionStatus: string): EntitlementProfile        // pure, fail closed
EntitlementService.enforceCapability(ctx, capability): Promise<void>         // 402 suspended/canceled, 403 not entitled
app.requireCapability(capability)                                            // after requirePermission, before requireBusinessWorkspace
```

Rules: a capability is never a provider product, plan code or price; entitlement, role and business policy are three separate checks and a sensitive action may need all three; a missing or unknown entitlement fails closed; the business id is never taken from the client as authority (the gate is tenant-level and runs before business scope).

## 6. Later changes that need schema or owner decisions

- **Schema (POS2-02):** a tenant needs more than one entitlement source (POS Core and an intelligence plan are separate purchases), but `billing.subscriptions` is one row per tenant. Options: (a) several subscription rows per tenant keyed by a product family, (b) an `entitlements` table derived from subscription state, (c) capability keys on `plans.features`. (c) needs no migration but cannot express two independent subscriptions. A migration number must be re-checked at that time (`main` already holds 0222 to 0224).
- **Owner decisions:** which capabilities each commercial tier includes; whether `free` keeps POS (today it does, because the lazily provisioned free plan passes the gate); whether `pos.offline` and `pos.inventory` are separate products; whether reads of POS data stay open when a subscription lapses; grace behaviour for POS-only tenants; whether a lapsed tenant may still export its own data; who sets capability data in production; billing-provider mapping lives outside the core.
- **Data:** a POS-only tenant already produces orders and payments with no intelligence entitlement, because data production is not gated by anything beyond the write gate. POS2-02 must keep it that way and gate only the consumption of intelligence capabilities.

## 7. Conflicts found

None blocking. One observation: the directive's "pos.offline" capability and the POS-9 offline decision record are consistent; no existing authority forbids a separate capability. The kitchen-routing note (#360) named 0222 as the next migration number; `main` now has 0222 to 0224, so that figure is stale and must be re-checked when that block is written.
