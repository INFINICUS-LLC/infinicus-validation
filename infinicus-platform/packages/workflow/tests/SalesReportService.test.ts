/**
 * BI-SALES-1 - the BI sales report: period rules, currency separation, continuity, reconciliation and averages (no database, fake BO port).
 */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@infinicus/database';
import {
  SalesReportService, SalesReportPeriodError, validateSalesPeriod, averageHalfUp, MAX_REPORT_DAYS,
  type SalesDayFactsView, type SalesFactsPort, type SalesFactsResultView,
} from '../src/SalesReportService.js';

const ctx: TenantContext = { tenantId: 't', workspaceId: 'w', userId: 'u' };
const fact = (over: Partial<SalesDayFactsView> = {}): SalesDayFactsView => ({
  date: '2026-03-10', currencyCode: 'KWD', currencyExponent: 3, completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0,
  grossMinor: 5250, discountMinor: 500, netMinor: 4750, ...over,
});
const portOf = (result: SalesFactsResultView, seen: unknown[] = []): SalesFactsPort => ({ load: async (...args) => { seen.push(args); return result; } });
const run = (facts: SalesDayFactsView[], from = '2026-03-10', to = '2026-03-12') =>
  new SalesReportService(portOf({ outcome: 'FACTS', facts })).report(ctx, { businessId: 'b', from, to });

describe('validateSalesPeriod', () => {
  it('accepts a single day and a full span, inclusive of both ends', () => {
    expect(validateSalesPeriod('2026-03-10', '2026-03-10').days).toBe(1);
    expect(validateSalesPeriod('2026-03-10', '2026-03-12').days).toBe(3);
    expect(validateSalesPeriod('2026-01-01', '2026-12-31').days).toBe(365);
    expect(validateSalesPeriod('2024-01-01', '2024-12-31').days).toBe(366);        // leap year
  });
  it(`refuses a span over ${MAX_REPORT_DAYS} days, a reversed range and anything that is not a real calendar date`, () => {
    expect(() => validateSalesPeriod('2024-01-01', '2025-01-01')).toThrow(SalesReportPeriodError);
    expect(() => validateSalesPeriod('2026-03-12', '2026-03-10')).toThrow(/not be before/);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '26-03-10', '2026-3-10', '', '2026-03-10T00:00:00Z', 'tomorrow'])
      expect(() => validateSalesPeriod(bad, '2026-12-31'), bad).toThrow(SalesReportPeriodError);
    expect(() => validateSalesPeriod('2026-01-01', '2026-02-29')).toThrow(SalesReportPeriodError);   // 2026 is not a leap year
  });
  it('maps to a 400 by name', () => { expect(new SalesReportPeriodError('x').name).toBe('ValidationError'); });
});

describe('averageHalfUp', () => {
  it.each([[4750, 2, 2375], [100, 3, 33], [101, 3, 34], [1, 2, 1], [0, 5, 0], [5, 10, 1], [4, 10, 0]])('net %i over %i sales is %i', (net, n, expected) => {
    expect(averageHalfUp(net, n)).toBe(expected);
  });
  it('is null when there is no sale', () => { expect(averageHalfUp(0, 0)).toBeNull(); });
});

describe('SalesReportService.report', () => {
  it('produces one section per currency with the period, the definition of the source and integer minor units', async () => {
    const out = await run([fact()]);
    expect(out.outcome).toBe('REPORT');
    if (out.outcome !== 'REPORT') return;
    expect(out.report.period).toEqual({ from: '2026-03-10', to: '2026-03-12', days: 3, basis: 'order_date', inclusive: true });
    expect(out.report.source.layer).toBe('BO');
    expect(out.report.currencies).toHaveLength(1);
    const kwd = out.report.currencies[0];
    expect(kwd.currency).toEqual({ code: 'KWD', minorUnitExponent: 3 });
    expect(kwd.totals).toEqual({ completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossMinor: 5250, discountMinor: 500, netMinor: 4750, averageOrderNetMinor: 2375, reconciles: true });
  });
  it('reports a continuous daily series: days without orders are zeros inside the period, nothing outside it', async () => {
    const out = await run([fact({ date: '2026-03-11' })]);
    if (out.outcome !== 'REPORT') throw new Error('expected a report');
    const days = out.report.currencies[0].daily;
    expect(days.map((d) => d.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(days.map((d) => d.netMinor)).toEqual([0, 4750, 0]);
    expect(days[0]).toEqual({ date: '2026-03-10', completedOrders: 0, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 });
  });
  it('never combines currencies: two currencies are two sections, each in its own exponent, sorted by code', async () => {
    const out = await run([fact(), fact({ currencyCode: 'JPY', currencyExponent: 0, grossMinor: 1500, discountMinor: 0, netMinor: 1500, completedOrders: 1, voidedOrders: 0 })]);
    if (out.outcome !== 'REPORT') throw new Error('expected a report');
    expect(out.report.currencies.map((c) => [c.currency.code, c.currency.minorUnitExponent, c.totals.netMinor])).toEqual([['JPY', 0, 1500], ['KWD', 3, 4750]]);
  });
  it('merges several fact rows of the same day and currency by addition (never across currencies)', async () => {
    const out = await run([fact({ netMinor: 1000, grossMinor: 1000, discountMinor: 0, completedOrders: 1, voidedOrders: 0 }), fact({ netMinor: 500, grossMinor: 500, discountMinor: 0, completedOrders: 1, voidedOrders: 0 })]);
    if (out.outcome !== 'REPORT') throw new Error('expected a report');
    expect(out.report.currencies[0].daily[0]).toMatchObject({ completedOrders: 2, netMinor: 1500, grossMinor: 1500 });
    expect(out.report.currencies[0].totals.averageOrderNetMinor).toBe(750);
  });
  it('invents nothing: no orders in the period means no currency section at all', async () => {
    const out = await run([]);
    expect(out).toMatchObject({ outcome: 'REPORT', report: { currencies: [] } });
  });
  it('states no average when nothing was sold (only voided or open orders)', async () => {
    const out = await run([fact({ completedOrders: 0, voidedOrders: 2, openOrders: 1, grossMinor: 0, discountMinor: 0, netMinor: 0 })]);
    if (out.outcome !== 'REPORT') throw new Error('expected a report');
    expect(out.report.currencies[0].totals).toMatchObject({ completedOrders: 0, voidedOrders: 2, openOrders: 1, netMinor: 0, averageOrderNetMinor: null, reconciles: true });
  });
  it('reports, and does not hide or adjust, a section that does not reconcile', async () => {
    const out = await run([fact({ grossMinor: 5250, discountMinor: 500, netMinor: 4800 })]);
    if (out.outcome !== 'REPORT') throw new Error('expected a report');
    expect(out.report.currencies[0].totals).toMatchObject({ netMinor: 4800, grossMinor: 5250, discountMinor: 500, reconciles: false });
  });
  it('relays an unavailable fact set as NOT_AVAILABLE with the named code, and returns no figures', async () => {
    const out = await new SalesReportService(portOf({ outcome: 'UNAVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: 'x' })).report(ctx, { businessId: 'b', from: '2026-03-10', to: '2026-03-10' });
    expect(out).toEqual({ outcome: 'NOT_AVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: 'x' });
  });
  it('refuses a conflicting exponent for one currency rather than mixing scales', async () => {
    const out = await run([fact(), fact({ date: '2026-03-11', currencyExponent: 2 })]);
    expect(out).toMatchObject({ outcome: 'NOT_AVAILABLE', code: 'CURRENCY_EXPONENT_CONFLICT' });
  });
  it('validates the period BEFORE asking Business Operations for anything', async () => {
    const seen: unknown[] = [];
    const svc = new SalesReportService(portOf({ outcome: 'FACTS', facts: [] }, seen));
    await expect(svc.report(ctx, { businessId: 'b', from: '2026-03-12', to: '2026-03-10' })).rejects.toThrow(SalesReportPeriodError);
    expect(seen).toEqual([]);
  });
  it('passes the caller scope and business to the port unchanged', async () => {
    const seen: unknown[] = [];
    await new SalesReportService(portOf({ outcome: 'FACTS', facts: [] }, seen)).report(ctx, { businessId: 'b', from: '2026-03-10', to: '2026-03-10' });
    expect(seen).toEqual([[ctx, { businessId: 'b', from: '2026-03-10', to: '2026-03-10' }]]);
  });
});
