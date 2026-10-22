/**
 * BI-SALES-1 - SalesFactsRepository (Business Operations' read-only sales facts) against a live PostgreSQL (application role, RLS enforced).
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (superuser fixtures). Every order goes through the real OrderRepository
 * (create, add lines, discount, complete, void), so the figures are the ones the platform itself stores.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- query rows are untyped in this live-database proof */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { OrderRepository } from '../src/repositories/bo/OrderRepository.js';
import { RegisterSessionRepository } from '../src/repositories/bo/RegisterSessionRepository.js';
import { SalesFactsRepository } from '../src/repositories/bo/SalesFactsRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const D1 = '2026-03-10';
const D2 = '2026-03-11';
const D3 = '2026-03-20';

describe.runIf(run)('SalesFactsRepository - live PostgreSQL', () => {
  let admin: Pool;
  const repo = new SalesFactsRepository();
  const orders = new OrderRepository();
  const registers = new RegisterSessionRepository();
  interface World { ctx: TenantContext; t: string; ws: string; biz: string }
  let w: World; let sibling: string; let foreign: World; const tenants: string[] = [];

  async function declare(world: { t: string; ws: string; biz: string }, version: number, currency: string, prior?: string) {
    await admin.query(
      `INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, supersedes_version, prior_declared_currency, reason, provenance, declared_by_user_id, permission_used, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'EXPLICIT_DECLARATION',$9,'platform:admin',$10)`,
      [world.t, world.ws, world.biz, version, currency, version > 1 ? version - 1 : null, prior ?? null, version > 1 ? 'test: the business changed its currency' : null, randomUUID(), randomUUID()]);
  }
  async function makeWorld(currency: string): Promise<World> {
    const t = randomUUID(); const ws = randomUUID(); const biz = randomUUID(); const user = randomUUID();
    tenants.push(t);
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Sales facts',$2,'active','test')`, [t, `sf-${t}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ws, t, `ws-${ws}`]);
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Sales Biz',$4,'active')`, [biz, t, ws, `sf-${biz}`]);
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1,$2)`, [user, `sf-${user}@example.test`]);
    await declare({ t, ws, biz }, 1, currency);
    const ctx: TenantContext = { tenantId: t, workspaceId: ws, userId: user };
    await registers.open(ctx, { businessId: biz, openingCash: 0 });
    return { ctx, t, ws, biz };
  }
  async function addBusiness(world: World): Promise<string> {
    const biz = randomUUID();
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Sibling',$4,'active')`, [biz, world.t, world.ws, `sf-${biz}`]);
    await declare({ t: world.t, ws: world.ws, biz }, 1, 'KWD');
    await registers.open(world.ctx, { businessId: biz, openingCash: 0 });
    return biz;
  }
  const dated = (id: string, date: string) => admin.query('UPDATE platform.orders SET order_date = $2 WHERE id = $1', [id, date]);
  type Line = { description: string; quantity: number; unitPrice: number; itemType?: 'product' | 'fee' };
  async function sale(world: World, biz: string, lines: Line[], date: string, outcome: 'completed' | 'voided' | 'open', discount = 0): Promise<string> {
    let order = await orders.create(world.ctx, { businessId: biz });
    for (const l of lines) order = await orders.addLineItem(world.ctx, order.id, biz, l);
    if (discount > 0) order = await orders.addDiscount(world.ctx, order.id, biz, { amount: discount, reason: 'test' });
    if (outcome === 'completed') order = await orders.complete(world.ctx, order.id, biz, [{ method: 'cash', amountTendered: order.totalAmount + 1 }]);
    if (outcome === 'voided') order = await orders.void(world.ctx, order.id, biz, 'test');
    await dated(order.id, date);
    return order.id;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL! });
    w = await makeWorld('KWD');
    foreign = await makeWorld('KWD');
    sibling = await addBusiness(w);
    // business under test (KWD)
    await sale(w, w.biz, [{ description: 'Coffee', quantity: 2, unitPrice: 1.5 }], D1, 'completed');                                                    // 3.000
    await sale(w, w.biz, [{ description: 'Tea', quantity: 1, unitPrice: 2 }, { description: 'Service', quantity: 1, unitPrice: 0.25, itemType: 'fee' }], D1, 'completed', 0.5); // gross 2.250 disc 0.500 net 1.750
    await sale(w, w.biz, [{ description: 'Void me', quantity: 1, unitPrice: 9 }], D1, 'voided');
    await sale(w, w.biz, [{ description: 'Still open', quantity: 1, unitPrice: 4 }], D2, 'open');
    await sale(w, w.biz, [{ description: 'Later', quantity: 1, unitPrice: 7 }], D3, 'completed');
    // a different currency in the same business: the declaration is versioned, the register is reopened in the new currency
    const open = await registers.getOpen(w.ctx, w.biz);
    await registers.close(w.ctx, open!.id, { closingCash: 0 }, w.biz);
    await declare(w, 2, 'JPY', 'KWD');
    await registers.open(w.ctx, { businessId: w.biz, openingCash: 0 });
    await sale(w, w.biz, [{ description: 'Ramen', quantity: 3, unitPrice: 500 }], D1, 'completed');                                                      // 1500 JPY
    // another business in the same workspace and another tenant: must never leak in
    await sale(w, sibling, [{ description: 'Sibling sale', quantity: 1, unitPrice: 100 }], D1, 'completed');
    await sale(foreign, foreign.biz, [{ description: 'Foreign sale', quantity: 1, unitPrice: 50 }], D1, 'completed');
  }, 60_000);

  afterAll(async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      for (const tbl of ['business_operations.order_payments', 'business_operations.order_line_items', 'platform.orders', 'business_operations.register_sessions',
        'platform.business_currency_declarations', 'platform.businesses', 'tenancy.workspaces']) {
        await c.query(`DELETE FROM ${tbl} WHERE tenant_id = ANY($1)`, [tenants]);
      }
      await c.query('DELETE FROM tenancy.tenants WHERE id = ANY($1)', [tenants]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    await admin.end(); await closePool();
  });

  it('aggregates per day and currency with exact decimal strings: sales are completed orders; void and open orders are counted, not summed', async () => {
    const rows = await repo.byDayAndCurrency(w.ctx, w.biz, D1, D2);
    expect(rows).toEqual([
      { orderDate: D1, currencyCode: 'JPY', completedOrders: 1, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossAmount: '1500.0000', discountAmount: '0.0000', netAmount: '1500.0000' },
      { orderDate: D1, currencyCode: 'KWD', completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossAmount: '5.2500', discountAmount: '0.5000', netAmount: '4.7500' },
      { orderDate: D2, currencyCode: 'KWD', completedOrders: 0, voidedOrders: 0, openOrders: 1, otherStatusOrders: 0, grossAmount: '0.0000', discountAmount: '0.0000', netAmount: '0.0000' },
    ]);
  });

  it('gross - discounts = net for every completed day (the figures reconcile)', async () => {
    for (const r of await repo.byDayAndCurrency(w.ctx, w.biz, D1, D3)) {
      expect(Number(r.grossAmount) - Number(r.discountAmount)).toBeCloseTo(Number(r.netAmount), 4);
    }
  });

  it('the period is an inclusive range of order dates: a day outside it is not read, both ends are included', async () => {
    expect((await repo.byDayAndCurrency(w.ctx, w.biz, D2, D2)).map((r) => r.orderDate)).toEqual([D2]);
    expect((await repo.byDayAndCurrency(w.ctx, w.biz, D1, D1)).map((r) => r.orderDate)).toEqual([D1, D1]);
    expect((await repo.byDayAndCurrency(w.ctx, w.biz, D3, D3)).map((r) => r.netAmount)).toEqual(['7.0000']);
    expect(await repo.byDayAndCurrency(w.ctx, w.biz, '2026-01-01', '2026-01-31')).toEqual([]);
  });

  it('business isolation: another business in the same workspace is never included', async () => {
    const mine = await repo.byDayAndCurrency(w.ctx, w.biz, D1, D1);
    expect(mine.some((r) => r.netAmount === '100.0000')).toBe(false);
    const sib = await repo.byDayAndCurrency(w.ctx, sibling, D1, D1);
    expect(sib).toEqual([{ orderDate: D1, currencyCode: 'KWD', completedOrders: 1, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossAmount: '100.0000', discountAmount: '0.0000', netAmount: '100.0000' }]);
  });

  it('tenant isolation (RLS): another tenant sees nothing of this business, and its own sales stay its own', async () => {
    expect(await repo.byDayAndCurrency(foreign.ctx, w.biz, D1, D3)).toEqual([]);
    const own = await repo.byDayAndCurrency(foreign.ctx, foreign.biz, D1, D1);
    expect(own.map((r) => r.netAmount)).toEqual(['50.0000']);
    expect(await repo.byDayAndCurrency(w.ctx, foreign.biz, D1, D3)).toEqual([]);
  });

  it('fails closed without a usable tenant scope', async () => {
    const stranger: TenantContext = { tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() };
    expect(await repo.byDayAndCurrency(stranger, w.biz, D1, D3)).toEqual([]);
  });

  it('is read-only: reading changes no order, line or payment row', async () => {
    const snapshot = async () => (await admin.query(`SELECT (SELECT count(*) FROM platform.orders WHERE tenant_id = ANY($1))::int AS o,
      (SELECT count(*) FROM business_operations.order_line_items WHERE tenant_id = ANY($1))::int AS l,
      (SELECT COALESCE(sum(version),0) FROM platform.orders WHERE tenant_id = ANY($1))::int AS v`, [tenants])).rows[0];
    const before = await snapshot();
    await repo.byDayAndCurrency(w.ctx, w.biz, D1, D3);
    expect(await snapshot()).toEqual(before);
  });
});
