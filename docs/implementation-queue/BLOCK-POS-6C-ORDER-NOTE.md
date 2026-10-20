# BLOCK POS-6c — Order note (one column migration, planned into the Phase W2 window)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Status | Implemented in a draft pull request. **Migration `0207_add_order_note.sql` is NOT applied to production**; it is added to the Phase W2 window (`PHASE_W2_WINDOW_PLAN_0202-0206.md`, now covering 0202 to 0207). |
| Authorization | Owner: "POS-6c, planned with the next production window". |
| Scope decision | The roadmap's "order notes and tags": **notes only**. Tags would need a second table or column and an owner decision on their meaning; deferred. |

## What it does
- An open order can carry an **internal note** ("table 4, no sugar", "pick up at 6"): 1 to 500 characters after trimming; an empty note clears it; never a card number (13 or more digits in a row, separators allowed): refused by the planner and, for any write that bypasses the API, by the database check `orders_note_format`.
- `POST /v1/businesses/:businessId/orders/:orderId/note` with `{ "note": text | null }`: permission `bo:write` (owner, admin and member; a viewer can read it), the shared business-workspace guard, an Idempotency-Key; the order row is locked; **open orders only** (409 once completed or voided: the note then stays as it was, read-only). Each change writes an order event (`order_note_set` / `order_note_cleared` with the length, not the text).
- The note is returned with every order read (get, list). The counter shows a Note box with **Save note** on an open order (disabled until the text changes and is valid, and while offline or a confirmation is open), a read-only line on closed orders, and a short preview in the open-orders list.
- The note is **internal**: it is not printed on the customer receipt (tested).
- It does not touch totals, lines or payments (tested).

## Compatibility with the staged release
Order reads use `SELECT *` and the web schema treats `note` as optional, so the new code runs before the migration (reads return no note; only saving a note would fail) and the old API runs after it (it ignores the column).

## Files
`infrastructure/database/migrations/0207_add_order_note.sql`, `packages/database/src/repositories/bo/note.ts` (planner), `OrderRepository.ts` (`setNote`, `note` on `Order`), `apps/api` route and schema, web `lib/client/note.ts`, `schemas.ts`, `orders.ts`, `counter/order-panel.tsx`, `counter/page.tsx`; reference fingerprint `reference-0207.pg16.*` (hash `bbd6bd1f31ad9ea9`) and the `REF_0207_PG16` verdict in the discovery script; tests `note-planning.test.ts`, `orderNote.integration.test.ts` (10, live PostgreSQL), `client.note.test.tsx` (14).

## Not done
Tags; a note on a completed order (read-only by design; a correction would be a later "annotation" feature); notes in the sales history page; printing a note on a kitchen ticket (kitchen tickets are not built); note search.
