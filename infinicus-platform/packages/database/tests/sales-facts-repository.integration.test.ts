/**
 * NEW-BI-02: the Business Operations SalesFactsRepository against live PostgreSQL under the application role (RLS enforced). Currency separation, date
 * boundaries, status filters, customers (distinct / returning), item types, fulfilment capping, product ranking and cap, order/line coverage, sibling-business
 * and cross-tenant isolation, and read-only behaviour. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { SalesFactsRepository, SALES_PRODUCT_ROW_CAP } from '../src/repositories/bo/SalesFactsRepository.js';
import { addBusiness, createWorld, Seeder, type World } from './helpers/financialFixtures.js';

const RUN = !!process.env.DATABASE_URL;
const ctxOf = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });

describe.runIf(RUN)('SalesFactsRepository (live PostgreSQL, application role)', () => {
  const repo = new SalesFactsRepository();
  let admin: Pool;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });
  const read = (w: World, from = '2026-10-01', to = '2026-10-31') => repo.read(ctxOf(w), w.businessId, from, to);
  const world = async () => { const w = await createWorld(admin, 'Sales'); return { w, s: new Seeder(admin, w) }; };

  it('completed orders only, by day and currency, with the customer-named count; every status is counted', async () => {
    const { w, s } = await world();
    const c1 = await s.customer();
    await s.order({ date: '2026-10-05', currency: 'USD', total: '100.00', customerId: c1 });
    await s.order({ date: '2026-10-05', currency: 'USD', total: '50.50' });
    await s.order({ date: '2026-10-05', currency: 'KWD', total: '10.500' });
    await s.order({ date: '2026-10-06', currency: 'USD', total: '7.00', status: 'planned' });
    await s.order({ date: '2026-10-06', currency: 'USD', total: '9.00', status: 'failed' });
    const f = await read(w);
    expect(f.completedOrders).toEqual([
      { date: '2026-10-05', currency: 'KWD', amount: '10.5000', count: 1, withCustomer: 0 },
      { date: '2026-10-05', currency: 'USD', amount: '150.5000', count: 2, withCustomer: 1 },
    ]);
    expect(f.ordersByStatus).toEqual([{ status: 'completed', count: 3 }, { status: 'failed', count: 1 }, { status: 'planned', count: 1 }]);
  });

  it('date boundaries: the first and last day are in; the days either side are out', async () => {
    const { w, s } = await world();
    for (const d of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']) await s.order({ date: d, currency: 'EUR', total: '1.00', lines: [{ quantity: '1' }] });
    const f = await read(w);
    expect(f.completedOrders.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-31']);
    expect(f.lines.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-31']);
  });

  it('customers: distinct per currency, returning only with a completed order BEFORE the period (any currency); open and later orders do not make a customer returning', async () => {
    const { w, s } = await world();
    const [old, fresh, openOnly, later] = [await s.customer('old'), await s.customer('fresh'), await s.customer('open'), await s.customer('later')];
    await s.order({ date: '2026-08-01', currency: 'KWD', total: '1.000', customerId: old });                         // prior completed order in another currency
    await s.order({ date: '2026-08-02', currency: 'USD', total: '1.00', customerId: openOnly, status: 'planned' });   // prior but not completed
    await s.order({ date: '2026-11-15', currency: 'USD', total: '1.00', customerId: later });                          // after the period
    for (const c of [old, fresh, openOnly, later]) await s.order({ date: '2026-10-10', currency: 'USD', total: '5.00', customerId: c });
    await s.order({ date: '2026-10-11', currency: 'USD', total: '5.00', customerId: old });                            // same customer twice: one distinct
    const f = await read(w);
    expect(f.customers).toEqual([{ currency: 'USD', distinct: 4, returning: 1 }]);
  });

  it('lines by item type: quantity and total as recorded, completed orders only; coverage counts orders without lines', async () => {
    const { w, s } = await world();
    await s.order({ date: '2026-10-05', currency: 'USD', total: '30.00', lines: [{ quantity: '2', total: '20.00' }, { quantity: '1', type: 'fee', total: '10.00' }] });
    await s.order({ date: '2026-10-05', currency: 'USD', total: '9.00' });                                              // completed, no lines
    await s.order({ date: '2026-10-05', currency: 'USD', total: '99.00', status: 'failed', lines: [{ quantity: '9', total: '99.00' }] });
    const f = await read(w);
    expect(f.lines).toEqual([
      { date: '2026-10-05', currency: 'USD', itemType: 'fee', lines: 1, quantity: '1.0000', lineTotal: '10.0000' },
      { date: '2026-10-05', currency: 'USD', itemType: 'product', lines: 1, quantity: '2.0000', lineTotal: '20.0000' },
    ]);
    expect(f.lineCoverage).toEqual([{ currency: 'USD', orders: 2, ordersWithLines: 1 }]);
  });

  it('fulfilment: product lines only, fulfilled capped at ordered per line (an over-fulfilled line cannot hide an under-fulfilled one)', async () => {
    const { w, s } = await world();
    await s.order({ date: '2026-10-05', currency: 'USD', total: '1.00', lines: [
      { quantity: '10', fulfilled: '25' }, { quantity: '10', fulfilled: '2' }, { quantity: '5', type: 'service', fulfilled: '0' },
    ] });
    const f = await read(w);
    expect(f.fulfilment).toEqual([{ currency: 'USD', lines: 2, orderedQuantity: '20.0000', fulfilledQuantity: '12.0000' }]);
  });

  it('products: grouped per currency and product, largest first; lines without a product are counted not ranked; the row cap flags truncation', async () => {
    const { w, s } = await world();
    const [tea, cake] = [await s.product('Tea'), await s.product('Cake')];
    await s.order({ date: '2026-10-05', currency: 'USD', total: '1.00', lines: [
      { quantity: '2', total: '8.00', productId: tea }, { quantity: '1', total: '9.00', productId: cake }, { quantity: '1', total: '3.00' },
    ] });
    await s.order({ date: '2026-10-06', currency: 'USD', total: '1.00', lines: [{ quantity: '3', total: '4.00', productId: tea }] });
    await s.order({ date: '2026-10-06', currency: 'KWD', total: '1.000', lines: [{ quantity: '1', total: '2.000', productId: tea }] });
    const f = await read(w);
    expect(f.products).toEqual([
      { currency: 'USD', productId: tea, name: 'Tea', quantity: '5.0000', lineTotal: '12.0000', lines: 2 },
      { currency: 'USD', productId: cake, name: 'Cake', quantity: '1.0000', lineTotal: '9.0000', lines: 1 },
      { currency: 'KWD', productId: tea, name: 'Tea', quantity: '1.0000', lineTotal: '2.0000', lines: 1 },
    ]);
    expect(f.productsTruncated).toBe(false);
    expect(f.productLinesWithoutProduct).toBe(1);
    expect(SALES_PRODUCT_ROW_CAP).toBe(200);
  });

  it('truncation: more products than the cap returns exactly the cap, largest first, and says so', async () => {
    const { w, s } = await world();
    const ids: string[] = [];
    for (let i = 0; i < SALES_PRODUCT_ROW_CAP + 2; i += 1) ids.push(await s.product(`P${String(i).padStart(3, '0')}`));
    await s.order({ date: '2026-10-05', currency: 'USD', total: '1.00', lines: ids.map((id, i) => ({ quantity: '1', total: String(i + 1), productId: id })) });
    const f = await read(w);
    expect(f.products).toHaveLength(SALES_PRODUCT_ROW_CAP);
    expect(f.productsTruncated).toBe(true);
    expect(f.products[0]!.lineTotal).toBe(`${SALES_PRODUCT_ROW_CAP + 2}.0000`);
  });

  it('isolation: a sibling business and another tenant never contribute; the other tenant reads nothing of this business', async () => {
    const { w, s } = await world();
    const sib = await addBusiness(admin, w);
    const other = await createWorld(admin, 'SalesOther');
    await s.order({ date: '2026-10-05', currency: 'USD', total: '10.00', lines: [{ quantity: '1', total: '10.00' }] });
    await new Seeder(admin, sib).order({ date: '2026-10-05', currency: 'JPY', total: '3000', lines: [{ quantity: '7', total: '3000' }] });
    await new Seeder(admin, other).order({ date: '2026-10-05', currency: 'EUR', total: '4.00' });
    const mine = await read(w);
    expect(mine.completedOrders.map((r) => r.currency)).toEqual(['USD']);
    expect(mine.lines.map((r) => r.currency)).toEqual(['USD']);
    expect((await repo.read(ctxOf(other), w.businessId, '2026-10-01', '2026-10-31')).completedOrders).toEqual([]);   // RLS: another tenant sees nothing of this business
    expect((await repo.read(ctxOf(w), other.businessId, '2026-10-01', '2026-10-31')).completedOrders).toEqual([]);
  });

  it('an invalid business id or date yields empty facts, never a database error; reading writes nothing', async () => {
    const { w, s } = await world();
    await s.order({ date: '2026-10-05', currency: 'USD', total: '10.00' });
    const empty = { completedOrders: [], customers: [], lines: [], lineCoverage: [], fulfilment: [], products: [], productsTruncated: false, productLinesWithoutProduct: 0, ordersByStatus: [] };
    expect(await repo.read(ctxOf(w), 'not-a-uuid', '2026-10-01', '2026-10-31')).toEqual(empty);
    expect(await repo.read(ctxOf(w), w.businessId, '2026-13-45', '2026-10-31')).toEqual(empty);
    expect(await repo.read(ctxOf(w), w.businessId, '2026-11-01', '2026-10-01')).toEqual(empty);
    const count = async () => Number((await admin.query('SELECT count(*)::int n FROM platform.orders WHERE tenant_id = $1', [w.tenantId])).rows[0].n);
    const before = await count();
    await read(w); await read(w);
    expect(await count()).toBe(before);
  });
});
