# DESIGN — Per-product kitchen routing (design only)

Status: **DESIGN PROPOSAL. Nothing is implemented. No migration, column, table, route or UI exists for this.** Written against `main` at `844f5fc` (2026-10-28). Every choice below that is marked **OWNER DECISION** is open and must be ruled on before any build block starts.

## 1. Problem

Today the whole ticket goes to one default kitchen printer: `buildKitchenTicket(order, …)` (`apps/web/lib/client/kitchenTicket.ts`) takes every non-discount line plus the cashier note, and `counter/page.tsx` prints it to the route returned by `GET /v1/businesses/:businessId/print-routes` (the single active default printer per kind). A business with a grill, a bar and a cold station cannot send each item to the right place (POS-8C, "Out of scope").

## 2. Facts on `main` that constrain the design (verified by reading the code)

1. `business_operations.printers` (0208) already allows several active printers of kind `kitchen`; a partial unique index allows only **one active default per business and kind**. The registry stores no network address (the device shell keeps physical addresses).
2. `business_operations.print_jobs` (0209) is an append-only log with a nullable `printer_id` and kind `kitchen`. It stores no content. It needs no change for routing.
3. The sellable catalog is `business_operations.products` (0161: name, price, `category` text default `'other'`, icon, active, sort_order). It has **no station concept**.
4. A counter order line does **not** carry the catalog product id. `OrderRepository.addLineItem` with `catalogProductId` copies name and price as a snapshot and inserts `order_line_items` with `product_id = NULL` (that FK points at `platform.products`, a different identity). The catalog id survives only in an `order_events` `note` event (`catalog_line_added`, `catalogProductId`). `OfflineSaleRepository` does the same, with `offline: true`.
5. Print routing is best effort. A lookup or log failure never blocks a print; with no routes the browser prints with the cashier's choice.
6. Money, order totals and tender are untouched by routing. Routing only decides **which printer receives which lines**.

Consequence: a per-product key is not reachable from the line row. This is the central design point.

## 3. Options

### 3.1 Where the product-to-station mapping lives

| Option | Description | For | Against |
|---|---|---|---|
| **A. Column on products** | `products.kitchen_station text NULL` | Smallest change; one migration; edited with the product | A "station" is free text unless constrained; renaming a station touches every product |
| **B. Mapping table (recommended)** | `business_operations.kitchen_stations` (id, business_id, name, printer_id, status) and `products.kitchen_station_id uuid NULL` referencing it | A station is a first-class named thing; the printer binding lives on the station, so re-pointing a station to another printer is one row; supports retiring a station | Two objects and one migration; slightly more UI |
| **C. Route by `category`** | Map the existing `category` text to a printer | No schema change to products | `category` is display text with default `'other'`; changing a category label would silently re-route food; couples presentation to operations. **Rejected.** |

**Recommendation: B.** It keeps the registry rule (no address in the database) and avoids route-by-label hazards. A product with `kitchen_station_id IS NULL` goes to the **default kitchen printer**, so every business that configures nothing behaves exactly as today (backward compatible).

### 3.2 How a routing key reaches an order line

| Option | Description | For | Against |
|---|---|---|---|
| **K1. Snapshot station onto the line (recommended)** | At `addLineItem` with `catalogProductId`, also copy the resolved `kitchen_station_id` (and name) into a new nullable column on `order_line_items`, or into the existing line snapshot fields | Same snapshot principle already used for name and price; routing of a past order never changes if the catalog is edited; offline replay stays deterministic | Adds a column on a canonical table (Core-owned order tables): needs coordination |
| **K2. Resolve from the `catalog_line_added` event** | The ticket builder joins lines to `order_events` provenance, then to the catalog | No change to `order_line_items` | Joins through an event payload; reprints after a catalog edit would route differently; events are not a contract for reads. **Not recommended.** |
| **K3. Resolve at print time by product name** | Match the snapshot name against the catalog | None | Names are not unique or stable. **Rejected.** |

**Recommendation: K1**, stored as a nullable, non-FK reference or a FK to `kitchen_stations` (owner/Core to choose, see 6). Lines without a station print to the default kitchen printer.

## 4. Proposed behaviour (if option B + K1 is approved)

- **Counter ticket**: after "Send to kitchen", the web groups non-discount lines by station and prints **one ticket per station**, each to that station's printer. Lines with no station form one group sent to the default kitchen printer. The cashier note appears on every ticket (a note is order-level and each station should see it). Each ticket is headed with the station name.
- **Failure isolation**: each group is its own print attempt and its own `print_jobs` row (kind `kitchen`, `printer_id` set, `trigger_kind` automatic/manual/reprint). One failed station never blocks the others. The cashier sees which station failed and can reprint only that group.
- **Reprint**: a reprint uses the **snapshotted** station on the line, not the current catalog.
- **Retired station or printer**: lines fall back to the default kitchen printer and the ticket says so in its header; a station is never silently dropped.
- **No default printer and no station printer**: unchanged behaviour (browser printing with the cashier's choice).

## 5. API, web and database changes (all conditional on approval)

Migration number: **0222 on `main` at `844f5fc`** (a snapshot; an unmerged branch could hold it). The number **must be re-checked when the build block is written**, and migration numbering must stay gap-free. Nothing is applied to production by this design.

Database (one forward migration):
- `business_operations.kitchen_stations` with `business_id`, tenant columns following the BO table conventions, RLS enabled and forced, grants matching `printers`.
- `products.kitchen_station_id` nullable.
- `order_line_items.kitchen_station_id` nullable (K1). **This touches a canonical table and needs a Core Architecture ruling.**
- No backfill: NULL means "default printer".

API (all under existing auth and permission patterns, nothing weaker):
- CRUD for stations (create, rename, retire, bind printer), permission matching printer management.
- Product create/update accepts `kitchenStationId`.
- `print-routes` additionally returns stations with their bound printers. Existing fields are unchanged, so current clients keep working.
- `addLineItem` and the offline-sale line path resolve and snapshot the station.

Web: a Stations section on the Printers screen, a station picker on product edit, and the grouped ticket in `counter/page.tsx`. `buildKitchenTicket` gains a grouping function; its existing output for an ungrouped order must be byte-identical (regression test).

## 6. Offline sales interaction

POS-9 offline sales add lines through `OfflineSaleRepository`, which uses the same catalog resolution. The station must be snapshotted at **replay time on the server**, or, preferably, captured on the device with the catalog it sold from, so a replayed order prints to the station that was configured at sale time. This must not alter the offline contract or idempotency keys. If the offline envelope is a frozen contract, adding a field to it is a Core decision.

## 7. Tests required by the build block

- Migration: applies on a fresh database and on a database with existing products; RLS isolation across two businesses; grants as `app_test_user`; repo guards (gap-free numbering).
- Repository: station snapshot on catalog lines, including `kitchen_station_id` NULL; cross-business station id rejected.
- API: station CRUD authorization, a retired station, `print-routes` backward compatibility.
- Web: grouped tickets, failure of one group does not block another, ungrouped output byte-identical to today, reprint uses snapshot.
- Mutation checks on the grouping and the fallback to the default printer.

## 8. Rollback

The migration only adds nullable columns and one table, so the application can be rolled back by deploying the previous build; the new columns are ignored. No data is rewritten. Dropping them later is a separate, explicitly approved step.

## 9. Risks

- Touching `order_line_items` (Core-owned, canonical) is the largest risk; the alternative (K2) avoids it but gives non-deterministic reprints.
- Several tickets per order increases paper and print-job volume; rate and ordering of tickets across stations is not guaranteed.
- Station printers must exist in the device shell with matching registry rows; a mismatch falls back to the default printer rather than failing.

## 10. OWNER DECISIONS required

1. Approve option **B** (station table) over A (column only).
2. Approve **K1** (snapshot station on the order line) and obtain the Core Architecture ruling on adding a nullable column to `order_line_items`; otherwise choose K2 and accept non-deterministic reprints.
3. Whether the cashier note prints on every station ticket (proposed) or only on the default one.
4. Who builds it (POS session or Core Architecture), since it touches Core-owned tables and the offline envelope.
5. Whether stations are in scope before the production window for migrations 0210–0221.

Until these are ruled, no block starts.
