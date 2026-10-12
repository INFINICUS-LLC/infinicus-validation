# Data-capture Block D - purchase-order line / receipt / inventory-item linkage (migration 0198)

Status: DRAFT PR. Not applied to any live database (the live head is unverified). Implements section 3.D of
`DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md` (the authoritative specification). Supplier-to-item linkage (Q-D3) is NOT part of this block.

## 1. Specification mapping

| Specification 3.D | State before | Implemented |
|---|---|---|
| Nullable `inventory_item_id` (FK `platform.inventory_items`) on `purchase_order_line_items`, same tenant, workspace and business; product link stays | lines link to `platform.products` only | 0198 adds the nullable column, FK `ON DELETE RESTRICT`, a partial index, and a write guard that re-checks tenant, workspace and business in the database |
| The item link is the canonical path for cost, lead time, open-order value | n/a | the column exists and is guarded; no reader changed (see section 4) |
| Receipt lines reference the PO line: purchase order -> line -> receipt line -> receipt movement -> item | Block A: nullable PO-line reference, validated to the receipt's PO | the receipt-line guard (0197 function replaced by `CREATE OR REPLACE` in 0198) now also requires the receipt line's item to equal the PO line's item when the PO line carries one |
| Supplier-to-item linkage | not proposed | not added (Q-D3) |

## 2. Rules

- **Nullable, never inferred.** Existing and new lines stay NULL unless an item is written explicitly. `product_id` is never used to derive an item; the two links are independent and coexist.
- **Scope in the database.** A line's purchase order and (when set) inventory item must be in the line's own tenant, workspace and business. The guard fires on insert and on update of the scope, purchase-order or item columns; other updates (price, `received_qty` maintenance) are unaffected. Rows that are not written again are not re-judged: forward enforcement only, no repair, no `NOT VALID` constraint is needed because no table-level constraint was added over old data.
- **Chain rule.** Receipt line item = PO line item whenever the PO line is linked. A PO line with no link is accepted exactly as in Block A; the receipt never writes an item back into the PO line.
- **Chain stability.** While any receipt line references a PO line, that line's item cannot be cleared or changed (receipt lines are append-only facts). An unlinked line may be linked to the item that was already received, never to another one.
- **RESTRICT.** Deleting an inventory item that a PO line links to is refused (a `SET NULL` would silently erase a link receipts may rely on).
- **Executor.** The receipt branch of the one BO writer reads the PO line's item and refuses an inconsistent receipt line early, naming the problem; the database guard is the authority and refuses the same input if the executor is bypassed.

## 3. Deliberately unchanged

- PO status and `received_qty` (no lifecycle is defined in the specification; a receipt writes neither). Deferred.
- Purchase-order lines still have no runtime write path (the specification adds none; creating lines with prices, totals and tax would exceed linkage). The item link is therefore set only by a future governed writer or an operator; the database guard protects either.
- Block A idempotency, append-only guards, RLS; DAL, ABA, OM, P0-6, reorder policy, activation: untouched.

## 4. Readers

Surveyed: `ProcurementService` lists PO headers only; the B2 evaluator's facts repository reads movements, balances and declared rule-set values (lead time is a rule-set parameter, not derived from purchase orders); nothing reads PO lines. No reader was changed and no threshold or rule-set semantics moved.

## 5. Migration allocation

Main head 0197 (cb97c70); no open PR; no remote branch carries 0198. File: `0198_link_purchase_order_lines_to_inventory_items.sql`. No earlier migration edited (0197 SHA-256 unchanged, asserted by a test). No GRANT, no data statement, no backfill.

## 6. Tests

`PurchaseOrderLineItemLinkage.integration.test.ts` (21, real PostgreSQL, application role): migration, scope (tenant / workspace / business, forged inconsistent item rows, PO scope), product coexistence, no inference, chain, DB-level chain refusal with the executor bypassed, chain stability, Block A replay / conflict / append-only regression, no status or `received_qty` change. `dataCaptureBlockD.architecture.test.ts` (8): single migration, no backfill / data / destructive / grant / product / supplier / status text in the migration, no second writer, no inference, no DAL / ABA / OM / P0-6 involvement, no supplier-item structure.

## 7. Caveats and owner-visible items

- PO status and `received_qty` remain ungoverned by receipts (deferred until a lifecycle is specified).
- No governed writer sets `inventory_item_id` yet (no PO-line write path exists); a separate block would add it if the owner wants it.
- Existing lines are not re-validated; an existing inconsistent line is only caught when it is written again.
