/** NEW-BI-02: the read-only Business Operations sales facts service validates the request before it reads and stamps the contract on what it returns. */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@infinicus/database';
import { BO_SALES_FACTS_CONTRACT } from '@infinicus/handoff-contracts';
import { SalesFactsService, MAX_SALES_FACTS_RANGE_DAYS } from '../src/sales/SalesFactsService.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const ctx: TenantContext = { tenantId: 't', workspaceId: 'w', userId: 'u' };
const raw = { completedOrders: [], customers: [], lines: [], lineCoverage: [], fulfilment: [], products: [], productsTruncated: false, productLinesWithoutProduct: 0, ordersByStatus: [] };

function service() {
  const calls: unknown[][] = [];
  return { calls, service: new SalesFactsService({ async read(...a) { calls.push(a); return raw; } }) };
}

describe('SalesFactsService', () => {
  it('returns the facts stamped with the contract, the business and the requested range, reading once under the caller context', async () => {
    const { service: s, calls } = service();
    const out = await s.load(ctx, { businessId: BIZ, from: '2026-10-01', to: '2026-10-31' });
    expect(out).toEqual({ outcome: 'FACTS', facts: { contract: BO_SALES_FACTS_CONTRACT, businessId: BIZ, range: { from: '2026-10-01', to: '2026-10-31' }, ...raw } });
    expect(calls).toEqual([[ctx, BIZ, '2026-10-01', '2026-10-31']]);
  });

  it.each([
    ['a business id that is not a lowercase uuid', { businessId: 'NOT-A-UUID', from: '2026-10-01', to: '2026-10-31' }],
    ['an impossible date (February 30)', { businessId: BIZ, from: '2026-02-30', to: '2026-03-10' }],
    ['an out-of-range month, which must not throw', { businessId: BIZ, from: '2026-13-01', to: '2026-13-02' }],
    ['a reversed range', { businessId: BIZ, from: '2026-11-01', to: '2026-10-01' }],
    ['a range over the limit', { businessId: BIZ, from: '2024-01-01', to: '2026-12-31' }],
  ])('refuses %s without reading', async (_n, request) => {
    const { service: s, calls } = service();
    expect(await s.load(ctx, request)).toMatchObject({ outcome: 'UNAVAILABLE', code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
  });

  it('accepts exactly the maximum range', async () => {
    expect(MAX_SALES_FACTS_RANGE_DAYS).toBe(732);
    const { service: s } = service();
    expect((await s.load(ctx, { businessId: BIZ, from: '2025-01-01', to: '2026-12-31' })).outcome).toBe('FACTS');   // 730 days
    expect((await s.load(ctx, { businessId: BIZ, from: '2024-12-30', to: '2026-12-31' })).outcome).toBe('FACTS');   // 732 days
    expect((await s.load(ctx, { businessId: BIZ, from: '2024-12-29', to: '2026-12-31' })).outcome).toBe('UNAVAILABLE');   // 733
  });
});
