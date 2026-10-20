# BLOCK POS-6b — Discounts (owner/admin only), no migration

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Status | Implemented in a draft pull request. **No migration, no schema or permission-data change.** Needs the API image that carries it (the same image as the POS-4/5 window, `PHASE_W2_WINDOW_PLAN_0202-0206.md`) before the counter's Discount button works in production. |
| Authorization | Owner: "POS-6b, POS-7". The survey left two options open (discount model; separate permission codes); the owner's standing instruction is to choose the recommended option. |
| Decisions taken | (1) A discount is a **signed line** (survey item 6, the smallest change): the database already allows it (`order_line_items.item_type` includes `'discount'`; unit price and line total have no sign check). (2) Role limit **without a data migration**: the route requires `bo:admin`, which `owner` and `admin` hold and the cashier role `member` does not. A dedicated `bo:discount` code would need a permission-data migration and would change the existing permission-count tests; deferred. |

## Rules (enforced on the server; the browser only pre-checks)
- Open orders only (409 otherwise). Owner/admin only (403). An `Idempotency-Key` is required, like every order write; the same key replays.
- The amount is positive and exact in the currency (KWD 3, USD 2, JPY 0), never more than the order's current total (so the total never goes below zero; a discount can take the whole order, and a zero-total order completes with no payment), at most 5 discounts per order, reason optional up to 200 characters.
- The order row is locked while a discount is added: eight discounts sent at once on a 10.00 order take at most 10.00 off (proved by test; the unlocked variant lets all eight through).
- Removing a product line that would leave the discounts larger than the rest is refused (409) and changes nothing; remove the discount first.
- The generic add-line route no longer accepts item type `discount`; the discount route is the only way.
- The sale event counts a discount line as money off, **not** as a unit sold. Payments still must equal the (discounted) total exactly, enforced by the 0206 database trigger.
- `planPayments` refuses a negative total as a last defence.

## What the cashier sees
A **Discount** button next to Complete sale (disabled with no items or a zero total); a step with Amount off and Reason, a local check, then **Confirm: give discount**; a 403 shows "Only an owner or admin can give discounts. Ask a manager to sign in and apply it."; discount lines read as money off with a negative amount.

## Files
`packages/database/src/repositories/bo/discount.ts` (pure planner), `OrderRepository.ts` (`addDiscount`, removal guard, quantity rule), `tender.ts` (negative-total guard), `apps/api/src/routes/orders.ts` and `schemas/orders.ts`, web `lib/client/discount.ts`, `lib/client/orders.ts`, `counter/order-panel.tsx`, `counter/page.tsx`; tests `discount-planning.test.ts`, `discounts.integration.test.ts` (12, live PostgreSQL), `client.discount.test.tsx` (11).

## Not done
Percentage discounts, per-line discounts, a manager-override flow on a cashier's session (today a manager signs in and applies it), a dedicated `bo:discount` / `bo:void` permission (data migration), role-limited void, order notes and tags (**POS-6c**, needs a column migration), refunds, discount reporting. The POS-6a receipt (separate PR) prints a discount line as "1 × Discount @ -x"; a small follow-up shows it as money off once both are merged.
