# BLOCK POS — Counter POS interface (Business Operations) — PREPARATION

| Field | Value |
|---|---|
| Date prepared | 2026-10-18 |
| Status | **PREPARED — NOT AUTHORIZED — QUEUED AFTER THE CURRENT BUILDS.** This document defines the block so it can be authorized later. Nothing in it has been started, scheduled or approved. No code, migration or configuration changes accompany it. |
| Owner request | "Prepare Build the counter POS interface layer block later after the current builds." |
| Layer owner | Business Operations (BO). The web application is a thin client; sale and order logic stays in the BO layer and the API. |
| Evidence labels | `REPO-VERIFIED` read from the repository on `main`; `NOT VERIFIED` not checked or not decided. |
| Survey | POS-0 survey completed in `BLOCK-POS-0-SURVEY-AND-DECISIONS.md`; it corrects §3 item 6 and adds findings F1–F12 (notably the USD currency default and the missing tender capture). |
| Queue position | After the production release programme for migrations 0199–0201 (backup, restore rehearsal, release window and post-release checks) and after the open H-5 / backup-recovery work. It must not compete with the release for the single production VM, the owner's attention or the migration number sequence. |

## 1. Objective
Give a business a **counter screen** on a tablet or desktop where staff take a customer's order, add products to it, apply allowed adjustments, complete or void it, and have every completed sale recorded as a sales record in the INFINICUS database — the "customers come to the business, staff key in the order, the system keeps the sales record" workflow shown in the owner's photograph of a counter POS (product tiles, an order panel, Print / Kitchen / Void / Discount / Notes / Tags buttons, and Home / Orders / Tables / New navigation).

## 2. What already exists (REPO-VERIFIED, `main`)
| Area | Evidence | State |
|---|---|---|
| Products API | `apps/api/src/routes/products.ts`: `POST/GET /v1/businesses/:businessId/products`, `PATCH .../products/:productId`. Fields: name, price, category, icon, active, sortOrder. | Exists |
| Orders API | `apps/api/src/routes/orders.ts`: create, list, get, add line item, remove line item, `complete`, `void`. Line item types: product, service, fee, discount, other. | Exists |
| Order completion | `OrderRepository.complete` sets status `completed`, writes an `order_events` row and a `business_events` row of type `sale` (amount, quantity, customer, order number) in one tenant transaction. `void` sets status `failed` and records the reason. Only `planned` orders can be completed or voided; an order needs at least one line item. | Exists |
| Register sessions | `apps/api/src/routes/registerSessions.ts`: open, get open, close, list. Fields: register name, opening cash, closing cash, expected cash, variance, notes. | Exists |
| Tenant isolation | Repositories use `withTenantTransaction`; row-level security is enabled on the BO tables. | Exists |
| Web app | `apps/web` has sign-in, workspaces, businesses and a 50-line console page that only checks the session. **No order, product or register screens.** | Missing |
| Legacy prototype | Root `bol.html` ("BOL · Business Operations Layer") has register, cart, discount and tender screens. It stores data in the browser (IndexedDB / localStorage) and never calls the API. | UX reference only; not a source of truth |

## 3. Known gaps the block must resolve or explicitly defer (REPO-VERIFIED unless marked)
1. **No payment or tender capture.** `complete` records the sale but not how it was paid (cash, card, other), the amount tendered or the change given.
2. **No order-to-register-session link** and no cash reconciliation from sales; `expectedCash` and `variance` need a defined source (NOT VERIFIED: how the close endpoint computes `expectedCash` today).
3. **Tax and currency.** Quotation and order tables carry tax fields; the order API does not expose tax. Business currency declarations exist (migration 0185). How a counter sale states tax and currency is a decision, not an assumption.
4. **Discount and void rules.** `discount` is a line item type and `void` takes a reason, but there is no per-role limit, approval or audit rule (NOT VERIFIED: what the authorization package would allow a cashier to do).
5. **Kitchen tickets, tables, printing, tags, notes.** None exists in the API (the order has no notes or tags field). These are separate sub-blocks or explicit non-goals.
6. **Idempotency.** *(Corrected by POS-0, 2026-10-18.)* Every mutating route already requires an `Idempotency-Key` header and replays or conflicts correctly; the POS client must send and reuse a key per action. See `BLOCK-POS-0-SURVEY-AND-DECISIONS.md` §1.
7. **Inventory effect.** A completed sale does not visibly decrement inventory (NOT VERIFIED; inventory writes are governed by migrations 0182–0198 and must not be bypassed).
8. **Offline.** A counter must survive a short network loss. The architecture rules forbid browser storage as a source of truth; it may only hold an offline cache, drafts and UI state.

## 4. Architecture constraints (from the project rules; the block must preserve them)
- Layer boundaries: UI code lives in `apps/web` and calls the API only. No business rules in the app, no import of another layer's internals.
- Tenant isolation in every persistent query; no secrets in the repository.
- Browser storage (IndexedDB / localStorage) only for offline cache, temporary drafts and UI state, never as the production source of truth (the legacy `bol.html` violates this and must not be copied as a pattern).
- Operational state vocabulary stays `planned / authorized / executed / completed / failed / reversed`; "completed" requires execution evidence (here: the sale event).
- Migrations are forward-only, numbered after the then-current head (0201 at the time of writing; the release programme owns 0199–0201), and each needs its own authorization. This document assigns **no** migration number.
- Web hosting, Cloudflare/DNS and identity configuration are separate decisions (Criterion J and the NEW-ARCH-R0 decision remain the authority); this block does not change them.

## 5. Proposed sequence (independent, small, individually authorized blocks)
Each sub-block ends with a completion report and stops. None starts without the owner's explicit authorization.

| Sub-block | Content | Main output | Needs |
|---|---|---|---|
| POS-0 Survey and decisions | Read-only: confirm the gaps in §3 against the code (close endpoint, authorization roles, inventory side effects), write the decisions in §7, and produce screen wireframes from the owner's photo. | A decision record and wireframes (docs only) | Owner answers to §7 |
| POS-1 Shell and catalogue | Counter route in `apps/web`: signed-in business context, product tiles from the products API (search, category, active only), responsive tablet layout, loading and error states. Read-only against the API. | Counter page, product grid, component tests | POS-0 |
| POS-2 Order building | Create an order, add and remove line items, running total from the server, quantity edits, "New" and "Orders" views. The server remains the source of the total. | Working order panel against the existing API, tests | POS-1 |
| POS-3 Complete and void | Complete and void with reason, confirmation prompts, double-tap protection, error handling for the conflict cases; show the recorded sale. | Sale recording from the UI, tests incl. conflict paths | POS-2 |
| POS-4 Register session | Open and close the register, link orders to the open session, show expected cash and variance (needs the §3 item 2 decision, possibly a migration). | Session-aware counter | POS-0 decision, migration authorization if any |
| POS-5 Payment capture | Record tender type, amount tendered and change; refuse completion without a tender when the business requires it (needs §3 item 1 decision; migration likely). | Payment-aware completion | POS-0 decision, migration authorization |
| POS-6 Discounts, notes, receipts | Role-limited discount and void rules, order notes and tags, receipt view or print. Kitchen tickets and table management only if the owner includes them. | Controls and print output | POS-0 decisions |
| POS-7 Offline-tolerant behavior | Draft order cache and retry with idempotency keys (needs API idempotency, §3 item 6). | Resilient counter | POS-3, idempotency decision |

## 6. Verification expected for every sub-block
Typecheck, lint, unit and component tests, API integration tests against a disposable PostgreSQL 16 with synthetic data, a check that tenant isolation holds (a user of business A cannot read or write business B orders), accessibility basics (keyboard and screen-reader labels, touch target size), and a mobile or tablet viewport check. Any migration needs the fingerprint reference regenerated and the migration gate run on a disposable database first. CI must be reported as returned by GitHub, never assumed.

## 7. Decisions needed from the owner before POS-1
1. Which businesses and device types come first (tablet counter, phone, desktop)?
2. In scope for the first version: tables, kitchen tickets, printing, tags and notes? (Recommendation: **out** of the first version; add after POS-3.)
3. Payment: must every sale record a tender? Which tender types? (Recommendation: cash, card (record only, no card processing), other.)
4. Tax and currency: tax-inclusive or exclusive prices, and one tax rate per business or per product?
5. Who may discount or void, and is manager approval required above a limit?
6. Is offline tolerance required for the first version? (Recommendation: **no**; accept a clear "offline" banner and block completion until the network returns.)
7. Where is the counter hosted (it depends on the web-hosting decision and Gates A–D, which remain open)?
8. Does a completed sale need to adjust inventory in the first version?

## 8. Risks
- Starting before the release programme finishes would divide attention and could collide with the migration sequence and the single-VM capacity limit.
- Money handling: rounding, tax and refunds are easy to get subtly wrong; every amount calculation must be server-side with tests.
- Copying the legacy prototype's browser-storage pattern would break the source-of-truth rule.
- Each gap in §3 may require a migration, which is a production change needing its own release window.
- Hardware (receipt and kitchen printers, cash drawer) is not designed here and would add device-specific work.

## 9. Not done
This preparation did not start any POS sub-block, change code, migrations or configuration, access production, or touch the release programme. It is a queue entry only.
