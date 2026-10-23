/**
 * The finance overview screen's pure logic (FIN-WEB-1): the response contract (a copy of the NEW-BI-01 financial report, `bi-financial-report/1`,
 * validated on every read), the request path, and exact display of the server's decimal text. No React, no network. Everything shown is a figure the
 * server derived; this file computes no totals, no differences and no percentages. Money arrives as decimal TEXT already rounded for its currency and is
 * only grouped for reading by string operations, never converted to a number. Currencies are never combined or converted.
 */
import { z } from 'zod';
import { dayNumber } from './salesReport';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A plain decimal: optional minus, digits, and at most four decimal digits. Checked by splitting, not by one nested pattern. */
export function isDecimalText(text: string): boolean {
  const [whole, fraction, extra] = text.split('.');
  if (extra !== undefined || whole === undefined) return false;
  return /^-?\d+$/.test(whole) && (fraction === undefined || /^\d{1,4}$/.test(fraction));
}
const decimal = z.string().refine(isDecimalText, 'not a plain decimal');
const currency = z.string().regex(/^[A-Z]{3}$/);
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
const period = z.object({ range: z.object({ from: date, to: date }), currencies: z.array(figures) });
const delta = z.object({ current: z.string(), previous: z.string(), change: z.string(), changePercent: z.string().nullable(), state: z.enum(['OK', 'NO_BASELINE']) });

export const financialReportSchema = z.object({
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
export type FinancialReport = z.infer<typeof financialReportSchema>;
export type CurrencyFigures = FinancialReport['period']['currencies'][number];
export type CurrencyDelta = NonNullable<FinancialReport['comparison']>['deltas'][number];

/** Day, week or month buckets for the trend, chosen from the length of the period so the table stays readable (the server accepts any of the three). */
export function granularityFor(from: string, to: string): 'day' | 'week' | 'month' {
  const f = dayNumber(from);
  const t = dayNumber(to);
  if (f === null || t === null || t < f) return 'day';
  const days = t - f + 1;
  return days <= 31 ? 'day' : days <= 186 ? 'week' : 'month';
}

export const financialReportPath = (businessId: string, from: string, to: string): string =>
  `/v1/businesses/${encodeURIComponent(businessId)}/intelligence/financial-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
  `&granularity=${granularityFor(from, to)}&compare=previous`;

/** A server decimal for reading, e.g. "1234567.50" -> "1,234,567.50" and "-2.5" -> "-2.5". Digits are only regrouped; null when the text is not a plain decimal. */
export function groupDecimal(text: string): string | null {
  const [signed, fraction, extra] = text.split('.');
  if (extra !== undefined || signed === undefined || !/^-?\d+$/.test(signed) || (fraction !== undefined && !/^\d+$/.test(fraction))) return null;
  const negative = signed.startsWith('-');
  const whole = negative ? signed.slice(1) : signed;
  let grouped = '';
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
    grouped += whole[i];
  }
  return `${negative ? '-' : ''}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`;
}

/** The server's plain-language meaning of each standing coverage note. An unknown note is shown as the server sent it, never hidden. */
const COVERAGE_TEXT: Record<string, string> = {
  REVENUE_IS_COMPLETED_ORDERS_ONLY: 'Revenue counts completed orders only.',
  EXPENSES_ARE_APPROVED_OR_PAID_CLAIMS_ONLY: 'Expenses count approved or paid claims only.',
  GOODS_RECEIVED_IS_PURCHASING_NOT_EXPENSE_AND_IS_NOT_NETTED: 'Goods received is purchasing, not an expense, and is not subtracted from anything.',
  NO_CURRENCY_CONVERSION: 'Currencies are never converted or added together.',
  CREDIT_NOTES_NOT_NETTED: 'Credit notes are not subtracted.',
  NO_TAX_SPLIT: 'Tax is not separated.',
  NO_NET_PROFIT_DERIVED: 'Net profit is not calculated.',
  DATES_ARE_UTC_CALENDAR_DAYS: 'Dates are UTC calendar days.',
  EXPENSE_ITEMS_EXCLUDED_FOR_MISSING_OR_CONFLICTING_CURRENCY: 'Some expense items were left out because their currency is missing or conflicts.',
  GOODS_RECEIVED_WITHOUT_UNIT_COST_NOT_VALUED: 'Some goods received have no unit cost, so they are not valued.',
};
export function coverageText(note: string): string {
  const known = COVERAGE_TEXT[note];
  if (known) return known;
  const m = /^GROSS_PROFIT_COST_EVIDENCE_INCOMPLETE:([A-Z]{3})$/.exec(note);
  return m ? `Gross profit in ${m[1]} is not shown because cost evidence is incomplete.` : note;
}
