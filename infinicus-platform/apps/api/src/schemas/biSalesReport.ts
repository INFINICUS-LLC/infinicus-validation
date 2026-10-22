import { z } from 'zod';

/** BI-SALES-1: the period is explicit (no defaults) and strictly YYYY-MM-DD; calendar validity and the maximum span are enforced by the BI service. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const biSalesReportParamsSchema = z.object({ businessId: z.string().uuid() });
export const biSalesReportQuerySchema = z.object({ from: isoDate, to: isoDate }).strict();

const point = z.object({
  completedOrders: z.number().int(), voidedOrders: z.number().int(), openOrders: z.number().int(), otherStatusOrders: z.number().int(),
  grossMinor: z.number().int(), discountMinor: z.number().int(), netMinor: z.number().int(),
});
export const biSalesReportResponseSchema = z.union([
  z.object({
    outcome: z.literal('REPORT'),
    report: z.object({
      businessId: z.string().uuid(),
      period: z.object({ from: z.string(), to: z.string(), days: z.number().int(), basis: z.literal('order_date'), inclusive: z.literal(true) }),
      source: z.object({ layer: z.literal('BO'), definition: z.string() }),
      currencies: z.array(z.object({
        currency: z.object({ code: z.string(), minorUnitExponent: z.number().int() }),
        totals: point.extend({ averageOrderNetMinor: z.number().int().nullable(), reconciles: z.boolean() }),
        daily: z.array(point.extend({ date: z.string() })),
      })),
    }),
  }),
  z.object({ outcome: z.literal('NOT_AVAILABLE'), code: z.string(), detail: z.string() }),
]);
