import { describe, expect, it } from 'vitest';
import { BI_FINANCIAL_REPORT_CONTRACT, BO_FINANCIAL_FACTS_CONTRACT, validateFinancialReport, type FinancialReport } from '../src/index';

const good = (): FinancialReport => ({
  contract: BI_FINANCIAL_REPORT_CONTRACT, basedOn: BO_FINANCIAL_FACTS_CONTRACT, businessId: 'b',
  period: {
    range: { from: '2026-10-01', to: '2026-10-31' },
    currencies: [
      { currency: 'EUR', revenue: { amount: '1.00', count: 1 }, averageOrderValue: { amount: '1.00', state: 'OK' }, expenses: { amount: '0.00', count: 0 }, goodsReceived: { amount: '0.00', count: 0 },
        grossProfit: { state: 'COMPUTED', amount: '0.50', marginPercent: '50.00', evidence: { saleLines: 1, saleLinesWithCostEvidence: 1 } } },
      { currency: 'USD', revenue: { amount: '2.00', count: 1 }, averageOrderValue: { amount: '2.00', state: 'OK' }, expenses: { amount: '0.00', count: 0 }, goodsReceived: { amount: '0.00', count: 0 },
        grossProfit: { state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null, evidence: { saleLines: 1, saleLinesWithCostEvidence: 0 } } },
    ],
  },
  comparison: null, trend: { granularity: 'week', buckets: [] }, ordersByStatus: [], indicators: [], coverage: [],
});

describe('bi-financial-report/1 contract', () => {
  it('accepts a well-formed report', () => { expect(validateFinancialReport(good())).toEqual({ valid: true, reasons: [] }); });
  it('refuses a wrong or missing contract name', () => {
    expect(validateFinancialReport({ ...good(), contract: 'bi-financial-report/2' }).reasons).toContain('contract_unsupported');
    expect(validateFinancialReport({ ...good(), basedOn: 'other' }).reasons).toContain('based_on_unsupported');
    expect(validateFinancialReport(null).valid).toBe(false);
  });
  it('refuses an amount that is not a plain decimal (a float artefact, an exponent, five decimals)', () => {
    for (const amount of ['1e3', 'NaN', '1.23456', '', '1.0000000001']) {
      const r = good(); r.period.currencies[0].revenue.amount = amount;
      expect(validateFinancialReport(r).reasons, amount).toContain('period_amount_invalid');
    }
  });
  it('refuses a duplicated, malformed or unsorted currency (figures cannot be merged or mislabelled)', () => {
    const dup = good(); dup.period.currencies[1].currency = 'EUR';
    expect(validateFinancialReport(dup).reasons).toContain('period_currency_duplicated');
    const lower = good(); lower.period.currencies[0].currency = 'eur';
    expect(validateFinancialReport(lower).reasons).toContain('period_currency_invalid');
    const unsorted = good(); unsorted.period.currencies.reverse();
    expect(validateFinancialReport(unsorted).reasons).toContain('period_currencies_not_sorted');
  });
  it('refuses a gross profit VALUE without evidence, and a COMPUTED one without a value', () => {
    const fabricated = good(); fabricated.period.currencies[1].grossProfit.amount = '1.00';
    expect(validateFinancialReport(fabricated).reasons).toContain('period_gross_profit_value_without_evidence');
    const margin = good(); margin.period.currencies[1].grossProfit.marginPercent = '10.00';
    expect(validateFinancialReport(margin).reasons).toContain('period_gross_profit_value_without_evidence');
    const hollow = good(); hollow.period.currencies[0].grossProfit.amount = null;
    expect(validateFinancialReport(hollow).reasons).toContain('period_gross_profit_incomplete');
  });
});
