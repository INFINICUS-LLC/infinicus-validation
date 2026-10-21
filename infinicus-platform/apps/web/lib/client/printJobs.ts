/**
 * Print routing and the print-job log, from the counter's side (POS-8c). Both are BEST EFFORT: printing a receipt or a kitchen ticket must never wait for,
 * or fail because of, the log or the routing lookup (an API that has not yet been migrated, a lost connection). Nothing is stored in the browser.
 */
import { z } from 'zod';
import type { ApiClient, Scope } from './apiClient';
import type { DetailedOutcome } from './deviceBridge';
import type { PaperMm } from './printing';

export const routedPrinterSchema = z.object({ id: z.string().uuid(), name: z.string(), paperMm: z.union([z.literal(58), z.literal(80)]) }).passthrough();
export const printRoutesSchema = z.object({ receipt: routedPrinterSchema.nullable(), kitchen: routedPrinterSchema.nullable() });
export type PrintRoutes = z.infer<typeof printRoutesSchema>;
export const NO_ROUTES: PrintRoutes = { receipt: null, kitchen: null };

const printJobSchema = z.object({ id: z.string().uuid() }).passthrough();

const businessPath = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}`;

/** Which registered printer each kind of print goes to; no routes (browser printing with the local paper choice) when the lookup fails for any reason. */
export async function fetchPrintRoutes(api: ApiClient, scope: Scope, businessId: string): Promise<PrintRoutes> {
  try { return await api.get(`${businessPath(businessId)}/print-routes`, { scope, schema: printRoutesSchema }); } catch { return NO_ROUTES; }
}

export interface PrintJobEntry {
  orderId: string;
  kind: 'receipt' | 'kitchen';
  trigger: 'automatic' | 'reprint' | 'manual';
  outcome: DetailedOutcome | { ok: boolean; via?: 'browser' | 'device'; code?: string };
  printerId?: string | null;
}

/** The body the API accepts for an outcome. Exported for tests. */
export function printJobBody(entry: PrintJobEntry): Record<string, unknown> {
  const failed = !entry.outcome.ok;
  const code = failed && 'code' in entry.outcome ? entry.outcome.code : undefined;
  return {
    kind: entry.kind, trigger: entry.trigger, outcome: failed ? 'failed' : 'succeeded', printedVia: entry.outcome.via ?? 'browser',
    ...(failed ? { failureCode: code === 'printer_error' || code === 'timeout' || code === 'unsupported' ? code : 'other' } : {}),
    ...(entry.printerId ? { printerId: entry.printerId } : {}),
  };
}

/** Records how a print ended. Returns whether it was recorded; never throws. */
export async function recordPrintJob(api: ApiClient, scope: Scope, businessId: string, entry: PrintJobEntry, newKey: () => string = () => crypto.randomUUID()): Promise<boolean> {
  try {
    await api.post(`${businessPath(businessId)}/orders/${encodeURIComponent(entry.orderId)}/print-jobs`, { body: printJobBody(entry), scope, idempotencyKey: newKey(), schema: printJobSchema });
    return true;
  } catch { return false; }
}

/** The paper width to print on: the routed printer's own width when there is one, else the cashier's choice. */
export const paperFor = (route: { paperMm: PaperMm } | null, chosen: PaperMm): PaperMm => route?.paperMm ?? chosen;
