import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

export const salesReportParamsSchema = z.object({ businessId: z.string().uuid() });

/** `from` and `to` are inclusive UTC calendar dates; the period may not exceed 366 days. `compare` defaults to the preceding period of equal length. */
export const salesReportQuerySchema = z.object({
  from: date,
  to: date,
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  compare: z.enum(['previous', 'none']).default('previous'),
  topProducts: z.coerce.number().int().min(1).max(50).default(10),
});

const rate = z.object({ percent: z.string().nullable(), state: z.enum(['OK', 'NO_DATA']) });
const range = z.object({ from: date, to: date });
const currencySales = z.object({
  currency,
  orders: z.object({ count: z.number().int(), revenue: decimal }),
  averageOrderValue: z.object({ amount: decimal.nullable(), state: z.enum(['OK', 'NO_ORDERS', 'UNSUPPORTED_CURRENCY']) }),
  unitsSold: decimal,
  unitsPerOrder: z.object({ value: decimal.nullable(), state: z.enum(['OK', 'NO_ORDERS']) }),
  customers: z.object({
    identifiedOrders: z.number().int(), anonymousOrders: z.number().int(), distinct: z.number().int(), returning: z.number().int(), newCustomers: z.number().int(),
    returningShare: rate,
  }),
  itemMix: z.array(z.object({ itemType: z.string(), lines: z.number().int(), quantity: decimal, lineTotal: decimal, share: rate })),
  topProducts: z.array(z.object({ productId: z.string(), name: z.string(), quantity: decimal, lineTotal: decimal, lines: z.number().int(), share: rate })),
  fulfilment: z.object({ orderedQuantity: decimal, fulfilledQuantity: decimal, rate }),
  ordersWithoutLines: z.number().int(),
});
const period = z.object({ range, currencies: z.array(currencySales) });
const delta = z.object({ current: z.string(), previous: z.string(), change: z.string(), changePercent: z.string().nullable(), state: z.enum(['OK', 'NO_BASELINE']) });

export const salesReportResponseSchema = z.object({
  contract: z.literal('bi-sales-report/1'),
  basedOn: z.literal('bo-sales-facts/1'),
  businessId: z.string().uuid(),
  period,
  comparison: period.extend({
    deltas: z.array(z.object({ currency, orders: delta, revenue: delta, unitsSold: delta, distinctCustomers: delta })),
  }).nullable(),
  trend: z.object({
    granularity: z.enum(['day', 'week', 'month']),
    buckets: z.array(z.object({
      start: date, end: date,
      currencies: z.array(z.object({ currency, orders: z.number().int(), revenue: decimal, unitsSold: decimal })),
    })),
  }),
  operations: z.object({
    ordersByStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
    completed: z.number().int(), failed: z.number().int(), reversed: z.number().int(), inFlight: z.number().int(),
    completionRate: rate,
  }),
  coverage: z.array(z.string()),
});
