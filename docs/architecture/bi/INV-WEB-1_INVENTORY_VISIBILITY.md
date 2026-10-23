# INV-WEB-1: Inventory visibility screen (read-only)

Workstream NEW-ARCHITECTURE-01. Layer: web presentation over Business Operations. Source of truth: Business Operations inventory balances. Status: implemented, not deployed.

## Contract used (no backend change)

`GET /v1/businesses/:businessId/operations/inventory?limit=100` (existing; `bo:read`; tenant and workspace from the authenticated context; business must exist in the workspace, else 404; the API clamps `limit` to 1-100, default 50). The screen is `/businesses/<id>/inventory`, a new **Inventory** tab. No new API, permission, table or migration.

## What the screen shows

One row per item and warehouse, exactly as Business Operations returned it: item name and SKU, warehouse, on hand, reserved, available, reorder point, last movement (UTC).

- **Nothing is added up.** Quantities are in each item's own unit; the screen shows counts of rows only (rows shown, none available, at or below reorder point), never a sum of quantities.
- **Flags restate existing rules.** "At or below reorder point" is shown when a reorder point is set (> 0) and available <= reorder point: the same comparison as the Business Operations low-stock query (`InventoryBalanceRepository`). "None available" is shown when available <= 0 and outranks the other flag. No order, forecast or recommendation is made here.
- **Honest about the bound.** The API returns at most 100 rows ordered by item name and does not report a total. A response of exactly 100 rows shows a notice that more may exist.
- **Fails closed.** The response is validated on every read (zod); a non-finite quantity is shown as "unavailable"; loading, error and empty states have the right roles.
- **Read-only.** No button, form or input exists on the screen.

## Evidence

- 27 unit/render tests (`client.inventory.test.tsx`): path and encoding, every flag boundary, formatting, contract rejection, counts, truncation, each view state, read-only, page guard; tab bar now seven screens; NA-05 guard allow-lists the page (8 tenant pages).
- Mutations killed: flag comparison `<=` changed to `<` (1 test), truncation threshold changed (2 tests).
- Contract copy checked against the **real API response** (live PostgreSQL, application role, existing BUILD-32 seed): the web schema parses it and the key sets are equal. This was a one-off check with a temporary test that was not committed (the web package must not import API code); the web validates the shape on every read.
- Web package 384/384, lint, typecheck, `next build` (route present), static-export check (10 required screens).

## Not in this block

Stock value or cost (needs the unit-cost policy), reorder recommendations (owned by the BO policy evaluation), movement history, search or filter, pagination beyond 100 rows (needs an API change), writes of any kind, and a browser run against a live API.
