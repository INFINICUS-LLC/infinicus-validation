/**
 * The Business Intelligence sales and operations performance report (NEW-BI-02; contract `bi-sales-report/1`): a PURE function from Business Operations' raw
 * facts (`bo-sales-facts/1`) to every derived figure. Business Intelligence is the only place averages, shares, rates, rankings, comparisons and trends are computed.
 *
 * Rules (each is tested, and the important ones are mutation-tested):
 *  - Currencies are never mixed or converted: every money figure is keyed by its ISO 4217 code and sums only within one currency. Only currency-free COUNTS
 *    (order statuses) are reported across currencies.
 *  - Money and quantities are exact (BigInt, 4 decimals); no float is used.
 *  - Nothing is fabricated: a rate or share without data is `NO_DATA` with no percentage; an average over no orders is `NO_ORDERS`; a change against a zero
 *    baseline is `NO_BASELINE`; product lines without a product reference are counted but never ranked.
 *  - Line figures are reported as recorded and are NOT reconciled to order totals (orders without lines are counted so the gap is visible).
 *  - Ranking is deterministic: largest line total, then name, then product id.
 */
import { minorUnitsOf } from '@infinicus/database';
import {
  BI_SALES_REPORT_CONTRACT, BO_SALES_FACTS_CONTRACT,
  type CurrencySales, type CurrencySalesDelta, type FinancialDateRange, type Rate, type SalesDelta, type SalesFacts, type SalesPeriod, type SalesReport,
  type SalesTrendBucket, type TrendGranularity,
} from '@infinicus/handoff-contracts';
import { divRound, formatMoney, parseMoney, percent, roundToExponent } from '../financial/money.js';
import { buckets as bucketsOf } from '../financial/periods.js';

/** Item types whose quantity counts as units sold. Fees, discounts and other lines are not units of anything sold. */
const UNIT_TYPES: ReadonlySet<string> = new Set(['product', 'service']);
const COUNT_UNIT = 10_000n;

export const DEFAULT_TOP_PRODUCTS = 10;
export const MAX_TOP_PRODUCTS = 50;

const digitsOf = (currency: string): number => minorUnitsOf(currency) ?? 4;
const money = (units: bigint, currency: string): string => formatMoney(units, digitsOf(currency));
const qty = (units: bigint): string => formatMoney(units, 0);
const rateOf = (part: bigint, whole: bigint): Rate => (whole <= 0n ? { percent: null, state: 'NO_DATA' } : { percent: percent(part, whole), state: 'OK' });

interface Orders { count: number; withCustomer: number; revenue: bigint }
const ZERO_ORDERS: Orders = { count: 0, withCustomer: 0, revenue: 0n };

function ordersBy(facts: SalesFacts, within?: FinancialDateRange): Map<string, Orders> {
  const out = new Map<string, Orders>();
  for (const row of facts.completedOrders) {
    if (within && (row.date < within.from || row.date > within.to)) continue;
    const prior = out.get(row.currency) ?? ZERO_ORDERS;
    out.set(row.currency, { count: prior.count + row.count, withCustomer: prior.withCustomer + row.withCustomer, revenue: prior.revenue + parseMoney(row.amount) });
  }
  return out;
}

function unitsBy(facts: SalesFacts, within?: FinancialDateRange): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const row of facts.lines) {
    if (!UNIT_TYPES.has(row.itemType)) continue;
    if (within && (row.date < within.from || row.date > within.to)) continue;
    out.set(row.currency, (out.get(row.currency) ?? 0n) + parseMoney(row.quantity));
  }
  return out;
}

function itemMixOf(facts: SalesFacts, currency: string): CurrencySales['itemMix'] {
  const byType = new Map<string, { lines: number; quantity: bigint; total: bigint }>();
  for (const row of facts.lines) {
    if (row.currency !== currency) continue;
    const prior = byType.get(row.itemType) ?? { lines: 0, quantity: 0n, total: 0n };
    byType.set(row.itemType, { lines: prior.lines + row.lines, quantity: prior.quantity + parseMoney(row.quantity), total: prior.total + parseMoney(row.lineTotal) });
  }
  // Discount lines are shown as recorded but are not part of the share base (their sign convention is not part of the contract).
  let base = 0n;
  for (const [type, v] of byType) if (type !== 'discount') base += v.total;
  return [...byType.keys()].sort().map((itemType) => {
    const v = byType.get(itemType)!;
    return {
      itemType, lines: v.lines, quantity: qty(v.quantity), lineTotal: money(v.total, currency),
      share: itemType === 'discount' ? { percent: null, state: 'NO_DATA' as const } : rateOf(v.total, base),
    };
  });
}

function topProductsOf(facts: SalesFacts, currency: string, limit: number): CurrencySales['topProducts'] {
  let productTotal = 0n;
  for (const row of facts.lines) if (row.currency === currency && row.itemType === 'product') productTotal += parseMoney(row.lineTotal);
  const rows = facts.products.filter((p) => p.currency === currency).map((p) => ({ ...p, total: parseMoney(p.lineTotal) }));
  rows.sort((a, b) => (a.total === b.total ? (a.name === b.name ? (a.productId < b.productId ? -1 : 1) : a.name < b.name ? -1 : 1) : a.total > b.total ? -1 : 1));
  return rows.slice(0, limit).map((p) => ({ productId: p.productId, name: p.name, quantity: qty(parseMoney(p.quantity)), lineTotal: money(p.total, currency), lines: p.lines, share: rateOf(p.total, productTotal) }));
}

function salesFor(facts: SalesFacts, currencies: readonly string[], topN: number): CurrencySales[] {
  const orders = ordersBy(facts);
  const units = unitsBy(facts);
  return currencies.map((currency): CurrencySales => {
    const o = orders.get(currency) ?? ZERO_ORDERS;
    const exponent = minorUnitsOf(currency);
    const sold = units.get(currency) ?? 0n;
    const cust = facts.customers.find((c) => c.currency === currency);
    const fulfil = facts.fulfilment.find((f) => f.currency === currency);
    const ordered = fulfil ? parseMoney(fulfil.orderedQuantity) : 0n;
    const fulfilled = fulfil ? parseMoney(fulfil.fulfilledQuantity) : 0n;
    const coverage = facts.lineCoverage.find((c) => c.currency === currency);
    const distinct = cust?.distinct ?? 0;
    const returning = cust?.returning ?? 0;
    return {
      currency,
      orders: { count: o.count, revenue: money(o.revenue, currency) },
      averageOrderValue: o.count === 0 ? { amount: null, state: 'NO_ORDERS' }
        : exponent === null ? { amount: null, state: 'UNSUPPORTED_CURRENCY' }
          : { amount: money(roundToExponent(divRound(o.revenue, BigInt(o.count)), exponent), currency), state: 'OK' },
      unitsSold: qty(sold),
      unitsPerOrder: o.count === 0 ? { value: null, state: 'NO_ORDERS' } : { value: qty(roundToExponent(divRound(sold, BigInt(o.count)), 2)), state: 'OK' },
      customers: {
        identifiedOrders: o.withCustomer, anonymousOrders: o.count - o.withCustomer, distinct, returning, newCustomers: distinct - returning,
        returningShare: rateOf(BigInt(returning), BigInt(distinct)),
      },
      itemMix: itemMixOf(facts, currency),
      topProducts: topProductsOf(facts, currency, topN),
      fulfilment: { orderedQuantity: qty(ordered), fulfilledQuantity: qty(fulfilled), rate: rateOf(fulfilled, ordered) },
      ordersWithoutLines: Math.max(0, o.count - (coverage?.ordersWithLines ?? 0)),
    };
  });
}

function currenciesOf(...facts: SalesFacts[]): string[] {
  const set = new Set<string>();
  for (const f of facts) {
    for (const row of [...f.completedOrders, ...f.lines, ...f.customers, ...f.fulfilment, ...f.products, ...f.lineCoverage]) set.add(row.currency);
  }
  return [...set].sort();
}

function delta(current: bigint, previous: bigint, text: (units: bigint) => string): SalesDelta {
  const change = current - previous;
  return { current: text(current), previous: text(previous), change: text(change), changePercent: previous === 0n ? null : percent(change, previous), state: previous === 0n ? 'NO_BASELINE' : 'OK' };
}

function deltasFor(currencies: readonly string[], current: CurrencySales[], previous: CurrencySales[]): CurrencySalesDelta[] {
  const cur = new Map(current.map((c) => [c.currency, c]));
  const prev = new Map(previous.map((c) => [c.currency, c]));
  const count = (n: number | undefined): bigint => BigInt(n ?? 0) * COUNT_UNIT;
  return currencies.map((currency): CurrencySalesDelta => {
    const c = cur.get(currency); const p = prev.get(currency);
    return {
      currency,
      orders: delta(count(c?.orders.count), count(p?.orders.count), qty),
      revenue: delta(c ? parseMoney(c.orders.revenue) : 0n, p ? parseMoney(p.orders.revenue) : 0n, (u) => money(u, currency)),
      unitsSold: delta(c ? parseMoney(c.unitsSold) : 0n, p ? parseMoney(p.unitsSold) : 0n, qty),
      distinctCustomers: delta(count(c?.customers.distinct), count(p?.customers.distinct), qty),
    };
  });
}

function trendOf(facts: SalesFacts, granularity: TrendGranularity, currencies: readonly string[]): SalesTrendBucket[] {
  return bucketsOf(facts.range, granularity).map((bucket): SalesTrendBucket => {
    const within = { from: bucket.start, to: bucket.end };
    const orders = ordersBy(facts, within);
    const units = unitsBy(facts, within);
    return {
      start: bucket.start, end: bucket.end,
      currencies: currencies.map((currency) => {
        const o = orders.get(currency) ?? ZERO_ORDERS;
        return { currency, orders: o.count, revenue: money(o.revenue, currency), unitsSold: qty(units.get(currency) ?? 0n) };
      }),
    };
  });
}

const STANDING_COVERAGE = [
  'SALES_ARE_COMPLETED_ORDERS_ONLY',
  'LINE_FIGURES_ARE_AS_RECORDED_NOT_RECONCILED_TO_ORDER_TOTALS',
  'UNITS_ARE_PRODUCT_AND_SERVICE_LINE_QUANTITIES',
  'CUSTOMERS_ARE_IDENTIFIED_ORDERS_ONLY',
  'RETURNING_MEANS_A_COMPLETED_ORDER_BEFORE_THE_PERIOD_IN_ANY_CURRENCY',
  'FULFILMENT_IS_PRODUCT_LINES_OF_COMPLETED_ORDERS',
  'NO_CURRENCY_CONVERSION',
  'NO_PROFIT_OR_MARGIN_DERIVED_HERE',
  'DATES_ARE_UTC_CALENDAR_DAYS',
] as const;

function operationsOf(facts: SalesFacts): SalesReport['operations'] {
  const n = (status: string): number => facts.ordersByStatus.find((s) => s.status === status)?.count ?? 0;
  const completed = n('completed'); const failed = n('failed'); const reversed = n('reversed');
  const inFlight = facts.ordersByStatus.filter((s) => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'reversed').reduce((a, s) => a + s.count, 0);
  return { ordersByStatus: facts.ordersByStatus, completed, failed, reversed, inFlight, completionRate: rateOf(BigInt(completed), BigInt(completed + failed + reversed)) };
}

export interface BuildSalesReportInput {
  current: SalesFacts;
  /** The facts of the immediately preceding period of equal length, or null when no comparison is requested. */
  previous: SalesFacts | null;
  granularity: TrendGranularity;
  /** How many products to rank per currency (1..MAX_TOP_PRODUCTS). */
  topProducts: number;
}

export function buildSalesReport(input: BuildSalesReportInput): SalesReport {
  const { current, previous, granularity } = input;
  const topN = Math.min(Math.max(Math.trunc(input.topProducts), 1), MAX_TOP_PRODUCTS);
  const ownCurrencies = currenciesOf(current);
  const period: SalesPeriod = { range: current.range, currencies: salesFor(current, ownCurrencies, topN) };
  let comparison: SalesReport['comparison'] = null;
  if (previous !== null) {
    const previousPeriod: SalesPeriod = { range: previous.range, currencies: salesFor(previous, currenciesOf(previous), topN) };
    comparison = { ...previousPeriod, deltas: deltasFor(currenciesOf(current, previous), period.currencies, previousPeriod.currencies) };
  }
  const coverage: string[] = [...STANDING_COVERAGE];
  if (current.productsTruncated) coverage.push('PRODUCT_RANKING_TRUNCATED_AT_SOURCE');
  if (current.productLinesWithoutProduct > 0) coverage.push('PRODUCT_LINES_WITHOUT_PRODUCT_REFERENCE_NOT_RANKED');
  for (const c of period.currencies) if (c.ordersWithoutLines > 0) coverage.push(`ORDERS_WITHOUT_LINES:${c.currency}`);
  return {
    contract: BI_SALES_REPORT_CONTRACT, basedOn: BO_SALES_FACTS_CONTRACT, businessId: current.businessId,
    period, comparison, trend: { granularity, buckets: trendOf(current, granularity, ownCurrencies) }, operations: operationsOf(current), coverage,
  };
}
