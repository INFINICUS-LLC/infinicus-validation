# BI-SALES-1: Sales report (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: Business Intelligence (BI-22 reporting). Source of truth: Business Operations orders. Status: implemented, not deployed.

## Contract

`GET /v1/businesses/:businessId/bi/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD`

| Rule | Value |
|---|---|
| Authentication | required (401) |
| Permissions | `bi:read` **and** `bo:read` (403 if either is missing). No new permission. |
| Scope | tenant and workspace from the authenticated context (row-level security); the business must exist in the caller's workspace (404 otherwise) |
| Period | explicit, inclusive range of calendar days on the order's recorded `order_date`; both parameters required, strict `YYYY-MM-DD`, real dates, `from <= to`, at most 366 days (400 otherwise) |
| Writes | none. The report is computed on read and persisted nowhere (no BI table, no cache), so there is no second source of truth |

### Definitions (stated once, in `SalesFactsRepository`)

- **Sale** = an order whose `operational_status` is `completed`. **Voided** = `failed`. **Open** = `planned`. Any other status is counted as `otherStatusOrders` and never as a sale.
- **Net** = the order's authoritative `total_amount`. **Gross** = sum of its non-discount lines. **Discounts** = sum of its discount lines (stored as signed lines). Gross - discounts = net; each currency section reports `reconciles`, and a mismatch is reported, never adjusted.
- **Reporting day** = the order's `order_date`, the database calendar date at creation. This is NOT a business-local day. See "Owner decision" below.

### Money

- Every figure is an **integer in minor units** of its currency (KWD fils, USD cents, JPY yen) with the currency code and `minorUnitExponent` beside it.
- Amounts leave the database as exact decimal text and are converted digit by digit (no floating point). A value that is not an exact multiple of the currency's minor unit, or a currency outside the supported ISO 4217 table, yields `NOT_AVAILABLE` with a named code (`AMOUNT_NOT_REPRESENTABLE`, `UNSUPPORTED_CURRENCY`); no figure is returned.
- **Currencies are never combined.** A business that sold in two currencies in the period (its declared currency is versioned) gets two sections, ordered by currency code.
- Average order value = net / completed orders, integer minor units, **rounded half up**; `null` when there is no completed order.

### Response

`200 { outcome: 'REPORT', report }` or `200 { outcome: 'NOT_AVAILABLE', code, detail }`.
`report = { businessId, period{from,to,days,basis:'order_date',inclusive:true}, source{layer:'BO',definition}, currencies[{ currency{code,minorUnitExponent}, totals{...,averageOrderNetMinor,reconciles}, daily[...] }] }`.
`daily` is continuous: every day of the period is present, with zeros for days without orders. A period with no orders returns `currencies: []` (nothing is invented).

## Architecture

```
API route (apps/api)  --composition-->  SalesReportService (BI, packages/workflow)
                                              | structural port (SalesFactsPort)
                                              v
                                   SalesFactsService (BO, packages/business-operations-runtime)
                                              v
                                   SalesFactsRepository (BO-owned, packages/database/repositories/bo)  [read-only SQL]
```

BI never imports Business Operations; BO exposes read-only facts through a port joined at the API composition root (the same pattern as the inventory BI evidence). Static guards (`bi-sales-report.architecture.test.ts`) pin: no write verbs or persistence in the BI service or BO facts files, the only tables read are `platform.orders` and `business_operations.order_line_items`, no float conversion, and the route is exactly one GET gated by both permissions.

## Evidence

- Unit: decimal conversion (exact, refuses non-representable amounts), period validation, per-currency sections, continuity, reconciliation, averages (43 tests).
- Live PostgreSQL, application role with RLS: repository (7), full HTTP route (22) including a sibling business, a second tenant, 4 permission combinations, 9 invalid periods, read-only proof.
- Mutation checks, each killed: business predicate removed, workspace guard removed, `bo:read` removed, voided orders counted as sales.

## Owner decisions this report does not make

1. **Business-local reporting day.** `order_date` is the database calendar date. A business in Kuwait (UTC+3) selling after 21:00 UTC is dated by UTC. Reporting by the business's local day needs an approved timezone rule per business.
2. **Tax and fees.** Fee lines count in gross. No tax semantics are interpreted; a tax policy needs an owner ruling before the report states tax.
3. **Refunds and returns.** No refund flow exists in Stack B orders yet, so none is reported.

## Not in this block

Web screens (next block), persisted metrics or insight packages, trends and anomaly analysis (BI-4), cost and margin (needs unit-cost policy), inventory and finance reports.
