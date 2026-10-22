/**
 * NEW-BI-01: the Business Operations FinancialFactsRepository against live PostgreSQL under the application role (RLS enforced). Currency separation, date
 * boundaries, status filters, missing-cost handling, cost-of-sales evidence rules, sibling-business and cross-tenant isolation, and read-only behaviour.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { FinancialFactsRepository } from '../src/repositories/bo/FinancialFactsRepository.js';
import { addBusiness, createWorld, Seeder, type World } from './helpers/financialFixtures.js';

const RUN = !!process.env.DATABASE_URL;
const ctxOf = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });

describe.runIf(RUN)('FinancialFactsRepository (live PostgreSQL, application role)', () => {
  const repo = new FinancialFactsRepository();
  let admin: Pool; let a: World; let b: World; let sibling: World; let sa: Seeder;
  const worlds: World[] = [];

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    a = await createWorld(admin, 'FinA'); b = await createWorld(admin, 'FinB'); sibling = await addBusiness(admin, a);
    worlds.push(a, b);
    sa = new Seeder(admin, a);
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const read = (w: World, from: string, to: string) => repo.read(ctxOf(w), w.businessId, from, to);

  it('revenue counts COMPLETED orders only, by day and currency; open, voided and reversed orders are counted by status and never valued', async () => {
    await sa.order({ date: '2026-10-05', currency: 'USD', total: '100.00' });
    await sa.order({ date: '2026-10-05', currency: 'USD', total: '50.50' });
    await sa.order({ date: '2026-10-05', currency: 'KWD', total: '10.500' });
    await sa.order({ date: '2026-10-06', currency: 'USD', total: '7.00', status: 'planned' });
    await sa.order({ date: '2026-10-06', currency: 'USD', total: '9.00', status: 'failed' });
    await sa.order({ date: '2026-10-06', currency: 'USD', total: '11.00', status: 'reversed' });
    const f = await read(a, '2026-10-01', '2026-10-31');
    expect(f.completedOrders).toEqual([
      { date: '2026-10-05', currency: 'KWD', amount: '10.5000', count: 1 },
      { date: '2026-10-05', currency: 'USD', amount: '150.5000', count: 2 },
    ]);
    expect(f.ordersByStatus).toEqual([{ status: 'completed', count: 3 }, { status: 'failed', count: 1 }, { status: 'planned', count: 1 }, { status: 'reversed', count: 1 }]);
  });

  it('date boundaries are inclusive on both ends and exclude the day before and the day after', async () => {
    await sa.order({ date: '2026-09-30', currency: 'EUR', total: '1.00' });
    await sa.order({ date: '2026-10-01', currency: 'EUR', total: '2.00' });
    await sa.order({ date: '2026-10-31', currency: 'EUR', total: '4.00' });
    await sa.order({ date: '2026-11-01', currency: 'EUR', total: '8.00' });
    const f = await read(a, '2026-10-01', '2026-10-31');
    const eur = f.completedOrders.filter((r) => r.currency === 'EUR');
    expect(eur.map((r) => [r.date, r.amount])).toEqual([['2026-10-01', '2.0000'], ['2026-10-31', '4.0000']]);
    expect((await read(a, '2026-10-31', '2026-10-31')).completedOrders.filter((r) => r.currency === 'EUR')).toEqual([{ date: '2026-10-31', currency: 'EUR', amount: '4.0000', count: 1 }]);
  });

  it('expenses are the items of APPROVED or PAID claims only, in the item currency; draft, submitted, rejected and cancelled claims are not counted', async () => {
    for (const status of ['approved', 'paid', 'draft', 'submitted', 'rejected', 'cancelled']) {
      await sa.expenseClaim({ status, currency: 'GBP', items: [{ date: '2026-10-10', amount: '10.00' }, { date: '2026-10-11', amount: '2.50' }] });
    }
    const f = await read(a, '2026-10-01', '2026-10-31');
    expect(f.expenseItems.filter((r) => r.currency === 'GBP')).toEqual([
      { date: '2026-10-10', currency: 'GBP', amount: '20.0000', count: 2 }, { date: '2026-10-11', currency: 'GBP', amount: '5.0000', count: 2 },
    ]);
  });

  it('an expense item whose currency is missing or differs from its claim is excluded and counted, never converted or guessed', async () => {
    const before = (await read(a, '2026-10-01', '2026-10-31')).expenseItemsExcludedForCurrency;
    await sa.expenseClaim({ status: 'approved', currency: 'CHF', items: [{ date: '2026-10-12', amount: '5.00', currency: 'USD' }, { date: '2026-10-12', amount: '6.00', currency: 'EUR' }, { date: '2026-10-12', amount: '7.00' }] });
    const f = await read(a, '2026-10-01', '2026-10-31');
    expect(f.expenseItemsExcludedForCurrency).toBe(before + 2);      // the column is NOT NULL, so a conflicting code is the only way an item can disagree with its claim
    expect(f.expenseItems.filter((r) => r.currency === 'CHF')).toEqual([{ date: '2026-10-12', currency: 'CHF', amount: '7.0000', count: 1 }]);
    expect(f.expenseItems.filter((r) => r.date === '2026-10-12' && (r.currency === 'USD' || r.currency === 'EUR'))).toEqual([]);   // not counted under the item currency either
  });

  it('goods received are valued per line at quantity x unit cost in the cost currency; lines without a cost are counted and not valued', async () => {
    const before = (await read(a, '2026-10-01', '2026-10-31')).goodsReceivedWithoutCost;
    await sa.receipt({ receivedAt: '2026-10-15T23:30:00Z', currency: 'SEK', lines: [{ quantity: '3', unitCost: '2.5000' }, { quantity: '1', unitCost: null }] });
    await sa.receipt({ receivedAt: '2026-10-16T00:00:00Z', currency: 'SEK', lines: [{ quantity: '2', unitCost: '1.0000' }] });
    const f = await read(a, '2026-10-01', '2026-10-31');
    expect(f.goodsReceived.filter((r) => r.currency === 'SEK')).toEqual([
      { date: '2026-10-15', currency: 'SEK', amount: '7.5000', count: 1 }, { date: '2026-10-16', currency: 'SEK', amount: '2.0000', count: 1 },
    ]);
    expect(f.goodsReceivedWithoutCost).toBe(before + 1);
  });

  describe('cost of sales has evidence only where it is provable', () => {
    it('a line whose whole quantity is issued with a unit cost in the order currency is evidence; the cost is quantity x unit cost', async () => {
      const o = await sa.order({ date: '2026-10-20', currency: 'NOK', total: '30.00', lines: [{ quantity: '2' }, { quantity: '1' }] });
      await sa.movement({ type: 'issue', quantity: '2', unitCost: '4.0000', currency: 'NOK', orderLineId: o.lineIds[0] });
      await sa.movement({ type: 'issue', quantity: '1', unitCost: '7.5000', currency: 'NOK', orderLineId: o.lineIds[1] });
      const nok = (await read(a, '2026-10-20', '2026-10-20')).costOfSales.find((c) => c.currency === 'NOK');
      expect(nok).toEqual({ currency: 'NOK', saleLines: 2, saleLinesWithCostEvidence: 2, evidencedCost: '15.5000' });
    });
    it('a partial issue, a missing cost, a cost in another currency, or a return referencing the line each leave that line without evidence', async () => {
      const o = await sa.order({ date: '2026-10-21', currency: 'DKK', total: '40.00', lines: [{ quantity: '4' }, { quantity: '2' }, { quantity: '1' }, { quantity: '1' }, { quantity: '5' }] });
      await sa.movement({ type: 'issue', quantity: '3', unitCost: '1.0000', currency: 'DKK', orderLineId: o.lineIds[0] });     // partial: 3 of 4
      await sa.movement({ type: 'issue', quantity: '2', orderLineId: o.lineIds[1] });                                         // no cost
      await sa.movement({ type: 'issue', quantity: '1', unitCost: '1.0000', currency: 'EUR', orderLineId: o.lineIds[2] });     // wrong currency
      await sa.movement({ type: 'issue', quantity: '1', unitCost: '2.0000', currency: 'DKK', orderLineId: o.lineIds[3] });     // evidenced ...
      await sa.movement({ type: 'return', quantity: '1', unitCost: '2.0000', currency: 'DKK', orderLineId: o.lineIds[3] });    // ... but a return references it
      await sa.movement({ type: 'issue', quantity: '5', unitCost: '3.0000', currency: 'DKK', orderLineId: o.lineIds[4] });     // the one evidenced line
      const dkk = (await read(a, '2026-10-21', '2026-10-21')).costOfSales.find((c) => c.currency === 'DKK');
      expect(dkk).toEqual({ currency: 'DKK', saleLines: 5, saleLinesWithCostEvidence: 1, evidencedCost: '15.0000' });
    });
    it('discount lines are not sale lines, and a line with no movement at all has no evidence', async () => {
      const o = await sa.order({ date: '2026-10-22', currency: 'PLN', total: '8.00', lines: [{ quantity: '1' }, { quantity: '1', type: 'discount', total: '-2.00' }] });
      void o;
      const pln = (await read(a, '2026-10-22', '2026-10-22')).costOfSales.find((c) => c.currency === 'PLN');
      expect(pln).toEqual({ currency: 'PLN', saleLines: 1, saleLinesWithCostEvidence: 0, evidencedCost: '0.0000' });
    });
    it('only orders completed within the period count as sales, and movements of other lines never leak in', async () => {
      const open = await sa.order({ date: '2026-10-23', currency: 'CZK', total: '5.00', status: 'planned', lines: [{ quantity: '1' }] });
      await sa.movement({ type: 'issue', quantity: '1', unitCost: '1.0000', currency: 'CZK', orderLineId: open.lineIds[0] });
      expect((await read(a, '2026-10-23', '2026-10-23')).costOfSales.find((c) => c.currency === 'CZK')).toBeUndefined();
    });
  });

  it('indicators are the latest RECORDED value per metric whose period lies inside the range, reported as recorded', async () => {
    await sa.indicator({ code: 'otd', name: 'On-time delivery', start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z', value: '90', target: '95', variance: '-5' });
    await sa.indicator({ code: 'otd', name: 'On-time delivery', start: '2026-10-08T00:00:00Z', end: '2026-10-15T00:00:00Z', value: '97.5', target: '95', variance: '2.5' });
    await sa.indicator({ code: 'otd', start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z', value: '10' });
    const f = await read(a, '2026-10-01', '2026-10-31');
    expect(f.indicators.filter((i) => i.metricCode === 'otd')).toEqual([{
      metricCode: 'otd', metricName: 'On-time delivery', category: 'sales', unit: '%', value: '97.5', target: '95', variance: '2.5',   // recorded as stored (an indicator is not money)
     
      periodStart: '2026-10-08T00:00:00Z', periodEnd: '2026-10-15T00:00:00Z',
    }]);
  });

  describe('isolation', () => {
    it('another business in the SAME workspace sees none of these facts', async () => {
      const sSib = new Seeder(admin, sibling);
      await sSib.order({ date: '2026-10-05', currency: 'USD', total: '1.00' });
      const f = await read(sibling, '2026-10-01', '2026-10-31');
      expect(f.completedOrders).toEqual([{ date: '2026-10-05', currency: 'USD', amount: '1.0000', count: 1 }]);
      expect(f.expenseItems).toEqual([]); expect(f.goodsReceived).toEqual([]); expect(f.costOfSales).toEqual([]);
    });
    it('another TENANT sees nothing of tenant A, even when it asks for tenant A business id', async () => {
      const f = await repo.read(ctxOf(b), a.businessId, '2026-10-01', '2026-10-31');
      expect(f).toEqual({ completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [] });
    });
    it('tenant B own facts never include tenant A rows', async () => {
      await new Seeder(admin, b).order({ date: '2026-10-05', currency: 'USD', total: '3.00' });
      expect((await read(b, '2026-10-01', '2026-10-31')).completedOrders).toEqual([{ date: '2026-10-05', currency: 'USD', amount: '3.0000', count: 1 }]);
    });
  });

  it('an invalid business id or date yields empty facts, never a database error', async () => {
    const empty = { completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [] };
    expect(await repo.read(ctxOf(a), 'not-a-uuid', '2026-10-01', '2026-10-31')).toEqual(empty);
    expect(await read(a, '2026-13-01', '2026-10-31')).toEqual(empty);
    expect(await read(a, '2026-10-31', '2026-10-01')).toEqual(empty);
  });

  it('reading changes no row in any table it touches', async () => {
    const tables = ['platform.orders', 'business_operations.order_line_items', 'business_operations.expense_claims', 'business_operations.expense_items', 'business_operations.purchase_receipts',
      'business_operations.purchase_receipt_lines', 'business_operations.inventory_movements', 'business_operations.operational_performance_records'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [a.tenantId])).rows[0].n)));
    const before = await snap();
    const stamp = (await admin.query(`SELECT max(updated_at) m FROM platform.orders WHERE tenant_id = $1`, [a.tenantId])).rows[0].m;
    await read(a, '2026-01-01', '2026-12-31'); await read(a, '2026-10-01', '2026-10-31');
    expect(await snap()).toEqual(before);
    expect((await admin.query(`SELECT max(updated_at) m FROM platform.orders WHERE tenant_id = $1`, [a.tenantId])).rows[0].m).toEqual(stamp);
  });
});
