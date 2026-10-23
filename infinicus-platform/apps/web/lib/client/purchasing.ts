/**
 * The purchasing screen's pure logic (PUR-WEB-1): the response contracts (copies of the existing Business Operations purchase-order and supplier reads,
 * validated on every read), the request paths, and display helpers. No React, no network. Everything shown is a figure Business Operations returned for
 * that row. Nothing is added up across rows (purchase orders are in different currencies), no value is invented, and an amount that cannot be shown
 * exactly in its currency is shown as unavailable instead of being rounded.
 */
import { z } from 'zod';
import { formatMinor } from './salesReport';
import { minorUnitsOf } from './currency';

export const purchaseOrdersSchema = z.object({
  purchaseOrders: z.array(z.object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    supplierName: z.string(),
    poNumber: z.string(),
    orderDate: z.string(),
    expectedDate: z.string().nullable(),
    currencyCode: z.string(),
    totalAmount: z.number().finite(),
    poStatus: z.string(),
    approvedAt: z.string().nullable(),
  })),
});
export const suppliersSchema = z.object({
  suppliers: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    supplierCode: z.string(),
    riskStatus: z.string(),
    status: z.string(),
    latestPerformanceScore: z.number().finite().nullable(),
    latestPerformanceAt: z.string().nullable(),
  })),
});
export type PurchaseOrdersResponse = z.infer<typeof purchaseOrdersSchema>;
export type SuppliersResponse = z.infer<typeof suppliersSchema>;
export type PurchaseOrderRow = PurchaseOrdersResponse['purchaseOrders'][number];

/** The most rows the API returns for one read (it clamps the limit to 100). A list of exactly this length may be cut short. */
export const PURCHASING_LIMIT = 100;
export const mayBeTruncated = (count: number): boolean => count >= PURCHASING_LIMIT;

/** The statuses the API accepts as a filter, in the order a purchase moves through them. */
export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const isPoStatus = (value: string): value is PoStatus => (PO_STATUSES as readonly string[]).includes(value);
const STATUS_TEXT: Record<string, string> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved', partially_received: 'Partly received', received: 'Received', cancelled: 'Cancelled',
};
/** Plain words for a status; one the screen does not know is shown as the server sent it. */
export const statusText = (status: string): string => STATUS_TEXT[status] ?? status;

const base = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}/operations`;
export const purchaseOrdersPath = (businessId: string, status: PoStatus | null): string =>
  `${base(businessId)}/procurement?limit=${PURCHASING_LIMIT}${status ? `&status=${status}` : ''}`;
export const suppliersPath = (businessId: string): string => `${base(businessId)}/suppliers?limit=${PURCHASING_LIMIT}`;

/**
 * A purchase-order total for display, exact in its currency: the amount must be a whole number of that currency's minor units (KWD to the fils), the
 * currency must be one the platform knows, and the result is never rounded. Anything else is null and the page says "amount unavailable".
 */
export function formatOrderTotal(amount: number, currencyCode: string): string | null {
  const exponent = minorUnitsOf(currencyCode);
  if (exponent === null) return null;
  const scaled = amount * 10 ** exponent;
  const minor = Math.round(scaled);
  if (Math.abs(scaled - minor) > 1e-6) return null;
  return formatMinor(minor, exponent, currencyCode);
}

/** The UTC calendar date of a timestamp, or "unavailable" when it cannot be read. */
export function utcDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : new Date(t).toISOString().slice(0, 10);
}
