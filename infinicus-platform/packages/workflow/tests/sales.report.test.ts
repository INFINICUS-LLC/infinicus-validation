/** NEW-BI-02: the pure sales and operations performance derivation (no database, no clock). */
import { describe, expect, it } from 'vitest';
import { BI_SALES_REPORT_CONTRACT, BO_SALES_FACTS_CONTRACT, validateSalesReport, type SalesFacts } from '@infinicus/handoff-contracts';
import { buildSalesReport } from '../src/sales/salesReport.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const facts = (over: Partial<SalesFacts> = {}, range = { from: '2026-10-01', to: '2026-10-31' }): SalesFacts => ({
  contract: BO_SALES_FACTS_CONTRACT, businessId: BIZ, range, completedOrders: [], customers: [], lines: [], lineCoverage: [], fulfilment: [], products: [],
  productsTruncated: false, productLinesWithoutProduct: 0, ordersByStatus: [], ...over,
});
const build = (current: SalesFacts, previous: SalesFacts | null = null, topProducts = 10, granularity: 'day' | 'week' | 'month' = 'month') =>
  buildSalesReport({ current, previous, granularity, topProducts });
const usd = (r: ReturnType<typeof build>) => r.period.currencies.find((c) => c.currency === 'USD')!;

describe('an empty period', () => {
  it('has no currencies, rates without data are NO_DATA, and the report validates', () => {
    const r = build(facts());
    expect(r).toMatchObject({ contract: BI_SALES_REPORT_CONTRACT, basedOn: BO_SALES_FACTS_CONTRACT, period: { currencies: [] }, comparison: null });
    expect(r.operations).toMatchObject({ completed: 0, failed: 0, reversed: 0, inFlight: 0, completionRate: { percent: null, state: 'NO_DATA' } });
    expect(validateSalesReport(r)).toEqual({ valid: true, reasons: [] });
  });
});

describe('per-currency sales figures', () => {
  const f = facts({
    completedOrders: [
      { date: '2026-10-05', currency: 'USD', amount: '100.0000', count: 2, withCustomer: 1 },
      { date: '2026-10-09', currency: 'USD', amount: '50.0000', count: 1, withCustomer: 1 },
      { date: '2026-10-05', currency: 'KWD', amount: '10.5000', count: 1, withCustomer: 0 },
    ],
    customers: [{ currency: 'USD', distinct: 2, returning: 1 }],
    lines: [
      { date: '2026-10-05', currency: 'USD', itemType: 'product', lines: 2, quantity: '5.0000', lineTotal: '90.0000' },
      { date: '2026-10-09', currency: 'USD', itemType: 'service', lines: 1, quantity: '1.5000', lineTotal: '40.0000' },
      { date: '2026-10-09', currency: 'USD', itemType: 'fee', lines: 1, quantity: '1.0000', lineTotal: '10.0000' },
      { date: '2026-10-09', currency: 'USD', itemType: 'discount', lines: 1, quantity: '1.0000', lineTotal: '-5.0000' },
    ],
    lineCoverage: [{ currency: 'USD', orders: 3, ordersWithLines: 2 }],
    fulfilment: [{ currency: 'USD', lines: 2, orderedQuantity: '5.0000', fulfilledQuantity: '4.0000' }],
    products: [
      { currency: 'USD', productId: 'b', name: 'Beta', quantity: '2.0000', lineTotal: '30.0000', lines: 1 },
      { currency: 'USD', productId: 'a', name: 'Alpha', quantity: '3.0000', lineTotal: '60.0000', lines: 1 },
    ],
    ordersByStatus: [{ status: 'completed', count: 4 }, { status: 'failed', count: 1 }, { status: 'reversed', count: 1 }, { status: 'planned', count: 2 }, { status: 'authorized', count: 1 }],
  });
  const r = build(f);

  it('keeps currencies apart and sorted; amounts follow the currency minor units', () => {
    expect(r.period.currencies.map((c) => c.currency)).toEqual(['KWD', 'USD']);
    expect(usd(r).orders).toEqual({ count: 3, revenue: '150.00' });
    expect(r.period.currencies[0]!.orders).toEqual({ count: 1, revenue: '10.500' });
  });
  it('average order value is exact and rounded to the currency; units and units per order count product and service lines only', () => {
    expect(usd(r).averageOrderValue).toEqual({ amount: '50.00', state: 'OK' });
    expect(usd(r).unitsSold).toBe('6.5');
    expect(usd(r).unitsPerOrder).toEqual({ value: '2.17', state: 'OK' });
  });
  it('customers add up: identified plus anonymous equals orders; returning plus new equals distinct; the share is a rate', () => {
    expect(usd(r).customers).toEqual({ identifiedOrders: 2, anonymousOrders: 1, distinct: 2, returning: 1, newCustomers: 1, returningShare: { percent: '50.00', state: 'OK' } });
    expect(r.period.currencies[0]!.customers.returningShare).toEqual({ percent: null, state: 'NO_DATA' });
  });
  it('item mix shares exclude discount lines from the base and show the discount as recorded with no share', () => {
    const mix = Object.fromEntries(usd(r).itemMix.map((m) => [m.itemType, m]));
    expect(usd(r).itemMix.map((m) => m.itemType)).toEqual(['discount', 'fee', 'product', 'service']);
    expect(mix.product!.share).toEqual({ percent: '64.29', state: 'OK' });       // 90 / (90 + 40 + 10)
    expect(mix.discount).toMatchObject({ lineTotal: '-5.00', share: { percent: null, state: 'NO_DATA' } });
  });
  it('top products are ranked by line total (not input order) with a share of all product-line revenue, and the limit applies', () => {
    expect(usd(r).topProducts.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(usd(r).topProducts[0]).toMatchObject({ lineTotal: '60.00', quantity: '3', share: { percent: '66.67', state: 'OK' } });
    expect(build(f, null, 1).period.currencies[1]!.topProducts.map((p) => p.name)).toEqual(['Alpha']);
  });
  it('ties rank by name then product id, so the order never depends on input order', () => {
    const tie = (order: string[]) => facts({
      completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '1.0000', count: 1, withCustomer: 0 }],
      lines: [{ date: '2026-10-05', currency: 'USD', itemType: 'product', lines: 3, quantity: '3.0000', lineTotal: '30.0000' }],
      products: order.map((id) => ({ currency: 'USD', productId: id, name: id === 'z' ? 'Same' : id === 'y' ? 'Same' : 'Alpha', quantity: '1.0000', lineTotal: '10.0000', lines: 1 })),
    });
    const a = usd(build(tie(['z', 'y', 'x']))).topProducts.map((p) => p.productId);
    const b = usd(build(tie(['x', 'y', 'z']))).topProducts.map((p) => p.productId);
    expect(a).toEqual(['x', 'y', 'z']); expect(b).toEqual(a);
  });
  it('fulfilment rate is fulfilled over ordered; orders without lines are counted so the gap shows', () => {
    expect(usd(r).fulfilment).toEqual({ orderedQuantity: '5', fulfilledQuantity: '4', rate: { percent: '80.00', state: 'OK' } });
    expect(usd(r).ordersWithoutLines).toBe(1);
    expect(r.coverage).toContain('ORDERS_WITHOUT_LINES:USD');
  });
  it('operations: currency-free counts; open orders are in flight and out of the completion rate', () => {
    expect(r.operations).toMatchObject({ completed: 4, failed: 1, reversed: 1, inFlight: 3, completionRate: { percent: '66.67', state: 'OK' } });
  });
  it('the report validates, and standing coverage says what is not covered', () => {
    expect(validateSalesReport(r)).toEqual({ valid: true, reasons: [] });
    expect(r.coverage).toEqual(expect.arrayContaining(['SALES_ARE_COMPLETED_ORDERS_ONLY', 'NO_CURRENCY_CONVERSION', 'NO_PROFIT_OR_MARGIN_DERIVED_HERE', 'LINE_FIGURES_ARE_AS_RECORDED_NOT_RECONCILED_TO_ORDER_TOTALS']));
  });
});

describe('states instead of fabricated values', () => {
  it('a currency with orders but no product lines has no fulfilment rate and no product share; unknown currencies keep 4 digits and no average', () => {
    const r = build(facts({ completedOrders: [{ date: '2026-10-05', currency: 'XYZ', amount: '5.0000', count: 1, withCustomer: 0 }] }));
    const c = r.period.currencies[0]!;
    expect(c.fulfilment.rate).toEqual({ percent: null, state: 'NO_DATA' });
    expect(c.averageOrderValue).toEqual({ amount: null, state: 'UNSUPPORTED_CURRENCY' });
    expect(c.orders.revenue).toBe('5.0000');
  });
  it('line-only currencies (no completed order rows) report NO_ORDERS instead of dividing by zero', () => {
    const r = build(facts({ lines: [{ date: '2026-10-05', currency: 'EUR', itemType: 'product', lines: 1, quantity: '2.0000', lineTotal: '4.0000' }] }));
    expect(r.period.currencies[0]).toMatchObject({ averageOrderValue: { amount: null, state: 'NO_ORDERS' }, unitsPerOrder: { value: null, state: 'NO_ORDERS' } });
  });
  it('truncation and unranked product lines are named in the coverage', () => {
    const r = build(facts({ productsTruncated: true, productLinesWithoutProduct: 2 }));
    expect(r.coverage).toEqual(expect.arrayContaining(['PRODUCT_RANKING_TRUNCATED_AT_SOURCE', 'PRODUCT_LINES_WITHOUT_PRODUCT_REFERENCE_NOT_RANKED']));
  });
  it('a hostile top-products limit is clamped, never trusted', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ currency: 'USD', productId: `p${String(i).padStart(2, '0')}`, name: `N${i}`, quantity: '1.0000', lineTotal: '1.0000', lines: 1 }));
    const f = facts({ products: many, completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '1.0000', count: 1, withCustomer: 0 }] });
    expect(usd(build(f, null, 9999)).topProducts).toHaveLength(50);
    expect(usd(build(f, null, 0)).topProducts).toHaveLength(1);
  });
});

describe('comparison and trend', () => {
  const cur = facts({
    completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '150.0000', count: 3, withCustomer: 3 }, { date: '2026-10-20', currency: 'KWD', amount: '5.0000', count: 1, withCustomer: 0 }],
    customers: [{ currency: 'USD', distinct: 3, returning: 1 }],
    lines: [{ date: '2026-10-05', currency: 'USD', itemType: 'product', lines: 3, quantity: '9.0000', lineTotal: '150.0000' }],
  });
  const prev = facts({
    completedOrders: [{ date: '2026-09-10', currency: 'USD', amount: '100.0000', count: 2, withCustomer: 0 }],
    customers: [{ currency: 'USD', distinct: 0, returning: 0 }],
    lines: [{ date: '2026-09-10', currency: 'USD', itemType: 'product', lines: 2, quantity: '6.0000', lineTotal: '100.0000' }],
  }, { from: '2026-08-31', to: '2026-09-30' });
  const r = build(cur, prev);
  const d = (c: string) => r.comparison!.deltas.find((x) => x.currency === c)!;

  it('computes exact deltas per currency; a zero baseline carries NO_BASELINE and no percentage', () => {
    expect(d('USD').orders).toEqual({ current: '3', previous: '2', change: '1', changePercent: '50.00', state: 'OK' });
    expect(d('USD').revenue).toEqual({ current: '150.00', previous: '100.00', change: '50.00', changePercent: '50.00', state: 'OK' });
    expect(d('USD').unitsSold).toEqual({ current: '9', previous: '6', change: '3', changePercent: '50.00', state: 'OK' });
    expect(d('USD').distinctCustomers).toMatchObject({ current: '3', previous: '0', change: '3', changePercent: null, state: 'NO_BASELINE' });
    expect(d('KWD').revenue).toMatchObject({ previous: '0.000', state: 'NO_BASELINE', changePercent: null });
  });
  it('the trend adds up to the period per currency and is zero-filled', () => {
    const t = build(cur, null, 10, 'week').trend.buckets;
    const total = (c: string, k: 'orders' | 'unitsSold') => t.reduce((n, b) => n + Number(b.currencies.find((x) => x.currency === c)![k]), 0);
    expect(total('USD', 'orders')).toBe(3); expect(total('KWD', 'orders')).toBe(1); expect(total('USD', 'unitsSold')).toBe(9);
    expect(t.every((b) => b.currencies.length === 2)).toBe(true);
    expect(t[0]!.start).toBe('2026-10-01'); expect(t.at(-1)!.end).toBe('2026-10-31');
  });
});

describe('the validator rejects inconsistent reports', () => {
  const ok = () => structuredClone(build(facts({ completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '5.0000', count: 1, withCustomer: 1 }], customers: [{ currency: 'USD', distinct: 1, returning: 0 }] })));
  it.each([
    ['an unsupported contract', (r: any) => { r.contract = 'x'; }, 'contract_unsupported'],
    ['a rate with a value but no data', (r: any) => { r.period.currencies[0].fulfilment.rate = { percent: '10.00', state: 'NO_DATA' }; }, 'period_fulfilment_rate_inconsistent'],
    ['an OK rate without a value', (r: any) => { r.operations.completionRate = { percent: null, state: 'OK' }; }, 'completion_rate_inconsistent'],
    ['customers that do not add up', (r: any) => { r.period.currencies[0].customers.returning = 5; }, 'period_customers_do_not_add_up'],
    ['orders that do not add up', (r: any) => { r.period.currencies[0].customers.anonymousOrders = 4; }, 'period_orders_do_not_add_up'],
    ['a malformed amount', (r: any) => { r.period.currencies[0].orders.revenue = '1e3'; }, 'period_amount_invalid'],
    ['unsorted currencies', (r: any) => { r.period.currencies.push({ ...r.period.currencies[0], currency: 'AED' }); }, 'period_currencies_not_sorted'],
  ])('%s', (_name, mutate, reason) => {
    const r = ok(); mutate(r);
    expect(validateSalesReport(r).reasons).toContain(reason);
  });
  it('a non-object is invalid', () => { expect(validateSalesReport(null)).toEqual({ valid: false, reasons: ['not_an_object'] }); });
});
