# POS-6b — Completed sales history and receipt reprints

Integration note (POS-6e): this original specification is retained for history. The active dependency is now PR #192, and receipt headers use its exact verified business lookup. The original first-page header limitation and original unmerged-PR dependency below are superseded by BLOCK-POS-6E-SALES-HISTORY-INTEGRATION.md.

Date: 2026-10-20. Authorization: owner request, "next build", following POS-01 foundation fixes in PR #189. This block is stacked on that unmerged PR; neither PR is merged automatically.

Layer/domain: BO / COMMERCE. The web application reads the existing authenticated `/v1` API; BO remains authoritative. No migration, production action, H-5A/recovery change or locked-spec amendment.

## Behavior

- Counter navigation opens `/businesses/:businessId/sales`.
- Completed sales are shown newest first, 20 per page, with server order numbers, recorded creation dates, currency and totals. Older/newer navigation uses server IDs as cursors, rather than an arbitrary first-100 cutoff.
- `GET /v1/businesses/:businessId/orders` accepts optional `before` (UUID). Ordering is `(created_at DESC, id DESC)`; timestamps remain inside PostgreSQL at full precision. A cursor must identify an order in the requested business and current tenant/workspace, otherwise the API returns 404. Existing `bo:read` checks remain in force.
- The list deliberately remains a summary. Opening a receipt fetches the full scoped order, including recorded lines, payments and change. Only completed orders with matching business/order IDs are rendered; other responses fail closed.
- Reprints reuse the existing receipt component, browser print dialog and receipt-only print stylesheet. No new receipt number, fiscal designation or payment record is created. Quantities retain all four decimal places supported by the order contract.
- A new selection, refresh, page change or close invalidates older outstanding responses. Changing authenticated API, workspace or business creates a fresh controller with no prior receipt or rows.
- Loading, empty, retry and permission/error states are explicit. History contains no completion, void, refund or other operational mutation controls. Pagination and receipt controls have accessible labels and 44px minimum height.

## Validation

Client tests cover pagination, scoped GET-only access, receipt detail retrieval, response identity/state checks, late responses, workspace isolation, currency display, loading/error/empty states and route guards. Live API tests cover equal sub-millisecond timestamps, new sales arriving between pages, complete traversal without duplicate/skipped rows, foreign cursor refusal, viewer access and receipt detail integrity. Existing POS regression suites and the web architecture guards remain in place.

## Limits

- The list is live history, not a frozen report snapshot. Newly completed sales appear on refresh of the newest page; navigating backward does not add new rows above the current cursor.
- As in POS-6a, the optional receipt business-name header comes from the scoped first page of businesses; if absent, no name is guessed. This is not a new legal/fiscal receipt format.
- No search/date filtering, CSV/export, refund, discount/tax policy, branch authority, emailed receipt, printer driver or offline queue. Those remain separate blocks.
- Web hosting and release of existing database migrations remain separate owner-controlled work.

Stop after this block and return the tested commit and PR for owner review.
