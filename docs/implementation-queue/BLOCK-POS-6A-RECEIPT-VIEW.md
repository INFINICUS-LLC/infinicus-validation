# BLOCK POS-6a — Receipt view and print (code only)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Status | Implemented in a draft pull request; **no migration, no API change, no production change.** Safe to merge before or after the 0202–0206 window, but the receipt shows payments only once the API with POS-5 is deployed. |
| Authorization | Owner: "skip these and continue development". POS-6 as listed in `BLOCK-POS-COUNTER-INTERFACE-PREPARATION.md` (discounts, notes, receipts) was sliced; this is the part that needs no owner decision and no migration. |

## What it does
- A **receipt** for a **completed** sale, built from the order the server already returns (lines, payments, change, currency, order number, date). It opens automatically after a sale is completed, can be reopened with **View receipt**, and closes with **Close receipt**.
- **Print** uses the browser's print dialog; the print stylesheet shows only the receipt.
- Header: the business's legal name when the business list holds it; otherwise no name line.

## Rules kept
- The browser adds up nothing: total, amounts applied and change are the server's, shown with the currency's exact decimal places (KWD 3, USD 2, JPY 0).
- An open, voided or failed order has no receipt.
- A payment reference that looks like a card number (13 or more digits) is never printed (`reference hidden`); the server and database already refuse such references.
- The receipt is presentational: no storage, no extra request beyond the business list.

## Files
`lib/client/receipt.ts` (pure builder), `counter/receipt-view.tsx`, `counter/order-panel.tsx` (optional button), `counter/page.tsx` (state and wiring), `app/globals.css` (screen and print styles), `tests/client.receipt.test.tsx` (11 tests).

## Not done (still POS-6 / later)
Discounts (needs the model decision, survey item 6, and a migration), order notes and tags (migration), role-limited void/discount permissions, kitchen tickets and tables, a printer driver or hardware printing, a numbered/legal receipt format and tax lines, emailed receipts, receipt re-print for orders other than the one open on screen, refunds (separate block after v1), offline queue (POS-7).

## Limitation to know
The business name comes from the first page of the business list; with more businesses than one page holds, a business not on that page prints a receipt without a name line.
