// The Business Intelligence sales and operations performance contracts (NEW-BI-02). Pure types and a structural validator; no I/O, no clock.
//
// TWO contracts, one direction each (the same pattern as bi-financial.ts):
//   bo-sales-facts/1      Business Operations -> Business Intelligence. RAW operational aggregates of completed orders and their lines, read-only. No derived figure.
//   bi-sales-report/1     Business Intelligence -> readers. Averages, shares, rates, rankings, comparisons and trends are computed by BI from the facts.
//
// Money and quantities are DECIMAL STRINGS (at most 4 decimals), never JavaScript numbers. Money is never summed or converted across currencies.
// A figure the evidence cannot support carries an explicit state instead of a value.
import type { FinancialDateRange, TrendGranularity } from './bi-financial';

export const BO_SALES_FACTS_CONTRACT = 'bo-sales-facts/1' as const;
export const BI_SALES_REPORT_CONTRACT = 'bi-sales-report/1' as const;

/** Upper bound of product rows one facts read returns (ordered by line total, largest first). */
export const SALES_FACTS_PRODUCT_CAP = 200;

export interface SalesFacts {
  contract: typeof BO_SALES_FACTS_CONTRACT;
  businessId: string;
  range: FinancialDateRange;
  /** Completed orders by order date and currency; `withCustomer` counts those that name a customer. */
  completedOrders: { date: string; currency: string; amount: string; count: number; withCustomer: number }[];
  /** Per currency: distinct customers of the period's completed orders, and how many of them had a completed order BEFORE the period (any currency). */
  customers: { currency: string; distinct: number; returning: number }[];
  /** Lines of completed orders by order date, currency and item type. */
  lines: { date: string; currency: string; itemType: string; lines: number; quantity: string; lineTotal: string }[];
  /** Per currency: completed orders, and how many of them have at least one line. */
  lineCoverage: { currency: string; orders: number; ordersWithLines: number }[];
  /** Per currency, product lines only: quantity ordered and quantity fulfilled (fulfilled capped at ordered per line). */
  fulfilment: { currency: string; lines: number; orderedQuantity: string; fulfilledQuantity: string }[];
  /** Per currency and product, largest line total first, at most SALES_FACTS_PRODUCT_CAP rows overall. */
  products: { currency: string; productId: string; name: string; quantity: string; lineTotal: string; lines: number }[];
  productsTruncated: boolean;
  /** Product lines with no product reference: counted, never ranked. */
  productLinesWithoutProduct: number;
  /** Orders in the period by operational status (all statuses), currency-free counts. */
  ordersByStatus: { status: string; count: number }[];
}

export type RateState = 'OK' | 'NO_DATA';
export interface Rate { percent: string | null; state: RateState }

export interface CurrencySales {
  currency: string;
  orders: { count: number; revenue: string };
  averageOrderValue: { amount: string | null; state: 'OK' | 'NO_ORDERS' | 'UNSUPPORTED_CURRENCY' };
  /** Quantity of product and service lines, and per completed order (null with a state when it is not supported). */
  unitsSold: string;
  unitsPerOrder: { value: string | null; state: 'OK' | 'NO_ORDERS' };
  customers: {
    identifiedOrders: number; anonymousOrders: number; distinct: number; returning: number; newCustomers: number;
    returningShare: Rate;
  };
  itemMix: { itemType: string; lines: number; quantity: string; lineTotal: string; share: Rate }[];
  topProducts: { productId: string; name: string; quantity: string; lineTotal: string; lines: number; share: Rate }[];
  fulfilment: { orderedQuantity: string; fulfilledQuantity: string; rate: Rate };
  /** Orders that have no line at all: their revenue is in `orders` but not in any line figure. */
  ordersWithoutLines: number;
}

export interface SalesDelta { current: string; previous: string; change: string; changePercent: string | null; state: 'OK' | 'NO_BASELINE' }
export interface CurrencySalesDelta { currency: string; orders: SalesDelta; revenue: SalesDelta; unitsSold: SalesDelta; distinctCustomers: SalesDelta }

export interface SalesPeriod { range: FinancialDateRange; currencies: CurrencySales[] }

export interface SalesTrendBucket {
  start: string; end: string;
  currencies: { currency: string; orders: number; revenue: string; unitsSold: string }[];
}

export interface SalesReport {
  contract: typeof BI_SALES_REPORT_CONTRACT;
  basedOn: typeof BO_SALES_FACTS_CONTRACT;
  businessId: string;
  period: SalesPeriod;
  comparison: (SalesPeriod & { deltas: CurrencySalesDelta[] }) | null;
  trend: { granularity: TrendGranularity; buckets: SalesTrendBucket[] };
  /** Currency-free operational counts: how many orders ended completed, failed or reversed, and how many are still open. */
  operations: {
    ordersByStatus: { status: string; count: number }[];
    completed: number; failed: number; reversed: number; inFlight: number;
    completionRate: Rate;
  };
  coverage: string[];
}

const DECIMAL = /^-?\d+(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SalesReportValidation { valid: boolean; reasons: string[] }

/** Structural validation: shape, currency separation, and the "no rate without data" rule. Pure. */
export function validateSalesReport(report: unknown): SalesReportValidation {
  const reasons: string[] = [];
  const r = report as Partial<SalesReport> | null;
  if (r === null || typeof r !== 'object') return { valid: false, reasons: ['not_an_object'] };
  if (r.contract !== BI_SALES_REPORT_CONTRACT) reasons.push('contract_unsupported');
  if (r.basedOn !== BO_SALES_FACTS_CONTRACT) reasons.push('based_on_unsupported');
  const rate = (x: Rate | undefined, label: string): void => {
    if (!x) { reasons.push(`${label}_missing`); return; }
    if (x.state === 'OK' ? x.percent === null || !DECIMAL.test(x.percent) : x.percent !== null) reasons.push(`${label}_rate_inconsistent`);
  };
  const period = (p: SalesPeriod | undefined | null, label: string): void => {
    if (!p || !DATE.test(p.range?.from ?? '') || !DATE.test(p.range?.to ?? '')) { reasons.push(`${label}_range_invalid`); return; }
    const seen = new Set<string>();
    for (const c of p.currencies ?? []) {
      if (!CURRENCY.test(c.currency)) reasons.push(`${label}_currency_invalid`);
      if (seen.has(c.currency)) reasons.push(`${label}_currency_duplicated`);
      seen.add(c.currency);
      for (const v of [c.orders?.revenue, c.unitsSold, c.fulfilment?.orderedQuantity, c.fulfilment?.fulfilledQuantity]) if (!DECIMAL.test(v ?? '')) reasons.push(`${label}_amount_invalid`);
      rate(c.customers?.returningShare, `${label}_returning_share`);
      rate(c.fulfilment?.rate, `${label}_fulfilment`);
      for (const m of c.itemMix ?? []) rate(m.share, `${label}_item_share`);
      for (const t of c.topProducts ?? []) rate(t.share, `${label}_product_share`);
      if (c.customers && (c.customers.newCustomers < 0 || c.customers.returning + c.customers.newCustomers !== c.customers.distinct)) reasons.push(`${label}_customers_do_not_add_up`);
      if (c.customers && c.customers.identifiedOrders + c.customers.anonymousOrders !== c.orders.count) reasons.push(`${label}_orders_do_not_add_up`);
    }
    const codes = (p.currencies ?? []).map((c) => c.currency);
    if (codes.join(',') !== [...codes].sort().join(',')) reasons.push(`${label}_currencies_not_sorted`);
  };
  period(r.period, 'period');
  if (r.comparison) period(r.comparison, 'comparison');
  if (!r.trend || !Array.isArray(r.trend.buckets)) reasons.push('trend_missing');
  if (!r.operations) reasons.push('operations_missing'); else rate(r.operations.completionRate, 'completion');
  return { valid: reasons.length === 0, reasons };
}
