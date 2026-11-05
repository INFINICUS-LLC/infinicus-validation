# POS2-04: architecture reconciliation of the proposed rulings D1 to D8

Planning only. No consumer, migration, deployment or merge. Baseline: `main` at `1058681a`. It extends the decision record in the same directory and corrects one statement in it (section 4, item 6).

## 1. Baseline status

- `main` = `1058681a` (the merge of #429). No branch claims a migration after 0226; the next free number is 0227 (re-check when written).
- **#430 (POS2-03)**: open, draft. Exact-head (`24ff0215`) hosted CI: `validate`, `operations-runtime`, `build-and-smoke-test-image` and Cloudflare Pages all succeeded. Not merged. POS2-04 has no code dependency on it.
- **#431 (this decision record)**: open, draft. One hosted `validate` failure on head `6747896a` in `apps/api/tests/bi-calculations.integration.test.ts` ("is safe under concurrent executions"), a BI-10 test this PR does not touch. The failed job was re-run once. The same area has failed intermittently on `main` before (different tests each time: `bi-metrics.hardening` on `59ae8736`, `bo-bi-inventory-pathway` on `f59a0e7e`).

## 2. What the locked specifications say (read in full for the relevant sections)

- **BO v1.1 section 3**: the native INFINICUS POS is a first-class operational interface *of Business Operations*; its flow is `POS -> Transaction Engine -> Event Engine -> Business Operations`, and the listed POS activities include "Inventory deductions". **Section 13** lists "Inventory deduction" as part of the deterministic POS core. **Section 2/39**: BO is the source of operational truth. **Section 6**: the Transaction Engine must provide idempotency, duplicate prevention and auditability. **Section 7**: every meaningful operational change generates a structured event (`SALE_COMPLETED`, `PRODUCT_SOLD`, `INVENTORY_DECREASED` ...); events are never silently mutated. **Section 10**: the Operational Exception Engine is mandatory and names stockouts and shrinkage. **Section 15**: component inventory (one sale can reduce several items; recipes, yield, waste).
- **DAL v1.1 sections 2, 3, 12, 28, 29**: DAL understands, validates, standardizes, versions and routes business data from *sources* (spreadsheets, POS systems, APIs, databases, manual input) to downstream contracts; it makes no business decision and is not an operational source of truth.

## 3. Reading of the DAL-to-BO boundary

The native POS is not a DAL source; it is a BO interface. A sale completed in the native POS therefore reaches BO's own Transaction and Event engines directly, and its inventory deduction is a BO-internal flow. DAL remains the intake path for *externally* sourced data (the existing `operations/intake` route for a DAL-published package). I found no clause in either locked specification, and no guard, that requires a BO-internal deduction to pass through DAL. The proposal's guardrail ("DAL ... must not be bypassed by ad-hoc downstream integrations") is about downstream integrations, not about BO's own POS, but its wording is broad enough to be read otherwise.

**Status: RESOLVED BY READING, NOT YET RATIFIED.** Specs are frozen, so the resolution must be a recorded decision (the repository's decision ledger), confirmed by the owner and Core, before any consumer is built. This is conflict X1 below.

## 4. Compatibility of the proposed rulings

| # | Proposed ruling | Verdict | Conditions found in the code |
|---|---|---|---|
| 1 | Dedicated business-scoped product-to-stock mapping | COMPATIBLE, with conditions | Allow several rows per catalogue product (BO section 15: one product, several components) and key on (catalogue product, inventory item), not on the product alone. `platform.inventory_items` has no composite scope key, so same-business integrity of product, item and warehouse needs database triggers (the 0198 precedent), not only foreign keys. New BO tables are read-only to the application role by default (`grant-app-role.sh`), so writing a mapping needs a governed function or an explicit protected-table grant, plus a `bo:admin` configuration surface and audit. |
| 2 | One designated warehouse per mapping | COMPATIBLE | A movement requires a warehouse of the same business; a retired or inactive warehouse or item at processing time needs a defined outcome (exception). |
| 3 | Durable, idempotent post-completion consumer | COMPATIBLE in principle; **trigger not decided** | See section 5. |
| 4 | BO retains canonical stock authority | COMPATIBLE and *enforced* | `ac2-bo-canonical-writer.architecture.test.ts` pins `INSERT INTO business_operations.inventory_movements` to `OperationalCommandExecutor.ts` alone. The consumer must call that one writer (a new BO command or exported entry), never write the ledger itself. This is a Core-owned file, hence joint ownership (ruling 9). |
| 5 | Insufficient stock gives an auditable exception, not a payment reversal | COMPATIBLE with BO sections 6 and 10; **conflicts with today's writer** | The writer throws if on-hand would go negative. The consumer must detect shortage first and record an exception outcome on the effect record instead of letting the writer throw. No exception store or resolution workflow exists. Whether a short line deducts nothing (and waits for resolution) or allows negative stock is still a decision. |
| 6 | Exact decimal balance arithmetic | **CONFLICT, bounded** | The writer computes `Number(on_hand) + delta` in JavaScript. Correction to the decision record: because the column is `numeric(18,4)` and the supported range is under 1e9, the float error is far below the stored precision, so stored balances come out right in practice. It still violates the "no floating point in ledger operations" rule by construction and makes the negative check depend on float comparison. Doing the arithmetic in SQL `numeric` is a small behaviour-preserving change to the Core-owned executor. |
| 7 | Unit factor limited to 1 | COMPATIBLE | Store the factor with `CHECK (factor = 1)` so widening is a deliberate migration. Record the item's unit of measure at mapping time, because the sale line carries no unit and "same unit" is otherwise an unverifiable assumption. |
| 8 | Unique effect identity per order line | COMPATIBLE, **widen the key** | With BO section 15 (several components per line) the identity should be (order line, mapping), not the order line alone, to avoid a later breaking change. Snapshot quantity, factor, item and warehouse on the effect row so later edits to the mapping or the line cannot rewrite history. |
| 9 | Joint POS and BO/Core ownership | REQUIRED | The writer and its guard, the event catalogue and the executor are Core/BO-owned; the mapping, effect record and consumer are POS-adjacent. Neither side should change the other's files unilaterally. |

## 5. The trigger for the consumer (a decision, with a recommendation)

Facts: completion writes the append-only `order_events` row `completed` and the `business_events` row `sale`, and nothing else. The event `bo.order.completed` is catalogued (consumers listed: BI, DT, OM) and a SQL emitter `emit_order_completed` exists (migration 0036), but **`OrderRepository.complete` does not call it**, so no outbox event is produced today. The event worker and contract registry exist, with per-consumer deduplication `(event_id, consumer_name)` and a governed activation gate that is closed by default.

| Option | What it takes | For | Against |
|---|---|---|---|
| T1 transactional outbox event | Call the emitter inside the completion transaction, register a contract, add an inventory consumer to the catalogue and the worker | Matches the event-backbone convention | Changes the payment path (even if invisible) and edits a catalogue document |
| T2 pull from the append-only `completed` order events | A processor selects completed orders that lack an effect record, per business, idempotently | No change to the completion transaction; it is also the recovery path T1 would need; handles delayed, out-of-order and retried delivery by construction | Latency; needs its own scheduling |
| T3 DAL-published package | A DAL contract for POS sales | Strictly follows the DAL path | Treats a BO-internal event as external data; the DAL contract does not exist |

Recommendation: **T2 first**, behind a per-business activation gate that is closed until enabled; T1 can be added later as a trigger for the same idempotent processor without changing it.

## 6. Conflicting contracts and gaps

| ID | Conflict or gap | Resolution needed |
|---|---|---|
| X1 | DAL boundary wording (proposal guardrail) versus BO section 3 (native POS is a BO interface) | Ratify the reading in section 3 in the decision ledger |
| X2 | Single-writer guard pins the ledger insert to one Core file | New BO command in that file; the guard and its file list updated by Core |
| X3 | Writer refuses negative on-hand; the ruling wants an exception outcome; no exception store exists | Define shortage semantics and the minimum exception record |
| X4 | Float arithmetic in the writer | SQL `numeric` arithmetic, Core-owned |
| X5 | `bo.order.completed` catalogued and emittable but not wired; catalogue lists no inventory consumer | Only if T1 is chosen |
| X6 | New BO tables are app-role read-only by default | Governed functions and an explicit grant-script entry |
| X7 | `inventory_items` has no composite scope key | Triggers (0198 precedent) or a Core migration adding a unique key |
| X8 | Authorization: mapping edits must be `bo:admin`; a POS operator (`bo:write`) must not gain ledger writes; the process runs as a governed function, not a route | Permission and audit design |
| X9 | POS2-03 readiness reports `INVENTORY_CONFIGURATION` as not applicable | Keep advisory; wire later as a separate step, never coupled to the consumer |
| X10 | Event naming: the spec lists `INVENTORY_DECREASED` and `PRODUCT_SOLD`; the implementation emits `bo.inventory.movement_recorded` | Decide which name the sale effect publishes |

## 7. Minimum safe implementation sequence

Each step is its own block, independently verifiable, and none touches the payment path before the last optional one.

1. **S0 Record the decisions** (docs only): X1 ratification, T1 versus T2, shortage semantics, activation shape, mapping administration, event name.
2. **S1 Exact arithmetic in the BO executor** (Core-owned, behaviour-preserving): SQL `numeric` balance math, with fractional and boundary tests. Independent of POS.
3. **S2 Mapping** (migration 0227 or later, re-checked): table with `CHECK (factor = 1)`, same-business triggers, forced RLS, governed administration under `bo:admin` with audit. Nothing consumes it.
4. **S3 Effect record** (migration): unique (order line, mapping), states pending / applied / exception, snapshots, no direct write by the application role. No producer yet.
5. **S4 BO command for the sale effect** in the single writer: type `issue`, reference `order_line`, shortage becomes an exception outcome, idempotent on the effect identity. Still unwired.
6. **S5 The consumer** (T2) behind a closed per-business gate: duplicate, concurrent, rollback, retry, out-of-order, cross-scope and shortage tests, mutation proofs, fresh-checkout verification.
7. **S6 Optional**: T1 outbox wiring for the same processor (separate approval, touches completion).
8. **S7 Later**: readiness wiring (advisory) and POS2-05 reversal using the provenance kept on the effect record.

## 8. Unresolved after these rulings

DAL ratification (X1); trigger (T1/T2); shortage semantics and the exception record; activation gate shape; mapping administration surface; outcome when the mapped item or warehouse is retired; whether lines of a completed order can change (the effect record snapshots them so it does not matter, but the guarantee should be stated); the sale-effect event name.

## 9. State

Planning only. Nothing implemented, migrated or merged.
