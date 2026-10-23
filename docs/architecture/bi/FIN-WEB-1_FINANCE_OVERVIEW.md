# FIN-WEB-1: Finance overview screen (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Intelligence. Source of truth: the NEW-BI-01 financial report (`bi-financial-report/1`, based on `bo-financial-facts/1`). Status: implemented, not deployed.

## Contract used (no backend change)

`GET /v1/businesses/:businessId/intelligence/financial-report?from&to&granularity&compare=previous` (existing; `bi:read`, held by owner, admin, member and viewer; tenant and workspace from the authenticated context; business must exist in the workspace, else 404; period at most 366 days). The screen is `/businesses/<id>/finance`, a new **Finance** tab. No new API, permission, table or migration. Nothing here duplicates the sales report: that is the order-level sales view in integer minor units; this is the financial view (revenue, expenses, goods received, evidenced gross profit, comparison, trend) in the report's decimal text.

## What the screen shows

For the chosen period (presets Today, Last 7, Last 30, or two dates; the same period rules as the server are explained before a request): per currency, revenue and order count, average order, expenses and claim count, goods received, and gross profit; a comparison with the preceding period of equal length; a trend table; orders by status; the indicators Business Operations recorded; and the report's coverage notes in plain language.

- **No figure is computed in the browser.** Amounts arrive as decimal text, already rounded for their currency by the server, and are only regrouped for reading (`1234567.500` -> `1,234,567.500`) by string operations; they never become numbers. Differences and percentages are the server's.
- **Currencies are never combined or converted**; each has its own section, and no total across currencies exists on the screen.
- **Unsupported figures say why, not zero.** Gross profit shows its amount and margin only when the server computed it; otherwise "no revenue in this period" or "not shown: cost is recorded for X of Y sale lines". A missing earlier-period figure shows "no earlier figure to compare with" instead of a percentage. No orders or an unsupported currency says so.
- **Coverage notes are shown, never hidden.** Known notes are explained; an unknown note from a newer server is shown as sent.
- **Dates are UTC calendar days** (the report's definition); a business-local day needs the owner decision already listed for the sales report.
- **Trend granularity is chosen from the period length** (up to 31 days by day, up to 186 days by week, longer by month) so the table stays readable; the server accepts all three.
- **Fails closed.** The response is validated on every read (wrong contract, numeric money or a non-decimal amount are refused); a server error shows as an error, never a partial report. Loading, error and empty states have the right roles.
- **Read-only.** The only buttons choose a period.

## Evidence

- 29 unit/render tests (`client.financialReport.test.tsx`): decimal regrouping and refusal, request path and encoding, granularity boundaries, contract rejection, every state (gross profit computed / no revenue / insufficient evidence, no orders, unsupported currency, comparison with and without a baseline, empty period), read-only, period guard, page guard; tab bar now eight screens; NA-05 guard allow-lists the page (9 tenant pages).
- Mutations killed: digit grouping off by one (8 tests), the no-baseline branch (1), the no-revenue text (1).
- Contract copy checked against **nine real API responses** from the existing NEW-BI-01 integration suite (live PostgreSQL, application role: two currencies, comparison, weekly trend, empty period): each parses with the web schema and serialises identically. A temporary copy of the suite was used and not committed (the web package must not import API code).
- Web package 413/413, lint (no warnings), typecheck, `next build` (route present), static-export check (10 required screens).

## Not in this block

Net profit, tax, credit notes and currency conversion (the report states it does not derive them), charts, export, business-local days (owner decision), saved or scheduled reports (BI-5), and a browser run against a live API.
