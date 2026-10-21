# BLOCK POS-8c — Print-job log, print routing, kitchen ticket (migration 0209)

Status: IMPLEMENTED — VALIDATION PENDING (CI). **Migration 0209 is NOT applied to production** (proven on throwaway PostgreSQL 16 only); proposed for the Phase W2 window (see `PHASE_W2_ADDENDUM_0208.md`, section 0209). Builds on 8a (receipt), 8b (printer registry), 8d-1 (device bridge).

## What it adds
- **Print-job log** — `business_operations.print_jobs` (0209): one row per print attempt, written after the attempt with its outcome. Append-only (UPDATE/DELETE/TRUNCATE refused by the existing `business_operations.forbid_mutation()`; no new function). Stores kind (receipt|kitchen), trigger (automatic|reprint|manual), outcome, a **fixed failure code** (printer_error|timeout|unsupported|other, never free text), printed_via (browser|device), the registry printer if any. **No content**: no lines, no customer data, no note text, no address.
- **API** (`apps/api/src/routes/printJobs.ts`): `POST /v1/businesses/:id/orders/:orderId/print-jobs` (`bo:write`, Idempotency-Key; a receipt only for a completed order, a kitchen ticket for an open or completed order but not a voided one; a printer must be in the business and of the logged kind), `GET …/orders/:orderId/print-jobs`, `GET …/print-jobs?limit`, `GET …/print-routes` (the active default printer of each kind, or null). Reads need `bo:read`.
- **Routing**: the counter asks `print-routes`; a registered default receipt printer decides the receipt's paper width (the cashier's choice is not offered then); the default kitchen printer decides the kitchen ticket's. No routes (or any lookup failure) = browser printing with the cashier's choice, exactly as before.
- **Templates (code-level)**: customer receipt (8a) and **kitchen ticket** (`lib/client/kitchenTicket.ts`): order number large, product lines only, **the saved cashier note** (kept off the customer receipt on purpose), no money. HTML (escaped, CSP-locked, Arabic-safe) and ESC/POS (ASCII, falls back to HTML otherwise).
- **Send to kitchen** button on an open order with a product line. Printing goes through the device shell if present, else the browser; the log entry is recorded afterwards.
- Receipt prints (automatic and reprint) are logged the same way.

## Safety
Logging and routing are **best effort**: a failed lookup or log call never delays, blocks or fails a print (an API not yet migrated, a lost connection). A shell failure is not retried through the browser (no duplicate paper copy).

## Not in this block (deliberate)
- **Per-product kitchen routing** (different stations per item) needs a product-to-station mapping (a products column or table): next migration, not here. Today the whole ticket goes to the default kitchen printer.
- **Business-editable templates** (header/footer text, logo) need stored configuration: later block.
- A screen to view the print-job log, and to manage printers (the registry has an API only).
- Retrying a failed kitchen ticket automatically; kitchen display screens.

## Verification (local, throwaway PostgreSQL 16)
- API: `printJobs.integration.test.ts` (9, live DB + Fastify): append-only even for the administrator, no-content columns, fixed codes, order-state rules, printer kind/business rules, permissions, idempotent replay, isolation incl. direct RLS as the app role, routes, DB check constraints. 6 of 7 mutations caught (the 7th, "retired printers in routes", is equivalent: the database already forbids a retired default).
- Web: `client.printJobs.test.tsx` (14): kitchen ticket content/escaping/ESC-POS, route/code mapping, best-effort log, routing, panels. 7 of 7 mutations caught.
- Reference fingerprint `reference-0209.pg16.*` (hash `325158ea2a54cde9`); method first validated by reproducing the committed 0208 reference byte for byte; function fingerprint unchanged. Rollback: `DROP TABLE business_operations.print_jobs;` (in the migration header).
