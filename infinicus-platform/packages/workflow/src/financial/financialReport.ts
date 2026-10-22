/**
 * The Business Intelligence financial report (NEW-BI-01; contract `bi-financial-report/1`): a PURE function from Business Operations' raw facts
 * (`bo-financial-facts/1`) to every derived figure. Business Intelligence is the only place averages, margins, comparisons and trends are computed.
 *
 * Rules (each is tested, and the important ones are mutation-tested):
 *  - Currencies are never mixed or converted: every figure is keyed by its ISO 4217 code and sums only within one currency.
 *  - Money is exact (BigInt, 4 decimals); no float is ever used for an amount.
 *  - Nothing is fabricated: no revenue means no gross profit ("NO_REVENUE"); a gross profit needs cost evidence for EVERY sale line of that currency, else
 *    "INSUFFICIENT_COST_EVIDENCE" with the evidence counts and no amount; an average over no orders is "NO_ORDERS"; a change against a zero baseline carries
 *    no percentage ("NO_BASELINE").
 *  - Goods received is purchasing activity, reported separately; it is not netted into expenses and no net profit is ever derived.
 */
import { minorUnitsOf } from '@infinicus/database';
import type {
  CostOfSalesEvidence, CurrencyDelta, CurrencyFigures, DailyAmount, Delta, FinancialDateRange, FinancialFacts, FinancialReport, GrossProfit, PeriodFigures,
  TrendBucket, TrendGranularity,
} from '@infinicus/handoff-contracts';
import { BI_FINANCIAL_REPORT_CONTRACT, BO_FINANCIAL_FACTS_CONTRACT } from '@infinicus/handoff-contracts';
import { divRound, formatMoney, parseMoney, percent, roundToExponent } from './money.js';
import { buckets as bucketsOf } from './periods.js';

interface Sum { units: bigint; count: number }
const ZERO: Sum = { units: 0n, count: 0 };

function sumByCurrency(rows: readonly DailyAmount[], within?: { from: string; to: string }): Map<string, Sum> {
  const out = new Map<string, Sum>();
  for (const row of rows) {
    if (within && (row.date < within.from || row.date > within.to)) continue;
    const prior = out.get(row.currency) ?? ZERO;
    out.set(row.currency, { units: prior.units + parseMoney(row.amount), count: prior.count + row.count });
  }
  return out;
}

/** Digits a currency's amounts show: its ISO minor units, or the full 4 when the code is not a supported ISO 4217 code (never a guessed two). */
const digitsOf = (currency: string): number => minorUnitsOf(currency) ?? 4;
const money = (units: bigint, currency: string): string => formatMoney(units, digitsOf(currency));

function grossProfitOf(currency: string, revenue: Sum, evidence: CostOfSalesEvidence | undefined): GrossProfit {
  const saleLines = evidence?.saleLines ?? 0;
  const withEvidence = evidence?.saleLinesWithCostEvidence ?? 0;
  const counts = { saleLines, saleLinesWithCostEvidence: withEvidence };
  if (revenue.count === 0) return { state: 'NO_REVENUE', amount: null, marginPercent: null, evidence: counts };
  if (saleLines === 0 || withEvidence !== saleLines) return { state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null, evidence: counts };
  const profit = revenue.units - parseMoney(evidence!.evidencedCost);
  return { state: 'COMPUTED', amount: money(profit, currency), marginPercent: revenue.units === 0n ? null : percent(profit, revenue.units), evidence: counts };
}

function figuresFor(facts: FinancialFacts, currencies: readonly string[]): CurrencyFigures[] {
  const revenue = sumByCurrency(facts.completedOrders);
  const expenses = sumByCurrency(facts.expenseItems);
  const received = sumByCurrency(facts.goodsReceived);
  const evidence = new Map(facts.costOfSales.map((c) => [c.currency, c]));
  return currencies.map((currency): CurrencyFigures => {
    const rev = revenue.get(currency) ?? ZERO;
    const exp = expenses.get(currency) ?? ZERO;
    const rcv = received.get(currency) ?? ZERO;
    const exponent = minorUnitsOf(currency);
    const average: CurrencyFigures['averageOrderValue'] = rev.count === 0 ? { amount: null, state: 'NO_ORDERS' }
      : exponent === null ? { amount: null, state: 'UNSUPPORTED_CURRENCY' }
        : { amount: money(roundToExponent(divRound(rev.units, BigInt(rev.count)), exponent), currency), state: 'OK' };
    return {
      currency,
      revenue: { amount: money(rev.units, currency), count: rev.count },
      averageOrderValue: average,
      expenses: { amount: money(exp.units, currency), count: exp.count },
      goodsReceived: { amount: money(rcv.units, currency), count: rcv.count },
      grossProfit: grossProfitOf(currency, rev, evidence.get(currency)),
    };
  });
}

function currenciesOf(...facts: FinancialFacts[]): string[] {
  const set = new Set<string>();
  for (const f of facts) {
    for (const row of [...f.completedOrders, ...f.expenseItems, ...f.goodsReceived]) set.add(row.currency);
    for (const c of f.costOfSales) set.add(c.currency);
  }
  return [...set].sort();
}

function delta(currency: string, current: bigint, previous: bigint, asMoney: boolean): Delta {
  const change = current - previous;
  const text = (units: bigint): string => (asMoney ? money(units, currency) : (units / 10_000n).toString());
  return { current: text(current), previous: text(previous), change: text(change), changePercent: previous === 0n ? null : percent(change, previous), state: previous === 0n ? 'NO_BASELINE' : 'OK' };
}

function deltasFor(currencies: readonly string[], current: CurrencyFigures[], previous: CurrencyFigures[]): CurrencyDelta[] {
  const cur = new Map(current.map((c) => [c.currency, c]));
  const prev = new Map(previous.map((c) => [c.currency, c]));
  return currencies.map((currency): CurrencyDelta => {
    const c = cur.get(currency); const p = prev.get(currency);
    const u = (figure: CurrencyFigures | undefined, pick: (f: CurrencyFigures) => string): bigint => (figure ? parseMoney(pick(figure)) : 0n);
    const n = (figure: CurrencyFigures | undefined): bigint => BigInt(figure?.revenue.count ?? 0) * 10_000n;
    const gpBoth = c?.grossProfit.state === 'COMPUTED' && p?.grossProfit.state === 'COMPUTED';
    return {
      currency,
      revenue: delta(currency, u(c, (f) => f.revenue.amount), u(p, (f) => f.revenue.amount), true),
      expenses: delta(currency, u(c, (f) => f.expenses.amount), u(p, (f) => f.expenses.amount), true),
      orderCount: delta(currency, n(c), n(p), false),
      grossProfit: gpBoth ? delta(currency, parseMoney(c!.grossProfit.amount!), parseMoney(p!.grossProfit.amount!), true) : null,
    };
  });
}

function trendOf(facts: FinancialFacts, granularity: TrendGranularity, currencies: readonly string[]): TrendBucket[] {
  return bucketsOf(facts.range, granularity).map((bucket): TrendBucket => {
    const revenue = sumByCurrency(facts.completedOrders, { from: bucket.start, to: bucket.end });
    const expenses = sumByCurrency(facts.expenseItems, { from: bucket.start, to: bucket.end });
    return {
      start: bucket.start, end: bucket.end,
      currencies: currencies.map((currency) => ({
        currency, revenue: money((revenue.get(currency) ?? ZERO).units, currency), expenses: money((expenses.get(currency) ?? ZERO).units, currency), orderCount: (revenue.get(currency) ?? ZERO).count,
      })),
    };
  });
}

const STANDING_COVERAGE = [
  'REVENUE_IS_COMPLETED_ORDERS_ONLY',
  'EXPENSES_ARE_APPROVED_OR_PAID_CLAIMS_ONLY',
  'GOODS_RECEIVED_IS_PURCHASING_NOT_EXPENSE_AND_IS_NOT_NETTED',
  'NO_CURRENCY_CONVERSION',
  'CREDIT_NOTES_NOT_NETTED',
  'NO_TAX_SPLIT',
  'NO_NET_PROFIT_DERIVED',
  'DATES_ARE_UTC_CALENDAR_DAYS',
] as const;

export interface BuildReportInput {
  current: FinancialFacts;
  /** The facts of the immediately preceding period of equal length, or null when no comparison is requested. */
  previous: FinancialFacts | null;
  granularity: TrendGranularity;
}

export function buildFinancialReport(input: BuildReportInput): FinancialReport {
  const { current, previous, granularity } = input;
  const ownCurrencies = currenciesOf(current);
  const period: PeriodFigures = { range: current.range, currencies: figuresFor(current, ownCurrencies) };
  let comparison: FinancialReport['comparison'] = null;
  if (previous !== null) {
    const previousPeriod: PeriodFigures = { range: previous.range, currencies: figuresFor(previous, currenciesOf(previous)) };
    comparison = { ...previousPeriod, deltas: deltasFor(currenciesOf(current, previous), period.currencies, previousPeriod.currencies) };
  }
  const coverage: string[] = [...STANDING_COVERAGE];
  if (current.expenseItemsExcludedForCurrency > 0) coverage.push('EXPENSE_ITEMS_EXCLUDED_FOR_MISSING_OR_CONFLICTING_CURRENCY');
  if (current.goodsReceivedWithoutCost > 0) coverage.push('GOODS_RECEIVED_WITHOUT_UNIT_COST_NOT_VALUED');
  for (const figures of period.currencies) if (figures.grossProfit.state === 'INSUFFICIENT_COST_EVIDENCE') coverage.push(`GROSS_PROFIT_COST_EVIDENCE_INCOMPLETE:${figures.currency}`);
  return {
    contract: BI_FINANCIAL_REPORT_CONTRACT,
    basedOn: BO_FINANCIAL_FACTS_CONTRACT,
    businessId: current.businessId,
    period,
    comparison,
    trend: { granularity, buckets: trendOf(current, granularity, ownCurrencies) },
    ordersByStatus: current.ordersByStatus,
    indicators: current.indicators,
    coverage,
  };
}

export type { FinancialDateRange };
