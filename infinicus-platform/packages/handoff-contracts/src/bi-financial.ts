// The Business Intelligence financial reporting contracts (NEW-BI-01). Pure types and a structural validator; no I/O, no clock.
//
// TWO contracts, one direction each:
//   bo-financial-facts/1      Business Operations -> Business Intelligence. RAW operational aggregates, read-only, keyed by calendar day and CURRENCY. No derived figure.
//   bi-financial-report/1     Business Intelligence -> readers. Every derived figure (averages, margins, comparisons, trends) is computed by BI from the facts.
//
// Money is a DECIMAL STRING, never a JavaScript number, and is never summed across currencies: every figure is keyed by its ISO 4217 code.
// A figure that cannot be derived from evidence carries an explicit state instead of a value (never a fabricated zero).

export const BO_FINANCIAL_FACTS_CONTRACT = 'bo-financial-facts/1' as const;
export const BI_FINANCIAL_REPORT_CONTRACT = 'bi-financial-report/1' as const;

/** Inclusive calendar dates, UTC, `YYYY-MM-DD`. */
export interface FinancialDateRange { from: string; to: string }

/** One day's total in one currency. `amount` is a decimal string with at most 4 decimals (the storage precision). */
export interface DailyAmount { date: string; currency: string; amount: string; count: number }

export interface CostOfSalesEvidence {
  currency: string;
  /** Lines (not discounts) of completed orders in the period. */
  saleLines: number;
  /** Of those, the lines whose full quantity is covered by issue movements carrying a unit cost in the order's currency. */
  saleLinesWithCostEvidence: number;
  /** Cost of the evidenced lines only, decimal string. */
  evidencedCost: string;
}

export interface RecordedIndicator {
  metricCode: string; metricName: string; category: string; unit: string | null;
  value: string; target: string | null; variance: string | null; periodStart: string; periodEnd: string;
}

export interface FinancialFacts {
  contract: typeof BO_FINANCIAL_FACTS_CONTRACT;
  businessId: string;
  range: FinancialDateRange;
  /** Completed orders by order date and currency (voided and open orders are NOT here). */
  completedOrders: DailyAmount[];
  ordersByStatus: { status: string; count: number }[];
  /** Items of APPROVED or PAID expense claims, by expense date, in the item's currency (equal to the claim's). */
  expenseItems: DailyAmount[];
  /** Approved or paid expense items left out because their currency is missing or differs from their claim's. */
  expenseItemsExcludedForCurrency: number;
  /** Goods received at a recorded unit cost, by receipt date (UTC) and cost currency. */
  goodsReceived: DailyAmount[];
  /** Receipt lines in the period with no unit cost: counted, never valued. */
  goodsReceivedWithoutCost: number;
  costOfSales: CostOfSalesEvidence[];
  indicators: RecordedIndicator[];
}

export type MeasureState = 'OK' | 'NO_BASELINE';

export interface MoneyFigure { amount: string; count: number }

export type GrossProfitState = 'COMPUTED' | 'NO_REVENUE' | 'INSUFFICIENT_COST_EVIDENCE';

export interface GrossProfit {
  state: GrossProfitState;
  /** Present only when state is COMPUTED. */
  amount: string | null;
  /** Percent of revenue, 2 decimals; present only when COMPUTED. */
  marginPercent: string | null;
  evidence: { saleLines: number; saleLinesWithCostEvidence: number };
}

export interface CurrencyFigures {
  currency: string;
  revenue: MoneyFigure;
  /** Average of completed orders, rounded to the currency's minor unit; null with a state when it cannot be rounded or there are no orders. */
  averageOrderValue: { amount: string | null; state: 'OK' | 'NO_ORDERS' | 'UNSUPPORTED_CURRENCY' };
  expenses: MoneyFigure;
  goodsReceived: MoneyFigure;
  grossProfit: GrossProfit;
}

export interface PeriodFigures { range: FinancialDateRange; currencies: CurrencyFigures[] }

export interface Delta { current: string; previous: string; change: string; changePercent: string | null; state: MeasureState }

export interface CurrencyDelta { currency: string; revenue: Delta; expenses: Delta; orderCount: Delta; grossProfit: Delta | null }

export type TrendGranularity = 'day' | 'week' | 'month';

export interface TrendBucket {
  start: string; end: string;
  currencies: { currency: string; revenue: string; expenses: string; orderCount: number }[];
}

export interface FinancialReport {
  contract: typeof BI_FINANCIAL_REPORT_CONTRACT;
  basedOn: typeof BO_FINANCIAL_FACTS_CONTRACT;
  businessId: string;
  period: PeriodFigures;
  /** The immediately preceding period of equal length, or null when not requested. */
  comparison: (PeriodFigures & { deltas: CurrencyDelta[] }) | null;
  trend: { granularity: TrendGranularity; buckets: TrendBucket[] };
  ordersByStatus: { status: string; count: number }[];
  indicators: RecordedIndicator[];
  /** Stable codes for what the figures do and do not cover. */
  coverage: string[];
}

const DECIMAL = /^-?\d+(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportValidation { valid: boolean; reasons: string[] }

/** Structural validation of a report: shape, currency separation and the "no value without evidence" rule. Pure. */
export function validateFinancialReport(report: unknown): ReportValidation {
  const reasons: string[] = [];
  const r = report as Partial<FinancialReport> | null;
  if (r === null || typeof r !== 'object') return { valid: false, reasons: ['not_an_object'] };
  if (r.contract !== BI_FINANCIAL_REPORT_CONTRACT) reasons.push('contract_unsupported');
  if (r.basedOn !== BO_FINANCIAL_FACTS_CONTRACT) reasons.push('based_on_unsupported');
  const period = (p: PeriodFigures | undefined | null, label: string): void => {
    if (!p || !DATE.test(p.range?.from ?? '') || !DATE.test(p.range?.to ?? '')) { reasons.push(`${label}_range_invalid`); return; }
    const seen = new Set<string>();
    for (const c of p.currencies ?? []) {
      if (!CURRENCY.test(c.currency)) reasons.push(`${label}_currency_invalid`);
      if (seen.has(c.currency)) reasons.push(`${label}_currency_duplicated`);
      seen.add(c.currency);
      for (const money of [c.revenue?.amount, c.expenses?.amount, c.goodsReceived?.amount]) if (!DECIMAL.test(money ?? '')) reasons.push(`${label}_amount_invalid`);
      const gp = c.grossProfit;
      if (gp?.state === 'COMPUTED') {
        if (gp.amount === null || !DECIMAL.test(gp.amount) || gp.marginPercent === null) reasons.push(`${label}_gross_profit_incomplete`);
      } else if (gp?.amount !== null || gp?.marginPercent !== null) reasons.push(`${label}_gross_profit_value_without_evidence`);
    }
    const codes = (p.currencies ?? []).map((c) => c.currency);
    if (codes.join(',') !== [...codes].sort().join(',')) reasons.push(`${label}_currencies_not_sorted`);
  };
  period(r.period, 'period');
  if (r.comparison) period(r.comparison, 'comparison');
  if (!r.trend || !Array.isArray(r.trend.buckets)) reasons.push('trend_missing');
  return { valid: reasons.length === 0, reasons };
}
