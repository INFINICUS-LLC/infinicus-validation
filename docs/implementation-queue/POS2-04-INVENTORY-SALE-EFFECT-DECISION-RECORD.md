# POS2-04: inventory sale effect, decision record and acceptance specification

Workstream: INFINICUS POS 2.0 (POS-only). Baseline: `main` at `1058681a`. Verdict: **BLOCKED, OWNER ARCHITECTURE DECISION REQUIRED**. No inventory behaviour is implemented, because two of the four preconditions in the authorizing prompt (product eligibility and quantity semantics) cannot be established from approved contracts, and a third (the write path) is a DAL/BO locked-contract question. This document records what is established, what is not, the options, and the acceptance matrix as a specification. The only code added is a characterization test that pins today's behaviour (no stock moves when a sale completes).

POS2-03 (#430) was open and its hosted CI was still running when this was written. POS2-04 has no code dependency on it (readiness is read-only and nothing consults it), so this work starts from `main`; no POS2-03 change is copied here.

## 1. What is established (from code on `main`)

| Question | Finding | Status |
|---|---|---|
| A. Sale-completion authority | `OrderRepository.complete`: in ONE transaction the order goes `planned` to `completed` (status row locked, payment required, open register session required), an `order_events` row `completed` (append-only, 0219) and a `business_events` row `sale` (total quantity, discounts excluded) are written. The `completed` order event is the existing approved transition. Creation and payment alone are not completion. | RESOLVED |
| B. Stock ownership and movement authority | Business Operations owns it: append-only ledger `business_operations.inventory_movements` (0184; forced RLS, 0186), balances `inventory_balances`, items `platform.inventory_items`, warehouses `platform.warehouses`. There is exactly one writer of a movement and its balance effect, `OperationalCommandExecutor.applyInventoryMovement` (locks the balance `FOR UPDATE`, appends the movement, updates the balance, emits the movement event). The schema already allows `movement_type = 'issue'` and `reference_type = 'order_line'` with a `reference_id` uuid. A correction is a new compensating movement (0184). | RESOLVED, with caveats below |
| Who can write movements today | Only the DAL-published intake path (`POST .../operations/intake/:publicationPackageId`, `bo:write`) reaches that writer. No POS route or repository creates a movement. | Established |
| C. Product eligibility | **No association exists.** POS catalogue lines carry `product_id = NULL` (the BO catalogue `business_operations.products` and `platform.products` have distinct identities; the catalogue id survives only in an `order_events` note). The BO catalogue has no inventory, SKU, warehouse or item column. `platform.inventory_items.product_id` points at `platform.products`, which the POS does not use. A free-text line may carry a `productId`, but only as an unvalidated FK. | **UNRESOLVED** |
| D. Quantity and units | Order-line quantity and ledger quantity are both `numeric(18,4)`. `inventory_items.unit_of_measure` exists, order lines have no unit, and no conversion rule exists. The BO writer computes the new balance in JavaScript `Number` (`Number(on_hand) + delta`), so it is not exact for fractional quantities, unlike money. | **UNRESOLVED** |
| Idempotency | The ledger has **no uniqueness** on `(reference_type, reference_id)` and the plain movement path has no replay identity (purchase receipts have their own receipt-number identity). Demonstrated by the tripwire test: the same order-line reference can be inserted twice. At-most-once for sale effects has no existing mechanism. | Gap |
| Availability policy | The writer refuses a movement that would make on-hand negative. Nothing defines reservations, backorders, partial fulfilment, a negative-stock allowance, or which warehouse a sale draws from (a movement requires a `warehouse_id`). Payment has already been taken when a sale completes. | **UNRESOLVED** |

## 2. Why implementation stops here

Inventing a mapping, a warehouse rule, a unit rule or an insufficient-stock policy would be inventing business rules, and routing a POS-originated movement around DAL intake would bypass the DAL/BO locked contracts (the proposal's own guardrail: DAL must not be bypassed by ad-hoc downstream integrations). Building a planner without a mapping source would be dead speculative code. The prompt requires stopping at the decision gate in exactly this case.

## 3. Decisions required, with options and recommendation

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Product-to-stock association | (a) nullable item column on the BO catalogue; (b) a mapping table catalogue product -> inventory item with a quantity-per-sale-unit factor; (c) populate `platform.products` and use `inventory_items.product_id` | (b): explicit, tenant/business scoped with composite keys, supports a later multi-item (recipe) mapping, leaves free-text lines untouched. Needs a migration (next free is 0227; re-check). |
| D2 | Warehouse | one default stocking warehouse per business on the mapping; allocation across locations later | Default warehouse on the mapping; no allocation logic yet |
| D3 | Write path | (a) call the BO writer inside the completion transaction; (b) an idempotent consumer that reads the `completed` order event and writes a durable sale-effect record; (c) through a DAL-published package and BO intake | (b), because it can never roll back or block a completed, paid sale, and it gives a recoverable boundary. (c) needs a DAL publication contract for POS sales; (a) couples payment success to stock. Owner and Core must rule on DAL/BO involvement. |
| D4 | Insufficient stock | block the sale; allow negative on-hand; record the effect as an exception to be resolved; partial | Never block a completed sale; record an explicit exception (`INSUFFICIENT_STOCK`) with no silent clamp. Allowing negative on-hand changes the BO writer rule, which is Core-owned. |
| D5 | Exactness | make the BO writer's balance arithmetic exact (database `numeric`) before any fractional or high-volume sale effect | Required before fractional quantities; a change to the Core-owned executor |
| D6 | Units | factor 1 (sale unit equals item unit) until a conversion rule is ruled | Factor 1, with the factor stored explicitly on the mapping |
| D7 | Effect identity | one effect record per order line with `UNIQUE (order_line_id)` holding the resulting movement id, state, quantities and provenance | Yes; additive migration, the same tenant/workspace/business composite pins as the order tables |
| D8 | Ownership | the ledger, writer and executor are Core/BO-owned; who builds the sale effect | Joint design; the POS session should not edit the Core writer unilaterally |

## 4. Proposed contract (specification only, nothing built)

- **Trigger:** the `completed` order event of an order (once). A voided or planned order produces nothing.
- **Eligibility:** only lines with a verified mapping (D1); free-text lines and discount/fee/service lines produce no movement.
- **Identity:** one effect per order line (`UNIQUE order_line_id`); a replay of the same line with the same content is a no-op, a different content is refused (conflict), nothing is applied twice. Concurrent processors serialize on the effect row or an advisory lock keyed by the line.
- **Quantity:** `quantity x factor`, exact decimal, never floating point; refused if not representable.
- **Movement:** type `issue`, `reference_type = 'order_line'`, `reference_id = order line id`, warehouse from the mapping, occurred-at = the completion instant (provenance), correlation id carried from the sale.
- **Provenance kept for POS2-05:** order id, line id, completion event id and time, mapping id and factor, inventory item and warehouse, original quantity, resulting movement id; a reversal reference slot stays empty and unused (no refund or restoration policy is defined here).
- **Scope:** tenant, workspace and business equal on the order, line, mapping, item, warehouse and movement (composite keys plus forced RLS); the sale-effect process runs as a governed internal function, not as a route a POS operator can call with arbitrary parameters.
- **Failure:** a stock failure records an exception on the effect row and never undoes the sale; retries are safe because of the identity above.

## 5. Acceptance matrix (specification)

Legend: **SPEC** = depends on an undecided item (not executable); **EXISTING** = defined by an approved existing contract and covered by existing tests; **PINNED** = characterized by this PR's tripwire test. Each scenario states initial state / trigger / expected movement / balance impact / idempotency outcome / security result / audit evidence.

| # | Scenario | Initial | Trigger | Movement and balance | Idempotency | Security | Audit evidence | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | One tracked product | mapped item, stock 10, one line qty 2 | order completes | one `issue` of 2, on-hand 8 | replay: no second movement | same business only | effect row + movement + event | SPEC (D1,D3) |
| 2 | Several tracked products | two mapped items | completes | one movement per tracked line | per line | as 1 | per-line effect rows | SPEC |
| 3 | Free-text line | no mapping | completes | none | n/a | n/a | no effect row | SPEC (the PINNED test shows today: no movement) |
| 4 | Mixed lines | one tracked, one free-text | completes | movement for the tracked line only | per line | as 1 | effect rows for tracked lines only | SPEC |
| 5 | No completion evidence | order `planned` or voided | processor runs | none, refused | n/a | n/a | refusal recorded | SPEC |
| 6 | Duplicate completion event | effect already applied | event delivered again | none | no-op, same result | n/a | one effect row | SPEC (D7) |
| 7 | Concurrent identical events | two processors | race | exactly one movement | one winner, other no-op | n/a | one effect row | SPEC |
| 8 | Conflicting replay | effect applied, line content changed | replay with different content | none | refused as conflict | n/a | conflict recorded | SPEC |
| 9 | Cross-tenant | mapping/item in another tenant | process | refused | n/a | RLS + composite keys deny | no row crosses | SPEC (RLS on the ledger is EXISTING: 0186) |
| 10 | Cross-workspace | item in another workspace | process | refused | n/a | as 9 | as 9 | SPEC |
| 11 | Cross-business | item in another business of the same workspace | process | refused | n/a | composite pin | as 9 | SPEC |
| 12 | Invalid association | mapping to a retired or foreign item | process | refused, exception recorded | n/a | n/a | exception | SPEC |
| 13 | Fractional quantity | line 0.1 + 0.2 of a litre item | process | exact 0.3, never 0.30000000000000004 | n/a | n/a | exact decimals | SPEC (needs D5; today's writer uses JS numbers) |
| 14 | Maximum quantity | line at the order limit (1,000,000,000) | process | exact or refused if not representable in numeric(18,4) | n/a | n/a | refusal reason | SPEC |
| 15 | Insufficient stock | stock 1, line qty 2 | process | per D4; the existing writer rule alone would refuse (on-hand cannot go negative) | n/a | n/a | exception record | SPEC (D4); the writer rule is EXISTING |
| 16 | Database failure mid-record | injected failure after the movement insert | process | whole effect rolls back, nothing partial | retry safe | n/a | no partial rows | SPEC |
| 17 | Retry after rollback | as 16 | retry | exactly one movement after the retry | converges | n/a | one effect row | SPEC |
| 18 | Direct ledger write | app role / operator | UPDATE, DELETE, TRUNCATE | refused (append-only) | n/a | no tampering | trigger error | EXISTING (0184, covered by the existing append-only tests; note a direct INSERT by the application role is not prevented by privilege, only by the absence of a code path and by RLS scope) |
| 19 | Association changed after completion | mapping edited or removed later | later | the original effect and its provenance are unchanged; no retroactive movement | n/a | n/a | original mapping id and factor retained | SPEC (D7) |
| 20 | Reversal provenance | completed effect | POS2-05 later | n/a here | n/a | n/a | order id, line id, movement id, quantity, completion time, item all retrievable | SPEC (the slots are specified, not built) |

## 6. Evidence in this PR

`apps/api/tests/posSaleInventoryGap.integration.test.ts` (live PostgreSQL + Fastify, 3 tests, characterization of today's behaviour, to be replaced by the real POS2-04 tests once the decisions are made): completing a sale with a catalogue line and a free-text line writes the completion evidence and moves no stock; the catalogue line has no canonical product; the BO catalogue has no inventory link and no sale-effect table exists; the ledger has no uniqueness on an order-line reference (the same reference inserted twice).

## 7. Compatibility and boundaries kept

No change to readiness (POS2-03), entitlement, billing suspension, read permissions, Stripe, order creation, tender or the BO writer. No refund, reversal or restoration policy. No migration in this PR.

## 8. State vocabulary

Implemented: none (decision record plus a characterization test). Locally verified: the three tests on a disposable PostgreSQL 16. Hosted-CI verified, merged, production-ready: not applicable and not claimed.
