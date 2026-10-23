# PUR-WEB-1: Purchasing and suppliers screen (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Operations. Source of truth: Business Operations purchase orders and suppliers. Status: implemented, not deployed.

## Contracts used (no backend change)

- `GET /v1/businesses/:businessId/operations/procurement?limit=100[&status=...]` (existing; `bo:read`)
- `GET /v1/businesses/:businessId/operations/suppliers?limit=100` (existing; `bo:read`)

Both are tenant- and workspace-scoped from the authenticated context; the business must exist in the workspace (else 404); the API clamps `limit` to 1-100. The screen is `/businesses/<id>/purchasing`, a new **Purchasing** tab. No new API, permission, table or migration.

## What the screen shows

- **Purchase orders**, newest first: order number, supplier, ordered and expected dates (UTC), total in the order's own currency, status in plain words, approval date. A status filter (the six statuses the API accepts) is the only control.
- **Suppliers**: name, code, status, risk status, latest performance score and its date, or "not scored yet".

Rules the screen keeps:

- **Exact, never rounded.** A total is shown only if it is a whole number of its currency's minor units (KWD to the fils); an amount with more decimals than the currency has, or a currency the platform does not know, is shown as "amount unavailable".
- **Nothing is added up.** Orders are in different currencies; there is no total row, no spend figure and no conversion.
- **Honest about the bound.** Each list is at most 100 rows and the API gives no total; a full list shows a notice that more may exist.
- **Fails closed and read-only.** Responses are validated on every read; loading, error and empty states have the right roles; no button, form or input exists, and the screen says it does not order, approve, receive or pay.

## Evidence

- 24 unit/render tests (`client.purchasing.test.tsx`): paths and encoding, the status control, exact formatting and refusal, status words and dates, contract rejection, truncation, every view state, read-only, filter options, page guard; tab bar now nine screens; NA-05 guard allow-lists the page (10 tenant pages).
- Mutations killed: the exactness check removed (2 tests), the truncation threshold changed (2 tests).
- Both web schemas parsed the **real API responses** (live PostgreSQL, application role, existing BUILD-32 seed) and re-serialised identically; the real USD total `500` is shown as `500.00`. A temporary copy of the suite was used and not committed (the web package must not import API code).
- Web package 437/437, lint, typecheck, `next build` (route present), static-export check (10 required screens).

## Decision recorded: why there is no business overview or KPI screen yet

`GET .../operations/summary` is the only existing "summary", but it aggregates the operational **event log** (`business_events`), not orders: its sales, expense and inventory figures are plain JavaScript numbers **with no currency code**. A screen on it would show money without an explicit currency and would create a second source of truth for sales next to the order-based sales report and the financial report. A KPI also needs a business definition the owner has not given. So no overview or KPI screen is built on it. If the owner wants an overview, it should be a composition of the existing order-based reports (sales, finance, inventory) with owner-approved definitions, not this endpoint.

## Not in this block

Creating, approving, receiving or paying purchase orders, supplier management, goods receipts and purchase-order lines, search, pagination beyond 100 rows (needs an API change), and a browser run against a live API.
