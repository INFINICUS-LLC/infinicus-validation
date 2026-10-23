/**
 * The inventory screen's pure logic (INV-WEB-1): the response contract (a copy of the existing Business Operations inventory read,
 * GET /v1/businesses/:businessId/operations/inventory, validated on every read), the one list bound, and display helpers. No React, no network.
 * Everything shown is a figure Business Operations returned for that row. Nothing is added up across rows (units differ per item), no value is
 * invented, and the only derived text is a flag that restates a comparison the Business Operations low-stock rule already makes
 * (InventoryBalanceRepository: quantity_available <= reorder_point AND reorder_point > 0), plus "none available" for a quantity of zero or less.
 */
import { z } from 'zod';

const quantity = z.number().finite();
export const inventoryResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    inventoryItemId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    itemName: z.string(),
    sku: z.string(),
    warehouseName: z.string(),
    quantityOnHand: quantity,
    quantityReserved: quantity,
    quantityAvailable: quantity,
    reorderPoint: quantity,
    reorderQuantity: quantity,
    lastMovementAt: z.string().nullable(),
  })),
});
export type InventoryResponse = z.infer<typeof inventoryResponseSchema>;
export type InventoryRow = InventoryResponse['items'][number];

/** The most rows the API returns for one read (it clamps the limit to 100). A list of exactly this length may be cut short. */
export const INVENTORY_LIMIT = 100;

export function inventoryPath(businessId: string): string {
  return `/v1/businesses/${encodeURIComponent(businessId)}/operations/inventory?limit=${INVENTORY_LIMIT}`;
}

/** True when the API may have more rows than it returned (the response does not say, so a full page is treated as possibly cut). */
export function mayBeTruncated(rows: readonly InventoryRow[]): boolean {
  return rows.length >= INVENTORY_LIMIT;
}

export type StockFlag = 'none-available' | 'at-or-below-reorder-point' | 'none';
/** "None available" outranks the reorder flag; neither applies when the item has no reorder point set (0). */
export function stockFlag(row: Pick<InventoryRow, 'quantityAvailable' | 'reorderPoint'>): StockFlag {
  if (row.quantityAvailable <= 0) return 'none-available';
  if (row.reorderPoint > 0 && row.quantityAvailable <= row.reorderPoint) return 'at-or-below-reorder-point';
  return 'none';
}
export const FLAG_TEXT: Record<StockFlag, string> = {
  'none-available': 'None available',
  'at-or-below-reorder-point': 'At or below reorder point',
  none: '',
};

const QTY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
/** A stored quantity (up to four decimals) for display, or null when it is not a finite number (shown as unavailable, never guessed). */
export function formatQuantity(n: number): string | null {
  return Number.isFinite(n) ? QTY.format(n) : null;
}

/** How many rows carry each flag: counts of rows only, never a sum of quantities. */
export function flagCounts(rows: readonly InventoryRow[]): { rows: number; noneAvailable: number; atOrBelowReorderPoint: number } {
  let noneAvailable = 0;
  let atOrBelowReorderPoint = 0;
  for (const r of rows) {
    const f = stockFlag(r);
    if (f === 'none-available') noneAvailable += 1;
    else if (f === 'at-or-below-reorder-point') atOrBelowReorderPoint += 1;
  }
  return { rows: rows.length, noneAvailable, atOrBelowReorderPoint };
}

/** The last movement time as an unambiguous UTC date and time, or "no movement yet"; an unparseable value is shown as unavailable. */
export function formatMovement(iso: string | null): string {
  if (iso === null) return 'no movement yet';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
