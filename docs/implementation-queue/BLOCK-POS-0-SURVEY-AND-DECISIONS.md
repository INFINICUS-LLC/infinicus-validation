# BLOCK POS-0 — Counter POS survey, gap confirmation, wireframes and decision record

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Status | **SURVEY ONLY — docs only.** No code, migration, configuration or production change. POS-1 and later are **not authorized**. |
| Authorization | Owner chose "POS-0 survey" on 2026-10-18 when asked which block to run next. This is a deliberate decision to start POS-0 ahead of the release programme; the preparation document had queued it after the current builds. It changes no release gate and uses no production resource. |
| Builds on | `docs/implementation-queue/BLOCK-POS-COUNTER-INTERFACE-PREPARATION.md` (merged in #160) |
| Evidence labels | `REPO-VERIFIED` read from `main` at `9aec2fc`; `NOT VERIFIED` not checked or not decided; `DECISION` needs the owner. |
| Method | Read the API routes, schemas, repositories, migrations and the web client; nothing was run against production. |

## 1. Corrections to the preparation document (REPO-VERIFIED)
The preparation document was written from route names and a quick read. This survey found it wrong or incomplete on these points:
| Preparation statement | Survey finding |
|---|---|
| §3 item 6: "no idempotency key exists on those routes" | **Wrong.** Every mutating route in `orders.ts` (5 of 5), `products.ts` (2 of 2) and `registerSessions.ts` (2 of 2) uses `app.requireIdempotencyKey`. The client must send an `Idempotency-Key` header; a replay with the same key and body returns the original response, the same key with a different body is a 409, and a request in flight is refused. `apps/web/lib/client/apiClient.ts` already supports an `idempotencyKey` option. Duplicate-order protection therefore exists server-side; the POS client must generate and reuse a key per action. |
| §3 item 4: discount and void rules need defining | Confirmed and sharpened: see §2 (permissions, discount semantics). |
| §3 item 3: tax and currency | Sharpened: orders always take the database default currency `USD` (see §2). |

## 2. Confirmed findings (REPO-VERIFIED)
| # | Area | Finding | Consequence for the POS |
|---|---|---|---|
| F1 | Order create | `OrderRepository.create` inserts into `platform.orders` without setting `currency_code`, so every order carries the column default **`'USD'`**, whatever the business's declared currency (migration 0185 declarations are not consulted). | A non-USD business would record sales labelled USD. Needs an owner decision and a fix before any real sales. **Fixed by POS-1.5 (draft PR): `OrderRepository.create` now takes the business's declared currency through `BusinessDeclaredCurrencyReader`, and an undeclared business fails closed with 409 (no default).** |
| F2 | Pricing authority | `addLineItem` accepts `description`, `quantity` and `unitPrice` from the client; the product is only an optional `productId`. The server does not look up the product price. | The counter can send any price. Decide: server-side price lookup from the product (recommended), or allow a controlled override for permitted roles. |
| F3 | Discounts | `itemType` may be `discount`, but `unitPrice` is validated `>= 0` in the API schema, and the order total is `SUM(line_total)`. A discount line therefore **adds** to the total; a negative discount cannot be entered. (The database has no CHECK on `unit_price`; only the API schema blocks negatives.) | A working discount needs a defined model: a negative line, a percentage field, or a separate discount record. This is a design decision plus a small API change. |
| F4 | Void and refund | `void` works only on `planned` orders and sets status `failed`; `complete` works only on `planned` orders with at least one line. There is **no path to void or refund a completed order** (`reversed` exists in the vocabulary but nothing sets it). | The counter can cancel an open order, not undo a completed sale. A refund/reversal flow is a separate sub-block and a decision. |
| F5 | Sale record | `complete` sets `completed`, writes an `order_events` row and a `business_events` `sale` row (amount, total quantity, customer, order number) in one tenant transaction. Totals use `round2`; the column is `numeric(18,4)`. | Good: the "keep the sales record" requirement is met by the API today. Rounding policy (2 decimals) should be confirmed for currencies without cents. |
| F6 | Payment | No tender, tendered amount or change is stored anywhere; the sale event has no payment fields. | Needs a decision and probably a migration (POS-5). |
| F7 | Register close | `RegisterSessionRepository.close` computes `expected_cash = opening cash + SUM(business_events.amount WHERE event_type = 'sale' AND business_id = … AND occurred_at >= session open)`, **treating every sale as cash**, and `variance = closing − expected`. Orders carry no register-session id. The source comment says this is a placeholder until payments exist. | Cash reconciliation is only meaningful after tender capture; and sales of other registers of the same business are included. |
| F8 | Authorization | Every order, product and register write needs the permission `bo:write` (reads `bo:read`). The seeded system roles are `owner`, `admin`, `member`, `viewer`; `member` holds all read and write permissions, `viewer` read only, `admin` everything except platform admin. There is **no cashier/manager distinction**: any member can add lines, complete or void. Writes also require an active subscription. | Role-limited discounts and voids (POS-6) need new permission codes or a rule layer; that is a data change and a decision. |
| F9 | Inventory | `complete` touches no inventory table. Inventory writes are governed by the 0182–0198 controls and the reorder-policy work; products have no stock link. | A first POS version records sales only; stock decrement is a separate, deliberate block. |
| F10 | Orders data model | `platform.orders` has no notes, tags, table, channel or register-session columns; `order_events` has a notes column used for void reasons. | Kitchen tickets, tables, tags and per-order notes need schema work if wanted. |
| F11 | Web client | `apps/web` (Next.js 15, React 19, zod) has an API client with schema validation and idempotency support, auth and workspace scoping, page-render tests and a client-boundary architecture test; its console page is a 50-line session check. No order, product or register UI exists. | The counter is a new route family; it must pass the existing boundary and browser-secret tests. |
| F12 | Hosting | `apps/web` is not hosted in production (NEW-ARCH-R0 and Criterion J remain open; the production VM serves only the API). | A counter cannot be used by staff until the web-hosting decision and its gates are closed. |

## 3. Updated gap list
| Gap | Status after survey |
|---|---|
| Idempotency | **Closed** (exists; the client must use it). |
| Payment / tender | Open (F6) |
| Register-session link and reconciliation | Open (F7) |
| Currency | **Defect found** (F1) |
| Pricing authority | Open (F2) |
| Discount model | Open (F3) |
| Void/refund of a completed sale | Open (F4) |
| Role-limited actions | Open (F8) |
| Kitchen / tables / tags / notes / printing | Open (F10) |
| Inventory effect | Deferred (F9) |
| Offline | Open, recommended out of v1 |
| Hosting | Blocked by an open decision (F12) |

## 4. Wireframes (text; tablet landscape, drawn from the owner's photograph)
```
COUNTER (POS)                                                        2:18 PM  Sun 18 Oct  [wifi]
+-----------------------------+----------------------------------------------------------------+
| ORDER  ORD-xxxx   (planned) |  [Print] [Kitchen*] [Void] [Discount*] [Notes*] [Tags*] [More] |
|-----------------------------|  [ Search products ........................................ (o)]|
|  1 x Espresso        3.50   |  +-----------+ +-----------+ +-----------+ +-----------+         |
|  2 x Milk            2.00   |  | ESPRESSO  | |   MILK    | |    V60    | | DESSERTS  |  ...    |
|  ...                        |  | (tile)    | |  (tile)   | |  (tile)   | |  (tile)   |         |
|                             |  +-----------+ +-----------+ +-----------+ +-----------+         |
|-----------------------------|     category tabs / active products from the products API        |
|  Total (server)       7.50  |                                                                  |
|  [ COMPLETE ]    [ VOID ]   |                                                                  |
+-----------------------------+------------------------------------------------------------------+
| HOME            ORDERS (list, status filter)            TABLES*                    + NEW ORDER |
+------------------------------------------------------------------------------------------------+
* = not in the first version unless the owner includes it (decision 2)

OPEN REGISTER                         CLOSE REGISTER
  Register name   [ Front counter ]     Expected cash (server)   123.00   (only meaningful with tender)
  Opening cash    [ 0.00          ]     Counted cash             [ ____ ]
  [ OPEN ]                              Variance (server)        shown after close   [ CLOSE ]

ORDERS LIST
  filter: planned | completed | failed      row: number, time, total, status, [open] [void if planned]
```
Interaction rules the build must follow: the total shown is always the server's; every action sends a fresh `Idempotency-Key` and reuses it on retry; Complete and Void ask for confirmation and disable the button while the request is in flight; errors from the conflict cases (not planned, no lines) are shown plainly; touch targets at least 44 px; labels for screen readers; no browser storage as a source of truth.

## 5. Revised decisions for the owner (with recommendations)
| # | Decision | Recommendation |
|---|---|---|
| 1 | First device and users | Tablet counter, staff with the `member` role; owner/admin for setup. |
| 2 | In the first version | Product tiles, order panel, complete, void-open-order, orders list, open/close register. **Out:** tables, kitchen tickets, printing, tags, per-order notes, discounts, refunds, inventory, offline. |
| 3 | Payment | Add tender capture (cash, card as a record only, other; amount tendered; change) before real use; this is POS-5 and needs a migration. Until then the counter is a demo, not a till. |
| 4 | Currency and tax | Fix the `USD` default (F1) by taking the business's declared currency, with a test; state prices as tax-inclusive for v1 and add tax later. |
| 5 | Price authority | Server looks up the product price for product lines; override only for `owner`/`admin`. |
| 6 | Discount model | A discount as a signed line is the smallest change; or a percentage field on the order. Needs a decision before POS-6. |
| 7 | Roles | Keep `bo:write` for v1; add separate permission codes (for example `bo:discount`, `bo:void`) in POS-6. |
| 8 | Hosting | Decide hosting under NEW-ARCH-R0 and close its gates first; build behind a feature flag meanwhile. |
| 9 | Refund / reversal of completed sales | Separate block after v1. |

## 6. Effect on the sub-block plan
POS-1 (shell and catalogue) and POS-2 (order building) are unaffected and need no migration. POS-3 (complete/void) is unaffected for open orders but F4 and F1 mean **no real sales should be recorded** until the currency default is fixed and tender capture exists. POS-4/POS-5 are tied together (F6/F7). POS-7 gets smaller: idempotency exists, so offline tolerance is a client queue plus the existing key. A new small block **POS-1.5 (currency default fix)** is proposed ahead of POS-3.

## 7. Release-programme interaction
The POS work adds no production access. Any POS migration (F1 fix is code only; F6/F7/F8/F10 would add schema) must wait for a release window after 0199–0201 and uses migration numbers after the then-current head. The release programme keeps priority.

## 8. Not done
No code, migration, configuration or production change; no POS sub-block beyond this survey; no deployment; no Cloudflare/DNS change.
