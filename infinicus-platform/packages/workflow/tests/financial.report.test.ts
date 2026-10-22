/**
 * NEW-BI-01: the pure financial report. Currency separation, "no value without evidence", exactness, comparison and trend consistency.
 * Each principal invariant is mutation-tested (see the completion report).
 */
import { describe, expect, it } from 'vitest';
import { BI_FINANCIAL_REPORT_CONTRACT, BO_FINANCIAL_FACTS_CONTRACT, validateFinancialReport, type FinancialFacts } from '@infinicus/handoff-contracts';
import { buildFinancialReport } from '../src/financial/financialReport.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const facts = (over: Partial<FinancialFacts> = {}, range = { from: '2026-10-01', to: '2026-10-31' }): FinancialFacts => ({
  contract: BO_FINANCIAL_FACTS_CONTRACT, businessId: BIZ, range, completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0,
  goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [], ...over,
});
const day = (date: string, currency: string, amount: string, count = 1) => ({ date, currency, amount, count });
const report = (current: FinancialFacts, previous: FinancialFacts | null = null, granularity: 'day' | 'week' | 'month' = 'week') => buildFinancialReport({ current, previous, granularity });
const fig = (r: ReturnType<typeof report>, currency: string) => r.period.currencies.find((c) => c.currency === currency)!;

describe('currency separation', () => {
  it('never sums or converts across currencies: every figure sits under its own code, sorted', () => {
    const r = report(facts({
      completedOrders: [day('2026-10-02', 'USD', '100.00'), day('2026-10-03', 'KWD', '10.500'), day('2026-10-04', 'USD', '50.25', 2), day('2026-10-05', 'JPY', '3000')],
      expenseItems: [day('2026-10-03', 'USD', '20.00'), day('2026-10-03', 'KWD', '1.250')],
    }));
    expect(r.period.currencies.map((c) => c.currency)).toEqual(['JPY', 'KWD', 'USD']);
    expect(fig(r, 'USD').revenue).toEqual({ amount: '150.25', count: 3 });
    expect(fig(r, 'KWD').revenue).toEqual({ amount: '10.500', count: 1 });
    expect(fig(r, 'JPY').revenue).toEqual({ amount: '3000', count: 1 });
    expect(fig(r, 'USD').expenses.amount).toBe('20.00');
    expect(fig(r, 'KWD').expenses.amount).toBe('1.250');
    expect(fig(r, 'JPY').expenses).toEqual({ amount: '0', count: 0 });
    expect(validateFinancialReport(r)).toEqual({ valid: true, reasons: [] });
  });

  it('shows amounts with the digits of the currency (USD 2, KWD 3, JPY 0) and the full 4 for a code it does not know', () => {
    const r = report(facts({ completedOrders: [day('2026-10-02', 'XXX', '5')] }));
    expect(fig(r, 'XXX').revenue.amount).toBe('5.0000');
    expect(fig(r, 'XXX').averageOrderValue).toEqual({ amount: null, state: 'UNSUPPORTED_CURRENCY' });
  });

  it('average order value is rounded to the currency minor unit, and is absent with a state when there are no orders', () => {
    const r = report(facts({ completedOrders: [day('2026-10-02', 'USD', '100.00', 3)] }));
    expect(fig(r, 'USD').averageOrderValue).toEqual({ amount: '33.33', state: 'OK' });
    const none = report(facts({ expenseItems: [day('2026-10-02', 'EUR', '5.00')] }));
    expect(fig(none, 'EUR').averageOrderValue).toEqual({ amount: null, state: 'NO_ORDERS' });
    const kwd = report(facts({ completedOrders: [day('2026-10-02', 'KWD', '10.000', 3)] }));
    expect(fig(kwd, 'KWD').averageOrderValue.amount).toBe('3.333');
  });
});

describe('gross profit exists only where cost evidence supports it', () => {
  const orders = [day('2026-10-02', 'USD', '100.00', 2)];
  it('COMPUTED when every sale line has cost evidence: revenue minus evidenced cost, with margin', () => {
    const r = report(facts({ completedOrders: orders, costOfSales: [{ currency: 'USD', saleLines: 4, saleLinesWithCostEvidence: 4, evidencedCost: '60.00' }] }));
    expect(fig(r, 'USD').grossProfit).toEqual({ state: 'COMPUTED', amount: '40.00', marginPercent: '40.00', evidence: { saleLines: 4, saleLinesWithCostEvidence: 4 } });
  });
  it('INSUFFICIENT_COST_EVIDENCE when even one sale line lacks it: no amount, no margin, the counts are shown', () => {
    const r = report(facts({ completedOrders: orders, costOfSales: [{ currency: 'USD', saleLines: 4, saleLinesWithCostEvidence: 3, evidencedCost: '45.00' }] }));
    expect(fig(r, 'USD').grossProfit).toEqual({ state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null, evidence: { saleLines: 4, saleLinesWithCostEvidence: 3 } });
    expect(r.coverage).toContain('GROSS_PROFIT_COST_EVIDENCE_INCOMPLETE:USD');
  });
  it('INSUFFICIENT_COST_EVIDENCE when there is revenue but no cost evidence row at all (never a zero cost)', () => {
    const r = report(facts({ completedOrders: orders }));
    expect(fig(r, 'USD').grossProfit.state).toBe('INSUFFICIENT_COST_EVIDENCE');
    expect(fig(r, 'USD').grossProfit.amount).toBeNull();
  });
  it('NO_REVENUE when there are no completed orders in that currency, even if costs exist', () => {
    const r = report(facts({ goodsReceived: [day('2026-10-02', 'EUR', '9.00')], costOfSales: [{ currency: 'EUR', saleLines: 0, saleLinesWithCostEvidence: 0, evidencedCost: '0' }] }));
    expect(fig(r, 'EUR').grossProfit.state).toBe('NO_REVENUE');
  });
  it('a loss is a negative gross profit with a negative margin, not hidden', () => {
    const r = report(facts({ completedOrders: orders, costOfSales: [{ currency: 'USD', saleLines: 2, saleLinesWithCostEvidence: 2, evidencedCost: '125.00' }] }));
    expect(fig(r, 'USD').grossProfit).toMatchObject({ state: 'COMPUTED', amount: '-25.00', marginPercent: '-25.00' });
  });
  it('evidence in one currency never supports gross profit in another', () => {
    const r = report(facts({
      completedOrders: [day('2026-10-02', 'USD', '100.00'), day('2026-10-02', 'EUR', '100.00')],
      costOfSales: [{ currency: 'USD', saleLines: 1, saleLinesWithCostEvidence: 1, evidencedCost: '50.00' }],
    }));
    expect(fig(r, 'USD').grossProfit.state).toBe('COMPUTED');
    expect(fig(r, 'EUR').grossProfit.state).toBe('INSUFFICIENT_COST_EVIDENCE');
  });
  it('goods received is purchasing, reported on its own, never netted into expenses or profit; no net profit is derived', () => {
    const r = report(facts({ completedOrders: orders, goodsReceived: [day('2026-10-02', 'USD', '70.00', 5)], expenseItems: [day('2026-10-02', 'USD', '10.00')] }));
    expect(fig(r, 'USD').goodsReceived).toEqual({ amount: '70.00', count: 5 });
    expect(fig(r, 'USD').expenses.amount).toBe('10.00');
    expect(Object.keys(fig(r, 'USD')).sort()).toEqual(['averageOrderValue', 'currency', 'expenses', 'goodsReceived', 'grossProfit', 'revenue']);   // no net-profit figure exists
    expect(r.coverage).toEqual(expect.arrayContaining(['NO_NET_PROFIT_DERIVED', 'NO_CURRENCY_CONVERSION', 'GOODS_RECEIVED_IS_PURCHASING_NOT_EXPENSE_AND_IS_NOT_NETTED']));
  });
  it('states what was left out, instead of absorbing it', () => {
    const r = report(facts({ expenseItemsExcludedForCurrency: 2, goodsReceivedWithoutCost: 3 }));
    expect(r.coverage).toEqual(expect.arrayContaining(['EXPENSE_ITEMS_EXCLUDED_FOR_MISSING_OR_CONFLICTING_CURRENCY', 'GOODS_RECEIVED_WITHOUT_UNIT_COST_NOT_VALUED']));
  });
});

describe('comparison with the preceding period', () => {
  const prevRange = { from: '2026-09-01', to: '2026-09-30' };
  it('computes exact changes and percentages per currency, with revenue, expenses and order count', () => {
    const cur = facts({ completedOrders: [day('2026-10-02', 'USD', '150.00', 3)], expenseItems: [day('2026-10-03', 'USD', '30.00', 1)] });
    const prev = facts({ completedOrders: [day('2026-09-02', 'USD', '100.00', 2)], expenseItems: [day('2026-09-03', 'USD', '40.00', 1)] }, prevRange);
    const r = report(cur, prev);
    expect(r.comparison?.range).toEqual(prevRange);
    expect(r.comparison?.deltas).toEqual([{
      currency: 'USD',
      revenue: { current: '150.00', previous: '100.00', change: '50.00', changePercent: '50.00', state: 'OK' },
      expenses: { current: '30.00', previous: '40.00', change: '-10.00', changePercent: '-25.00', state: 'OK' },
      orderCount: { current: '3', previous: '2', change: '1', changePercent: '50.00', state: 'OK' },
      grossProfit: null,
    }]);
  });
  it('a zero baseline gives NO_BASELINE and no percentage (never a division by zero or an invented 100%)', () => {
    const cur = facts({ completedOrders: [day('2026-10-02', 'USD', '10.00')] });
    const prev = facts({}, prevRange);
    const d = report(cur, prev).comparison!.deltas[0];
    expect(d.revenue).toEqual({ current: '10.00', previous: '0.00', change: '10.00', changePercent: null, state: 'NO_BASELINE' });
  });
  it('a currency present in only one period still compares, against zero', () => {
    const cur = facts({ completedOrders: [day('2026-10-02', 'EUR', '10.00')] });
    const prev = facts({ completedOrders: [day('2026-09-02', 'USD', '20.00')] }, prevRange);
    const r = report(cur, prev);
    expect(r.comparison!.deltas.map((d) => d.currency)).toEqual(['EUR', 'USD']);
    expect(r.comparison!.deltas[1].revenue).toMatchObject({ current: '0.00', previous: '20.00', change: '-20.00', changePercent: '-100.00' });
  });
  it('gross profit is compared only when both periods are COMPUTED', () => {
    const cost = (c: string) => [{ currency: 'USD', saleLines: 1, saleLinesWithCostEvidence: 1, evidencedCost: c }];
    const cur = facts({ completedOrders: [day('2026-10-02', 'USD', '100.00')], costOfSales: cost('60.00') });
    const prev = facts({ completedOrders: [day('2026-09-02', 'USD', '100.00')], costOfSales: cost('80.00') }, prevRange);
    expect(report(cur, prev).comparison!.deltas[0].grossProfit).toMatchObject({ current: '40.00', previous: '20.00', change: '20.00', changePercent: '100.00' });
    const prevNoCost = facts({ completedOrders: [day('2026-09-02', 'USD', '100.00')] }, prevRange);
    expect(report(cur, prevNoCost).comparison!.deltas[0].grossProfit).toBeNull();
  });
  it('no comparison when none is asked for', () => { expect(report(facts()).comparison).toBeNull(); });
});

describe('trend', () => {
  it('buckets tile the period and each bucket holds only its own days; the buckets add up to the period total, per currency', () => {
    const cur = facts({
      completedOrders: [day('2026-10-01', 'USD', '10.00'), day('2026-10-04', 'USD', '5.50', 2), day('2026-10-05', 'USD', '1.00'), day('2026-10-31', 'USD', '2.25'), day('2026-10-15', 'EUR', '7.00')],
      expenseItems: [day('2026-10-06', 'USD', '3.00')],
    });
    for (const g of ['day', 'week', 'month'] as const) {
      const r = report(cur, null, g);
      const sum = (currency: string, key: 'revenue' | 'expenses') => r.trend.buckets.reduce((n, b) => n + Number(b.currencies.find((c) => c.currency === currency)![key]), 0);
      expect(sum('USD', 'revenue')).toBeCloseTo(18.75, 6);
      expect(sum('EUR', 'revenue')).toBeCloseTo(7, 6);
      expect(sum('USD', 'expenses')).toBeCloseTo(3, 6);
      expect(r.trend.buckets.reduce((n, b) => n + b.currencies.find((c) => c.currency === 'USD')!.orderCount, 0)).toBe(fig(r, 'USD').revenue.count);
    }
    const weeks = report(cur, null, 'week').trend.buckets;
    expect(weeks[0]).toMatchObject({ start: '2026-10-01', end: '2026-10-04' });                       // Thursday to Sunday
    expect(weeks[0].currencies.find((c) => c.currency === 'USD')).toMatchObject({ revenue: '15.50', orderCount: 3 });   // 10.00 on the 1st + 5.50 on the 4th
    expect(weeks[1]).toMatchObject({ start: '2026-10-05', end: '2026-10-11' });
  });
  it('a day on the first or last day of the period belongs to the period; a day outside it never enters a bucket', () => {
    const cur = facts({ completedOrders: [day('2026-09-30', 'USD', '999.00'), day('2026-10-01', 'USD', '1.00'), day('2026-10-31', 'USD', '2.00'), day('2026-11-01', 'USD', '999.00')] });
    const r = report(cur, null, 'month');
    expect(r.trend.buckets).toHaveLength(1);
    expect(r.trend.buckets[0].currencies[0].revenue).toBe('3.00');
  });
  it('empty buckets are present with zeros so a chart has no gaps', () => {
    const r = report(facts({ completedOrders: [day('2026-10-02', 'USD', '1.00')] }), null, 'day');
    expect(r.trend.buckets).toHaveLength(31);
    expect(r.trend.buckets[10].currencies[0]).toEqual({ currency: 'USD', revenue: '0.00', expenses: '0.00', orderCount: 0 });
  });
});

describe('the report carries what it is based on', () => {
  it('names both contracts, passes recorded indicators and order statuses through unchanged, and states its standing coverage', () => {
    const indicator = { metricCode: 'otd', metricName: 'On-time delivery', category: 'sales', unit: '%', value: '97.5', target: '95', variance: '2.5', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-08T00:00:00Z' };
    const r = report(facts({ indicators: [indicator], ordersByStatus: [{ status: 'completed', count: 4 }, { status: 'failed', count: 1 }] }));
    expect(r.contract).toBe(BI_FINANCIAL_REPORT_CONTRACT);
    expect(r.basedOn).toBe(BO_FINANCIAL_FACTS_CONTRACT);
    expect(r.indicators).toEqual([indicator]);
    expect(r.ordersByStatus).toEqual([{ status: 'completed', count: 4 }, { status: 'failed', count: 1 }]);
    expect(r.coverage).toEqual(expect.arrayContaining(['REVENUE_IS_COMPLETED_ORDERS_ONLY', 'CREDIT_NOTES_NOT_NETTED', 'DATES_ARE_UTC_CALENDAR_DAYS']));
  });
  it('is exact for large sums', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => day(`2026-10-${String((i % 28) + 1).padStart(2, '0')}`, 'USD', '0.10'));
    expect(fig(report(facts({ completedOrders: rows })), 'USD').revenue.amount).toBe('200.00');
  });
});
