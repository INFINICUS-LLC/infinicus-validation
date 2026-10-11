# Data-capture Block C — explicit currency on cost-bearing inventory data (migration 0183)

Status: DRAFT PR. Implements Block C of `DATA-CAPTURE_RECONCILIATION_inventory-cost-receipts.md` only. Blocks B, A, D, E, the B2b evaluator,
ABA→BO transport and P0-6 are NOT started. Rule set v1.0.0 is not approved by this block.

## 1. Purpose
`inventory_movements.unit_cost` had no currency, so a cost could not be compared with a declared currency or a currency-denominated cap.
Block C makes the currency of a cost explicit and authoritative, with no default and no backfill.

## 2. Survey findings (read-only, before any change)
- `unit_cost` has exactly one writer: `OperationalCommandExecutor.recordInventoryMovement` (the only `INSERT INTO inventory_movements` in
  production code). No other authoritative cost writer exists.
- Path: DAL publication → `BusinessIntakeService` → `IntakeMapperRegistry` mapper → `record_inventory_movement` command → executor.
  The DAL writes no BO table.
- The mapper accepted `unitCost` as any finite number with no currency; the command and executor carried no currency.
- Purchase-order currency defaulted to `'USD'` in **three** places: the executor (`?? 'USD'`), `PurchaseOrderRepository.create`
  (`?? 'USD'`) and the column default `DEFAULT 'USD'` on `purchase_orders.currency_code`. No API route creates purchase orders.
- `inventory_movements` has **no database trigger**: its "append-only" nature is a convention, not a database guard. RLS is enabled
  (not forced) with a tenant + workspace policy. This block adds no trigger and no UPDATE path.
- The record contract has no per-record version negotiation: a mapper carries an integer `version` (metadata only) and one mapper serves
  a record type.

## 3. Implementation
| Layer | Change |
|---|---|
| Migration 0183 | `inventory_movements.unit_cost_currency` (nullable text, no default); `CHECK (NULL OR ~ '^[A-Z]{3}$')`; presence invariant `CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID`; `purchase_orders.currency_code DROP DEFAULT` (still NOT NULL) |
| DAL/intake mapper | `inventory_movement` v2: `unitCostCurrency` is required whenever `unitCost` is given and refused without a cost; exact `^[A-Z]{3}$`, no trimming or case folding; `purchase_order` v2: `currencyCode` required and exact |
| Command | `unitCostCurrency?: string` (paired with `unitCost`); `currencyCode: string` required on `create_purchase_order` |
| Executor | writes `unit_cost_currency` verbatim; refuses an unpaired or malformed currency (defence in depth for commands built outside the mapper); no `?? 'USD'` on purchase orders |
| PO repository | `currencyCode` required and validated; no default |

Compatibility: the change is breaking only for records that carry a cost without a currency, and for purchase orders without a
currency — both owner-ruled (Q-D1, Q-D2). Records without a cost are unchanged. The mapper `version` is bumped to 2 to record the
contract change; there is no multi-version negotiation mechanism and none was added. No external publisher is known (pre-launch).

## 4. Historical data
No backfill and no assumed currency. Proven on a real database at 0182 holding a cost row and a purchase order, upgraded to 0183 through
the migration runner: the historical receipt keeps cost 9.5 and a NULL currency, the purchase order keeps `USD` exactly as stored, the
presence constraint is `NOT VALID`, a new cost-without-currency insert is refused, and a new cost-with-currency insert succeeds.
Historical rows with a cost and no currency stay currency-unproven by design (rule-set COST ⇒ INDETERMINATE).

## 5. Allocation record (MIGRATION-ALLOCATION-POLICY)
| Item | Value |
|---|---|
| Predecessor final migration | `0182_create_bo_inventory_policy_evaluations.sql` |
| New range | `0183` (single migration) |
| main at allocation | `124def53d46d7121b8892fcc8db84d2cf3970575` |
| Open PRs at allocation | #76, #77 (both docs only) |
| Branches carrying a 0183+ migration | none (all remote heads scanned) |
| SHA-256 frozen 0001-0182 (concatenated in name order) | `9e3893f5ca3885542b3472feef6a673d6f5e5f66cb4fac586aea199e0eab575a` |
| SHA-256 frozen 0001-0181 (unchanged) | `f612bed7e8af0aa52fdd4835ebd6130f922bc7edc2decbca1e114b49b17c891a` |
| SHA-256 of `0183_add_explicit_currency_to_inventory_costs.sql` | `ea792e6ff393386f82d33daa62d6d0933021cf073dd1fc8604af091710676b21` |
| Empty-install result | clean install 0001→0183 passes the migration gate on a fresh PostgreSQL 16 database |
| Rerun result | the runner skips 0183; applying the SQL twice directly is idempotent (same two constraints, one registration) |
| Live Supabase | not applied (live 0169; 0170-0183 unapplied) |

## 6. Caveats and risks
- **The movement ledger is append-only by convention only.** Because there is no trigger, an administrator could still UPDATE an old
  row to give it a currency. This block creates no such path and does not add a guard (out of scope); a small follow-up to guard the table is recommended.
- A NOT VALID constraint is still enforced on UPDATE: an old row (cost, NULL currency) cannot be updated in any column until it is
  corrected, which is consistent with append-only behaviour.
- Existing publishers that send a cost without a currency, or a purchase order without a currency, will now be refused with an explicit reason.
- The purchase-order column default was removed in the database as well as in code, so raw SQL that omits the currency now fails.
- Cost validity (`unit_cost > 0`) is Block B and is not enforced here.
