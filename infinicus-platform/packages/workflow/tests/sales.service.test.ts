/** NEW-BI-02: SalesIntelligenceService request validation and orchestration through the structural facts port (no database). */
import { describe, expect, it } from 'vitest';
import { BO_SALES_FACTS_CONTRACT, type SalesFacts } from '@infinicus/handoff-contracts';
import type { TenantContext } from '@infinicus/database';
import { SalesIntelligenceService, type SalesFactsPort, type SalesFactsPortResult, type SalesFactsRequest } from '../src/sales/SalesIntelligenceService.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const ctx: TenantContext = { tenantId: 't', workspaceId: 'w', userId: 'u' };
const emptyFacts = (r: SalesFactsRequest): SalesFacts => ({
  contract: BO_SALES_FACTS_CONTRACT, businessId: r.businessId, range: { from: r.from, to: r.to }, completedOrders: [], customers: [], lines: [], lineCoverage: [], fulfilment: [],
  products: [], productsTruncated: false, productLinesWithoutProduct: 0, ordersByStatus: [],
});
function port(over: (r: SalesFactsRequest, n: number) => SalesFactsPortResult | null = () => null) {
  const requests: SalesFactsRequest[] = [];
  const p: SalesFactsPort = { async load(_c, r) { requests.push(r); return over(r, requests.length) ?? { outcome: 'FACTS', facts: emptyFacts(r) }; } };
  return { service: new SalesIntelligenceService({ facts: p }), requests };
}
const ask = (service: SalesIntelligenceService, over: Partial<Parameters<SalesIntelligenceService['report']>[1]> = {}) =>
  service.report(ctx, { businessId: BIZ, from: '2026-10-01', to: '2026-10-31', granularity: 'week', compare: 'previous', ...over });

describe('request validation happens before any fact is read', () => {
  it.each([
    ['an impossible date', { from: '2026-02-30' }], ['an invalid month', { to: '2026-13-01' }], ['a reversed period', { from: '2026-11-01', to: '2026-10-01' }],
    ['a period longer than the limit', { from: '2025-01-01', to: '2026-12-31' }], ['topProducts of zero', { topProducts: 0 }], ['topProducts above the limit', { topProducts: 51 }],
    ['a fractional topProducts', { topProducts: 2.5 }],
  ])('%s is INVALID_REQUEST and nothing is read', async (_n, over) => {
    const { service, requests } = port();
    expect(await ask(service, over)).toMatchObject({ outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST' });
    expect(requests).toEqual([]);
  });
});

describe('orchestration', () => {
  it('reads the period and the immediately preceding period of equal length, in that order, and returns a valid report', async () => {
    const { service, requests } = port();
    const out = await ask(service);
    expect(out.outcome).toBe('REPORT');
    expect(requests.map((r) => [r.from, r.to])).toEqual([['2026-10-01', '2026-10-31'], ['2026-08-31', '2026-09-30']]);
  });
  it('compare none reads once and returns no comparison', async () => {
    const { service, requests } = port();
    const out = await ask(service, { compare: 'none' });
    expect(requests).toHaveLength(1);
    expect(out.outcome === 'REPORT' && out.report.comparison).toBeNull();
  });
  it('facts from the port that are unavailable surface as FACTS_UNAVAILABLE, for the period and for the baseline', async () => {
    expect(await ask(port(() => ({ outcome: 'UNAVAILABLE', code: 'X', detail: 'down' })).service)).toMatchObject({ code: 'FACTS_UNAVAILABLE', detail: 'down' });
    expect(await ask(port((_r, n) => (n === 2 ? { outcome: 'UNAVAILABLE', code: 'X', detail: 'baseline down' } : null)).service)).toMatchObject({ code: 'FACTS_UNAVAILABLE', detail: 'baseline down' });
  });
  it('an internally inconsistent fact set is refused as REPORT_INVALID instead of being published', async () => {
    const bad = (r: SalesFactsRequest): SalesFacts => ({ ...emptyFacts(r), completedOrders: [{ date: r.from, currency: 'USD', amount: '1.0000', count: 1, withCustomer: 1 }], customers: [{ currency: 'USD', distinct: 1, returning: 3 }] });
    const { service } = port((r) => ({ outcome: 'FACTS', facts: bad(r) }));
    expect(await ask(service, { compare: 'none' })).toMatchObject({ outcome: 'UNAVAILABLE', code: 'REPORT_INVALID' });
  });
});
