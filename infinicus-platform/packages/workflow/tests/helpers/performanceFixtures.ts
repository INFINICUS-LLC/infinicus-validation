/** Shared fixtures for the NEW-BDT-SIM-01 tests: BI report stubs (real report objects) for a business with USD 150.00 over 2 orders and KWD 31.500 over 1 order. */
import { BO_FINANCIAL_FACTS_CONTRACT, type FinancialFacts } from '@infinicus/handoff-contracts';
import { buildFinancialReport } from '../../src/financial/financialReport.js';
import type { FinancialReportOutcome } from '../../src/financial/FinancialIntelligenceService.js';
import type { SalesReportResult } from '../../src/SalesReportService.js';
import type { FinancialReportReader, SalesReportReader } from '../../src/performance/BusinessPerformanceTwinService.js';

export const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

export function financialFor(businessId: string, over: Partial<FinancialFacts> = {}): FinancialReportOutcome {
  const facts: FinancialFacts = {
    contract: BO_FINANCIAL_FACTS_CONTRACT, businessId, range: PERIOD,
    completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '150.0000', count: 2 }, { date: '2026-10-20', currency: 'KWD', amount: '31.5000', count: 1 }],
    ordersByStatus: [], expenseItems: [{ date: '2026-10-07', currency: 'USD', amount: '15.0000', count: 1 }], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0,
    costOfSales: [{ currency: 'KWD', saleLines: 1, saleLinesWithCostEvidence: 1, evidencedCost: '10.5000' }], indicators: [], ...over,
  };
  return { outcome: 'REPORT', report: buildFinancialReport({ current: facts, previous: null, granularity: 'month' }) };
}

export function salesFor(businessId: string, usdMinor = 15000): SalesReportResult {
  return {
    outcome: 'REPORT',
    report: {
      businessId, period: { ...PERIOD, days: 31, basis: 'order_date', inclusive: true },
      source: { layer: 'BO', definition: 'completed orders; net = order total; gross = non-discount lines; discounts = discount lines' },
      currencies: [
        { currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { completedOrders: 1, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 31500, discountMinor: 0, netMinor: 31500, averageOrderNetMinor: 31500, reconciles: true }, daily: [] },
        { currency: { code: 'USD', minorUnitExponent: 2 }, totals: { completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossMinor: usdMinor, discountMinor: 0, netMinor: usdMinor, averageOrderNetMinor: usdMinor / 2, reconciles: true }, daily: [] },
      ],
    },
  };
}

export function readersFor(businessId: string, o: { fin?: () => FinancialReportOutcome; sales?: () => SalesReportResult } = {}): { financial: FinancialReportReader; sales: SalesReportReader } {
  return {
    financial: { async report() { return o.fin ? o.fin() : financialFor(businessId); } },
    sales: { async report() { return o.sales ? o.sales() : salesFor(businessId); } },
  };
}
