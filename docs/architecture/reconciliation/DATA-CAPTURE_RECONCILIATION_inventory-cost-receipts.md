# Data-capture reconciliation — purchase receipts, unit cost, currency, linkage, configured-versus-unset reorder values

Status: **read-only architecture reconciliation. No code, no migration, no implementation.** Authorized by the owner after the inventory
policy data profile (dataset option C). It is deliberately separate from Block B2b and must not be implemented inside it. Reviewed at
main `124def5`. Confidence in the structural findings is about 90% (schema and repository-wide code search); DAL internals were read
at the contract and intake level, not line by line.

## 1. Ownership that must be preserved

| Concern | Owner | Rule |
|---|---|---|
| Ingestion, validation, publication of external records | Data Acquisition Layer (DAL) | DAL publishes; it never writes BO tables |
| Operational truth (movements, balances, purchase orders, receipts, reorder settings) | Business Operations (BO) | BO maps published records to commands and executes them; one source of truth per fact |
| Authorizing a change to reorder settings | ABA | ABA authorizes; BO executes (P0-6, not started) |
| Governance evaluation of a proposed change | BO evaluator (B2) | reads BO truth; never ABA |

The existing path is: DAL publication package → `BusinessIntakeService` → `IntakeMapperRegistry` mapper (per `recordType`) →
`OperationalCommand` → `OperationalCommandExecutor` (one tenant transaction, idempotent by the DAL idempotency key). Every
improvement below keeps that path; none adds a second writer or a copy of truth.

## 2. Findings (what exists today)

1. **Purchase receipts have no write path.** The table `business_operations.purchase_receipts` exists (header only: purchase order,
   receipt number, `received_at`, optional warehouse, a free-form `payload`). No record type, mapper, command or executor branch creates one.
   The movement `referenceType` `purchase_receipt` is accepted but points at nothing.
2. **No purchase-receipt lines.** There is no table linking a receipt to quantities per item.
3. **Unit cost is optional and uncontrolled.** `inventory_movements.unit_cost` is written only from the optional `unitCost` field of the
   `inventory_movement` record. The mapper accepts any finite number, including zero and negative values. It is not required, even for
   `receipt` movements.
4. **No currency on cost.** `unit_cost` has no currency column or companion field in the table, the record or the command.
5. **Silent USD default at execution.** `create_purchase_order` stores `currencyCode ?? 'USD'`; the business and tenant defaults are
   also `'USD'`. A default is indistinguishable from a deliberate choice.
6. **Purchase orders are header-only.** Only the header command exists. `purchase_order_line_items` links to `platform.products`, not to
   inventory items, and has no write path in the runtime.
7. **Item linkage is optional and indirect.** Inventory item to product is `inventory_items.product_id`, nullable. Supplier agreements
   reference a supplier only.
8. **Reorder settings are always zero for system-created balances.** The first movement for an (item, warehouse) creates the balance
   with `reorder_point = 0` and `reorder_quantity = 0`. No production code path sets them. The API exposes them read-only. The only
   place a non-zero value can come from today is a direct repository insert (tests) — or, in future, the authorized P0-6 execution.
9. **Zero is ambiguous.** A zero from the default and a deliberate zero are indistinguishable; `listBelowReorder` treats `reorder_point > 0` as "configured".
10. **Capacity** (`capacity_units`) is out of scope here by ruling (no unit semantics; not used by v1).

## 3. Design proposals (each its own authorized implementation block; none started)

### A. Purchase receipt write path
- New DAL record type `purchase_receipt` and BO command `record_purchase_receipt`, mapped by a new versioned mapper and executed by the
  existing executor, idempotent by the intake idempotency key.
- A receipt names its purchase order, warehouse, receipt number (unique per business, existing constraint) and one or more **lines**
  (new BO table `purchase_receipt_lines`: receipt, purchase-order line, inventory item, quantity, unit cost, cost currency).
- Executing a receipt also creates the corresponding `receipt` inventory movement(s) in the same transaction, with
  `reference_type = 'purchase_receipt'` and `reference_id = receipt id`, so the movement ledger remains the one source for stock and cost.
  The receipt does not duplicate balances.

### B. Unit cost where a receipt carries cost
- A `receipt` movement that carries a cost must have `unit_cost > 0`. Zero or negative costs are rejected at the mapper and by a
  database CHECK on new rows.
- **Open decision (Q-D1):** must every `receipt` movement carry a cost, or may cost stay optional? Recommendation: optional but, when
  present, strictly valid and currency-tagged. Making cost mandatory would reject legitimate ledger receipts (for example donated or
  transferred stock) and push users toward invented values.

### C. Explicit currency on cost-bearing data
- Add `unit_cost_currency` (ISO 4217, text) to `inventory_movements` and to the receipt-line table, with the rule: cost present ⇔
  currency present, enforced by a CHECK on **new rows only** (`NOT VALID`), and **no backfill**. Existing rows keep a NULL currency and
  remain unprovable, which the rule set already treats as INDETERMINATE.
- The mapper requires `unitCostCurrency` whenever `unitCost` is given. The silent `USD` default in `create_purchase_order` is removed:
  currency becomes required (a behaviour change that needs owner approval — Q-D2).

### D. Reliable purchase-order / receipt / inventory-item linkage
- Add a nullable `inventory_item_id` (FK to `platform.inventory_items`) to `purchase_order_line_items`, validated to the same tenant,
  workspace and business. The product link stays; the item link is the canonical path for cost, lead time and open-order value.
- Receipt lines reference the purchase-order line, giving an unbroken chain: purchase order → line → receipt line → receipt movement → item.
- Supplier-to-item linkage (agreement or preferred supplier per item) is **not** proposed here; it needs its own ruling (Q-D3).

### E. Configured versus unset reorder values
- Add `reorder_policy_state` to `inventory_balances` with values `UNSET` (default) and `CONFIGURED`, plus the time and source of the
  last configuration. System-created balances stay `UNSET`; `reorder_point > 0` is no longer the only signal.
- Only a BO-owned command can set `CONFIGURED` (a new `configure_inventory_reorder_policy` command executed by BO). The future
  authorized P0-6 execution would use that same command; ABA never writes the column.
- **No backfill without a ruling.** Existing non-zero values would be `UNSET` until the owner decides whether to mark them configured (Q-D4).
- Consequence for the rule set: C4 can distinguish "unset" from "deliberate zero", and Q-F1 (first-configuration option) can be decided on facts.

## 4. How this connects to the rule set v1.0.0

| Rule | Blocker today | Cleared by |
|---|---|---|
| K1 unit cost | cost optional, never required | B (valid cost when present) + A (receipts exist) |
| K2 currency provable | no currency on cost | C |
| E1 demand history | needs real `issue` movements (a data-volume question, not a schema gap) | real operations |
| C4 baseline | every system-created balance is 0/0 | E |
| lead time | declared by ruling; no schema gap | not needed |

## 5. Migrations and sequencing (anticipated, not allocated)

New migrations are expected (receipt lines, currency columns, item link, policy state). They must follow the allocation policy at the
time (discover the next free number, record hashes, no edit of earlier migrations) and add RLS, append-only guards where the data is
a fact (receipt lines), and tests. Suggested order, each separately authorized: **C → B → A → D → E**, because currency and cost
validity are prerequisites of receipts, and the linkage and policy-state work are independent of them. None may start before the owner
rules on Q-D1..Q-D4 and authorizes the specific block.

## 6. Risks and stop conditions
- Changing the mapper contract changes what DAL may publish: a DAL record-type/version change and an agreement with the DAL owner is required.
- Removing the `USD` default is a breaking behaviour change for any current publisher.
- Existing data cannot be corrected without inventing facts; the proposals use `NOT VALID` constraints and no backfill.
- Stop and report if: a proposal needs DAL to write BO tables; a second source of truth for stock or cost appears; a locked-spec conflict appears; a live data migration would be needed.

## 7. Owner decisions requested
| # | Question | Recommendation |
|---|---|---|
| Q-D1 | Must every receipt movement carry a cost? | No; when present it must be valid and currency-tagged |
| Q-D2 | Remove the silent `USD` default on purchase orders and require currency? | Yes |
| Q-D3 | Is supplier-to-item linkage in scope? | Not in this program; a separate ruling |
| Q-D4 | Backfill `CONFIGURED` for existing non-zero reorder values? | No backfill; mark explicitly through the BO command |
| Q-D5 | Authorize implementation order C → B → A → D → E, one block at a time? | Yes, each separately |
