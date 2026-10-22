import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

export const financialReportParamsSchema = z.object({ businessId: z.string().uuid() });

/** `from` and `to` are inclusive UTC calendar dates; the period may not exceed 366 days. `compare` defaults to the preceding period of equal length. */
export const financialReportQuerySchema = z.object({
  from: date,
  to: date,
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  compare: z.enum(['previous', 'none']).default('previous'),
});

const range = z.object({ from: date, to: date });
const money = z.object({ amount: decimal, count: z.number().int() });
const grossProfit = z.object({
  state: z.enum(['COMPUTED', 'NO_REVENUE', 'INSUFFICIENT_COST_EVIDENCE']),
  amount: decimal.nullable(),
  marginPercent: z.string().nullable(),
  evidence: z.object({ saleLines: z.number().int(), saleLinesWithCostEvidence: z.number().int() }),
});
const figures = z.object({
  currency,
  revenue: money,
  averageOrderValue: z.object({ amount: decimal.nullable(), state: z.enum(['OK', 'NO_ORDERS', 'UNSUPPORTED_CURRENCY']) }),
  expenses: money,
  goodsReceived: money,
  grossProfit,
});
const period = z.object({ range, currencies: z.array(figures) });
const delta = z.object({ current: z.string(), previous: z.string(), change: z.string(), changePercent: z.string().nullable(), state: z.enum(['OK', 'NO_BASELINE']) });

export const financialReportResponseSchema = z.object({
  contract: z.literal('bi-financial-report/1'),
  basedOn: z.literal('bo-financial-facts/1'),
  businessId: z.string().uuid(),
  period,
  comparison: period.extend({
    deltas: z.array(z.object({ currency, revenue: delta, expenses: delta, orderCount: delta, grossProfit: delta.nullable() })),
  }).nullable(),
  trend: z.object({
    granularity: z.enum(['day', 'week', 'month']),
    buckets: z.array(z.object({
      start: date, end: date,
      currencies: z.array(z.object({ currency, revenue: decimal, expenses: decimal, orderCount: z.number().int() })),
    })),
  }),
  ordersByStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
  indicators: z.array(z.object({
    metricCode: z.string(), metricName: z.string(), category: z.string(), unit: z.string().nullable(),
    value: z.string(), target: z.string().nullable(), variance: z.string().nullable(), periodStart: z.string(), periodEnd: z.string(),
  })),
  coverage: z.array(z.string()),
});
