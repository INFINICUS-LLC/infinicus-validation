/** NEW-BI-01: FinancialIntelligenceService request validation and orchestration through the structural facts port (no database). */
import { describe, expect, it } from 'vitest';
import { BO_FINANCIAL_FACTS_CONTRACT, type FinancialFacts } from '@infinicus/handoff-contracts';
import type { TenantContext } from '@infinicus/database';
import { FinancialIntelligenceService, MAX_REPORT_DAYS, type FinancialFactsPort, type FinancialFactsPortResult, type FinancialFactsRequest } from '../src/financial/FinancialIntelligenceService.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const ctx: TenantContext = { tenantId: 't', workspaceId: 'w', userId: 'u' };
const emptyFacts = (r: FinancialFactsRequest): FinancialFacts => ({
  contract: BO_FINANCIAL_FACTS_CONTRACT, businessId: r.businessId, range: { from: r.from, to: r.to }, completedOrders: [], ordersByStatus: [], expenseItems: [],
  expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [],
});
function port(over: (r: FinancialFactsRequest, n: number) => FinancialFactsPortResult | null = () => null) {
  const requests: FinancialFactsRequest[] = [];
  const p: FinancialFactsPort = { async load(_c, r) { requests.push(r); return over(r, requests.length) ?? { outcome: 'FACTS', facts: emptyFacts(r) }; } };
  return { service: new FinancialIntelligenceService({ facts: p }), requests };
}
const ask = (service: FinancialIntelligenceService, over: Partial<Parameters<FinancialIntelligenceService['report']>[1]> = {}) =>
  service.report(ctx, { businessId: BIZ, from: '2026-10-01', to: '2026-10-31', granularity: 'week', compare: 'previous', ...over });

describe('request validation happens before any fact is read', () => {
  it.each([
    ['an impossible date', { from: '2026-02-30' }], ['an invalid month', { to: '2026-13-01' }], ['a malformed date', { from: '10/01/2026' }],
    ['a reversed period', { from: '2026-11-01', to: '2026-10-01' }],
    ['a period longer than the limit', { from: '2025-01-01', to: '2026-12-31' }],
  ])('%s is INVALID_REQUEST and nothing is read', async (_name, over) => {
    const { service, requests } = port();
    const out = await ask(service, over);
    expect(out).toMatchObject({ outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST' });
    expect(requests).toEqual([]);
  });

  it('accepts exactly the maximum period and refuses one day more', async () => {
    const { service } = port();
    expect((await ask(service, { from: '2026-01-01', to: '2026-12-31', granularity: 'week', compare: 'none' })).outcome).toBe('REPORT');   // 365 days
    expect(MAX_REPORT_DAYS).toBe(366);
    expect((await ask(service, { from: '2024-01-01', to: '2024-12-31', granularity: 'week', compare: 'none' })).outcome).toBe('REPORT');   // 366 days (leap)
    expect((await ask(service, { from: '2024-01-01', to: '2025-01-01', granularity: 'week', compare: 'none' })).outcome).toBe('UNAVAILABLE');   // 367
  });

  it('a one-day period is valid', async () => {
    expect((await ask(port().service, { from: '2026-10-21', to: '2026-10-21' })).outcome).toBe('REPORT');
  });
});

describe('orchestration', () => {
  it('reads the period, and the immediately preceding period of equal length only when a comparison is asked for', async () => {
    const withCompare = port();
    await ask(withCompare.service);
    expect(withCompare.requests).toEqual([
      { businessId: BIZ, from: '2026-10-01', to: '2026-10-31' },
      { businessId: BIZ, from: '2026-08-31', to: '2026-09-30' },
    ]);
    const without = port();
    const out = await ask(without.service, { compare: 'none' });
    expect(without.requests).toHaveLength(1);
    expect(out.outcome === 'REPORT' && out.report.comparison).toBeNull();
  });

  it('the report carries the requested business, period and granularity', async () => {
    const out = await ask(port().service, { granularity: 'month', compare: 'none' });
    expect(out.outcome).toBe('REPORT');
    if (out.outcome === 'REPORT') {
      expect(out.report.businessId).toBe(BIZ);
      expect(out.report.period.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
      expect(out.report.trend.granularity).toBe('month');
    }
  });

  it('an unavailable fact source is reported as FACTS_UNAVAILABLE, for the period and for the comparison, never as an empty report', async () => {
    const first = await ask(port(() => ({ outcome: 'UNAVAILABLE', code: 'X', detail: 'down' })).service);
    expect(first).toMatchObject({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE' });
    const second = await ask(port((r, n) => (n === 2 ? { outcome: 'UNAVAILABLE', code: 'X', detail: 'down' } : null)).service);
    expect(second).toMatchObject({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE' });
  });

  it('a report that fails its own contract is refused, not returned', async () => {
    const bad = port((r) => ({ outcome: 'FACTS', facts: { ...emptyFacts(r), completedOrders: [{ date: r.from, currency: 'usd', amount: '1', count: 1 }] } }));
    const out = await ask(bad.service, { compare: 'none' });
    expect(out).toMatchObject({ outcome: 'UNAVAILABLE', code: 'REPORT_INVALID' });
  });
});
