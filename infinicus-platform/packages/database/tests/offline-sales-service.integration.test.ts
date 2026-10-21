/**
 * OFF-1 step 3 - OfflineSaleRepository against a live PostgreSQL (application role, RLS enforced).
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (superuser fixtures / inspection), migrated through 0210.
 * Every sale goes through the real OrderRepository (create, add lines, complete), so the online rules and the payments-equal-total trigger apply.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- query rows are untyped in this live-database proof */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { ConflictError } from '../src/repositories/bo/errors.js';
import { OfflineSaleRepository } from '../src/repositories/bo/OfflineSaleRepository.js';
import { OrderRepository } from '../src/repositories/bo/OrderRepository.js';
import { ProductRepository } from '../src/repositories/bo/ProductRepository.js';
import { RegisterSessionRepository } from '../src/repositories/bo/RegisterSessionRepository.js';
import { OFFLINE_MAX_AGE_SECONDS, OfflineSaleRequestError, type OfflineSaleConfig, type OfflineSaleRequest } from '../src/repositories/bo/offlineSale.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const NOW = new Date();
const DEVICE_AT = new Date(NOW.getTime() - 10 * 60_000);
const SNAPSHOT = new Date(NOW.getTime() - 60 * 60_000);
const CHANGED_AFTER_SNAPSHOT = new Date(NOW.getTime() - 30 * 60_000);
const CONFIG: OfflineSaleConfig = { maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS, futureToleranceSeconds: 300, driftLimitMinorByCurrency: { KWD: 500 } };

describe.runIf(run)('OfflineSaleRepository - live PostgreSQL', () => {
  let admin: Pool;
  const svc = new OfflineSaleRepository(undefined, undefined, () => NOW);
  const products = new ProductRepository();
  const registers = new RegisterSessionRepository();
  const orders = new OrderRepository();

  interface World { ctx: TenantContext; t: string; ws: string; biz: string; session: string }
  let w: World; let other: World; const tenants: string[] = [];

  async function declare(world: { t: string; ws: string; biz: string }, currency: string) {
    await admin.query(
      `INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id)
       VALUES ($1,$2,$3,1,$4,'EXPLICIT_DECLARATION',$5,'platform:admin',$6)`, [world.t, world.ws, world.biz, currency, randomUUID(), randomUUID()]);
  }
  async function makeWorld(currency = 'KWD', open = true): Promise<World> {
    const t = randomUUID(); const ws = randomUUID(); const biz = randomUUID(); const user = randomUUID();
    tenants.push(t);
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Offline svc',$2,'active','test')`, [t, `os-${t}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ws, t, `ws-${ws}`]);
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Off Biz',$4,'active')`, [biz, t, ws, `os-${biz}`]);
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1,$2)`, [user, `os-${user}@example.test`]);
    await declare({ t, ws, biz }, currency);
    const ctx: TenantContext = { tenantId: t, workspaceId: ws, userId: user };
    let session = '';
    if (open) {
      session = (await registers.open(ctx, { businessId: biz, openingCash: 0 })).id;
      // the register was opened hours ago, before the offline sales made on the device
      await admin.query('UPDATE business_operations.register_sessions SET opened_at = $2 WHERE id = $1', [session, new Date(NOW.getTime() - 3 * 3_600_000)]);
    }
    return { ctx, t, ws, biz, session };
  }
  /** A catalogue product; `changedAt` sets updated_at directly (the trigger is bypassed for this one superuser statement). */
  async function product(world: World, price: number, opts: { changedAt?: Date; active?: boolean; name?: string } = {}): Promise<string> {
    const p = await products.create(world.ctx, { businessId: world.biz, name: opts.name ?? `Item ${randomUUID().slice(0, 4)}`, price });
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query('UPDATE business_operations.products SET updated_at = $2, active = $3 WHERE id = $1', [p.id, opts.changedAt ?? new Date(NOW.getTime() - 2 * 3_600_000), opts.active ?? true]);
      await c.query('COMMIT');
    } finally { c.release(); }
    return p.id;
  }
  const sale = (world: World, lines: Array<[string, number, number]>, over: Partial<OfflineSaleRequest> = {}, cash?: number): OfflineSaleRequest => {
    const total = lines.reduce((s, [, q, u]) => s + q * u, 0);
    return {
      clientSaleId: randomUUID(), deviceId: 'tablet-1', registerSessionId: world.session, deviceCreatedAt: DEVICE_AT, catalogueSnapshotAt: SNAPSHOT, currencyCode: 'KWD',
      lines: lines.map(([productId, quantity, unitPriceShownMinor]) => ({ productId, quantity, unitPriceShownMinor })), provisionalTotalMinor: total,
      tenders: [{ method: 'cash', amountTenderedMinor: cash ?? total }], ...over,
    };
  };
  const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
  const ordersFor = (world: World) => count('SELECT count(*) n FROM platform.orders WHERE business_id = $1', [world.biz]);
  const salesFor = (world: World) => count('SELECT count(*) n FROM business_operations.offline_sales WHERE business_id = $1', [world.biz]);
  const eventsFor = (world: World) => count(`SELECT count(*) n FROM business_operations.business_events WHERE business_id = $1 AND event_type = 'sale'`, [world.biz]);

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    w = await makeWorld(); other = await makeWorld();
  });
  afterAll(async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      for (const tbl of ['business_operations.offline_sales', 'business_operations.order_payments', 'business_operations.order_events', 'business_operations.business_events',
        'business_operations.order_line_items', 'platform.orders', 'business_operations.register_sessions', 'business_operations.products',
        'platform.business_currency_declarations', 'platform.businesses', 'tenancy.workspaces']) {
        await c.query(`DELETE FROM ${tbl} WHERE tenant_id = ANY($1)`, [tenants]);
      }
      await c.query(`DELETE FROM identity.users WHERE email LIKE 'os-%@example.test'`);
      await c.query('DELETE FROM tenancy.tenants WHERE id = ANY($1)', [tenants]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    await closePool(); await admin.end();
  });

  describe('accepted', () => {
    it('completes an exact sale through the real order code and records everything', async () => {
      const a = await product(w, 1.5); const b = await product(w, 0.25);
      const req = sale(w, [[a, 2, 1500], [b, 3, 250]], {}, 5000);
      const r = await svc.process(w.ctx, w.biz, req, CONFIG);
      expect(r).toMatchObject({ outcome: 'accepted', replayed: false, deviceTotalMinor: 3750, serverTotalMinor: 3750, differenceMinor: 0, reviewReason: null, currencyCode: 'KWD' });
      expect(r.orderId).toMatch(/^[0-9a-f-]{36}$/); expect(r.orderNumber).toMatch(/^ORD-/);

      const o = (await admin.query('SELECT * FROM platform.orders WHERE id = $1', [r.orderId])).rows[0];
      expect(o).toMatchObject({ operational_status: 'completed', currency_code: 'KWD', client_sale_id: req.clientSaleId, register_session_id: w.session, business_id: w.biz });
      expect(Number(o.total_amount)).toBe(3.75);
      const lines = (await admin.query('SELECT unit_price, quantity, line_total FROM business_operations.order_line_items WHERE order_id = $1 ORDER BY line_number', [r.orderId])).rows;
      expect(lines.map((l) => [Number(l.unit_price), Number(l.quantity), Number(l.line_total)])).toEqual([[1.5, 2, 3], [0.25, 3, 0.75]]);
      const pay = (await admin.query('SELECT method, amount_tendered, amount_applied, change_given, register_session_id FROM business_operations.order_payments WHERE order_id = $1', [r.orderId])).rows;
      expect(pay).toHaveLength(1);
      expect(pay[0]).toMatchObject({ method: 'cash', register_session_id: w.session });
      expect([Number(pay[0].amount_tendered), Number(pay[0].amount_applied), Number(pay[0].change_given)]).toEqual([5, 3.75, 1.25]);
      expect(await eventsFor(w)).toBeGreaterThanOrEqual(1);

      const s = (await admin.query('SELECT * FROM business_operations.offline_sales WHERE id = $1', [r.offlineSaleId])).rows[0];
      expect(s).toMatchObject({ outcome: 'accepted', order_id: r.orderId, register_session_id: w.session, claimed_register_session_id: w.session, review_reason: null, device_id: 'tablet-1', created_by: w.ctx.userId });
      expect([Number(s.device_total_minor), Number(s.server_total_minor), Number(s.difference_minor)]).toEqual([3750, 3750, 0]);
      expect(s.request_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(s.lines_detail).toHaveLength(2);
      expect(s.lines_detail[0]).toMatchObject({ shown_unit_minor: 1500, server_unit_minor: 1500, used_unit_minor: 1500, drift: 'none' });
      expect(Number(s.clock_skew_seconds)).toBe(600);
      expect(new Date(s.received_at).getTime()).toBe(NOW.getTime());
    });

    it('a catalogue line carries the same provenance event an online line does', async () => {
      const a = await product(w, 2);
      const r = await svc.process(w.ctx, w.biz, sale(w, [[a, 1, 2000]]), CONFIG);
      const ev = (await admin.query(`SELECT payload FROM business_operations.order_events WHERE order_id = $1 AND event_type = 'note'`, [r.orderId])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toMatchObject({ kind: 'catalog_line_added', catalogProductId: a });
    });
  });

  describe('replay and idempotency', () => {
    it('returns the first answer for the same sale and creates nothing new', async () => {
      const a = await product(w, 1);
      const req = sale(w, [[a, 1, 1000]]);
      const first = await svc.process(w.ctx, w.biz, req, CONFIG);
      const ordersBefore = await ordersFor(w); const salesBefore = await salesFor(w);
      const again = await svc.process(w.ctx, w.biz, structuredClone({ ...req, deviceCreatedAt: req.deviceCreatedAt, catalogueSnapshotAt: req.catalogueSnapshotAt }), CONFIG);
      expect(again).toMatchObject({ replayed: true, offlineSaleId: first.offlineSaleId, orderId: first.orderId, orderNumber: first.orderNumber, outcome: 'accepted' });
      expect(await ordersFor(w)).toBe(ordersBefore); expect(await salesFor(w)).toBe(salesBefore);
    });

    it('replays a needs_review answer too, and refuses the same id with a different body', async () => {
      const a = await product(w, 1);
      const req = sale(w, [[a, 1, 1000]], {}, 999);   // underpaid
      const first = await svc.process(w.ctx, w.biz, req, CONFIG);
      expect(first).toMatchObject({ outcome: 'needs_review', reviewReason: 'underpaid', orderId: null });
      expect(await svc.process(w.ctx, w.biz, req, CONFIG)).toMatchObject({ replayed: true, outcome: 'needs_review', reviewReason: 'underpaid', offlineSaleId: first.offlineSaleId });
      const changed = { ...req, tenders: [{ method: 'cash' as const, amountTenderedMinor: 1000 }] };
      await expect(svc.process(w.ctx, w.biz, changed, CONFIG)).rejects.toThrow(/already used with a different request/);
      await expect(svc.process(w.ctx, w.biz, changed, CONFIG)).rejects.toBeInstanceOf(ConflictError);
    });

    it('concurrent duplicates produce exactly one order and one record', async () => {
      const a = await product(w, 1);
      const req = sale(w, [[a, 1, 1000]]);
      const ordersBefore = await ordersFor(w);
      const results = await Promise.all(Array.from({ length: 6 }, () => svc.process(w.ctx, w.biz, req, CONFIG)));
      expect(new Set(results.map((r) => r.offlineSaleId)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await ordersFor(w)).toBe(ordersBefore + 1);
      expect(await count('SELECT count(*) n FROM business_operations.offline_sales WHERE client_sale_id = $1', [req.clientSaleId])).toBe(1);
    });
  });

  describe('D4 price drift', () => {
    it('honours the shown price when the product changed after the snapshot and the difference is within the limit', async () => {
      const a = await product(w, 1.55, { changedAt: CHANGED_AFTER_SNAPSHOT });   // server now 1550; the customer saw 1500
      const r = await svc.process(w.ctx, w.biz, sale(w, [[a, 2, 1500]], {}, 3000), CONFIG);
      expect(r).toMatchObject({ outcome: 'accepted_with_difference', deviceTotalMinor: 3000, serverTotalMinor: 3100, differenceMinor: 100, reviewReason: null });
      const o = (await admin.query('SELECT total_amount FROM platform.orders WHERE id = $1', [r.orderId])).rows[0];
      expect(Number(o.total_amount)).toBe(3);                                      // the order carries the price the customer saw
      const line = (await admin.query('SELECT unit_price, line_total, product_id FROM business_operations.order_line_items WHERE order_id = $1', [r.orderId])).rows[0];
      expect([Number(line.unit_price), Number(line.line_total)]).toEqual([1.5, 3]);
      expect(line.product_id).toBeNull();                                          // same as an online catalogue line: no BO id in the canonical FK
      const ev = (await admin.query(`SELECT payload FROM business_operations.order_events WHERE order_id = $1 AND event_type = 'note'`, [r.orderId])).rows;
      expect(ev[0].payload).toMatchObject({ kind: 'catalog_line_added', offline: true, shownUnitMinor: 1500, serverUnitMinor: 1550, catalogProductId: a });
      const s = (await admin.query('SELECT lines_detail FROM business_operations.offline_sales WHERE id = $1', [r.offlineSaleId])).rows[0];
      expect(s.lines_detail[0]).toMatchObject({ drift: 'honoured', product_changed_after_snapshot: true, shown_unit_minor: 1500, server_unit_minor: 1550, used_unit_minor: 1500 });
    });

    it('sends a difference on an UNCHANGED product to review and creates no order', async () => {
      const a = await product(w, 1.55);   // updated_at before the snapshot
      const before = await ordersFor(w);
      const r = await svc.process(w.ctx, w.biz, sale(w, [[a, 2, 1500]], {}, 3000), CONFIG);
      expect(r).toMatchObject({ outcome: 'needs_review', reviewReason: 'price_drift_not_allowed', orderId: null, serverTotalMinor: 3100, differenceMinor: 100 });
      expect(await ordersFor(w)).toBe(before);
    });

    it('with no limit configured, or one that is too small, every difference goes to review', async () => {
      const a = await product(w, 1.55, { changedAt: CHANGED_AFTER_SNAPSHOT });
      for (const limits of [{}, { KWD: 0 }, { KWD: 99 }, { USD: 100000 }]) {
        const r = await svc.process(w.ctx, w.biz, sale(w, [[a, 2, 1500]], {}, 3000), { ...CONFIG, driftLimitMinorByCurrency: limits });
        expect(r).toMatchObject({ outcome: 'needs_review', reviewReason: 'price_drift_not_allowed' });
      }
    });

    it('honours a price the customer saw that is higher than the server now charges, and judges the cash against it', async () => {
      const a = await product(w, 1.45, { changedAt: CHANGED_AFTER_SNAPSHOT });
      const r = await svc.process(w.ctx, w.biz, sale(w, [[a, 2, 1500]], {}, 3000), CONFIG);
      expect(r).toMatchObject({ outcome: 'accepted_with_difference', serverTotalMinor: 2900, differenceMinor: -100 });
      expect(Number((await admin.query('SELECT total_amount FROM platform.orders WHERE id = $1', [r.orderId])).rows[0].total_amount)).toBe(3);
    });
  });

  describe('sales that cannot be completed are kept for review, with no order', () => {
    const review = async (req: OfflineSaleRequest, world: World, reason: string) => {
      const ordersBefore = await ordersFor(world); const eventsBefore = await eventsFor(world);
      const r = await svc.process(world.ctx, world.biz, req, CONFIG);
      expect(r).toMatchObject({ outcome: 'needs_review', reviewReason: reason, orderId: null, orderNumber: null });
      expect(await ordersFor(world)).toBe(ordersBefore); expect(await eventsFor(world)).toBe(eventsBefore);
      const s = (await admin.query('SELECT * FROM business_operations.offline_sales WHERE id = $1', [r.offlineSaleId])).rows[0];
      expect(s).toMatchObject({ outcome: 'needs_review', review_reason: reason, order_id: null, claimed_register_session_id: req.registerSessionId });
      return { r, s };
    };

    it('underpaid: the cash does not cover the order', async () => {
      const a = await product(w, 1);
      const { s } = await review(sale(w, [[a, 3, 1000]], {}, 2999), w, 'underpaid');
      expect(Number(s.server_total_minor)).toBe(3000);
    });
    it('an unknown, inactive or other-business product', async () => {
      const inactive = await product(w, 1, { active: false });
      const foreign = await product(other, 1);
      const ok = await product(w, 1);
      await review(sale(w, [[randomUUID(), 1, 1000]]), w, 'product_unavailable');
      await review(sale(w, [[inactive, 1, 1000]]), w, 'product_unavailable');
      await review(sale(w, [[ok, 1, 1000], [foreign, 1, 1000]]), w, 'product_unavailable');
    });
    it('a closed register session, an unknown session, a session of another business, and a currency mismatch', async () => {
      const closing = await makeWorld();
      const a = await product(closing, 1);
      await registers.close(closing.ctx, closing.session, { closingCash: 0 }, closing.biz);
      const { s } = await review(sale(closing, [[a, 1, 1000]]), closing, 'session_closed');
      expect(s.register_session_id).toBe(closing.session);   // the session is this business's, so it is recorded as verified
      const b = await product(w, 1);
      const unknown = await review(sale(w, [[b, 1, 1000]], { registerSessionId: randomUUID() }), w, 'session_not_found');
      expect(unknown.s.register_session_id).toBeNull();
      const foreignSession = await review(sale(w, [[b, 1, 1000]], { registerSessionId: other.session }), w, 'session_not_found');
      expect(foreignSession.s.register_session_id).toBeNull();
      await review(sale(w, [[b, 1, 1000]], { currencyCode: 'USD' }), w, 'session_currency_mismatch');
    });
    it('a sale that predates the register session it claims', async () => {
      const fresh = await makeWorld();
      const a = await product(fresh, 1);
      const req = sale(fresh, [[a, 1, 1000]], { deviceCreatedAt: new Date(NOW.getTime() - 20 * 3_600_000), catalogueSnapshotAt: new Date(NOW.getTime() - 21 * 3_600_000) });
      await review(req, fresh, 'invariant_failed');
    });
    it('a catalogue price that is not an exact number of minor units', async () => {
      const a = await product(w, 1.2345);   // 1.2345 KWD is not a whole number of fils
      await review(sale(w, [[a, 1, 1235]]), w, 'invariant_failed');
    });
  });

  describe('failures after planning roll the order back and are recorded', () => {
    it('an order step that refuses leaves no order, no payment and no sale event', async () => {
      const a = await product(w, 1);
      class RefusingComplete extends OrderRepository { override async complete(): Promise<never> { throw new ConflictError('Order', 'refused for the test'); } }
      const failing = new OfflineSaleRepository(new RefusingComplete(), undefined, () => NOW);
      const before = { orders: await ordersFor(w), events: await eventsFor(w), pays: await count('SELECT count(*) n FROM business_operations.order_payments WHERE business_id = $1', [w.biz]) };
      const r = await failing.process(w.ctx, w.biz, sale(w, [[a, 1, 1000]]), CONFIG);
      expect(r).toMatchObject({ outcome: 'needs_review', reviewReason: 'invariant_failed', orderId: null });
      expect(await ordersFor(w)).toBe(before.orders); expect(await eventsFor(w)).toBe(before.events);
      expect(await count('SELECT count(*) n FROM business_operations.order_payments WHERE business_id = $1', [w.biz])).toBe(before.pays);
      expect(await count('SELECT count(*) n FROM platform.orders WHERE client_sale_id IS NOT NULL AND business_id = $1 AND operational_status <> $2', [w.biz, 'completed'])).toBe(0);
    });
    it('an order total that differs from the integer plan is refused as an invariant failure, never recorded as a sale', async () => {
      const a = await product(w, 1);
      class WrongTotal extends OrderRepository {
        override async complete(...args: Parameters<OrderRepository['complete']>) { const o = await super.complete(...args); return { ...o, totalAmount: o.totalAmount + 0.001 }; }
      }
      const r = await new OfflineSaleRepository(new WrongTotal(), undefined, () => NOW).process(w.ctx, w.biz, sale(w, [[a, 1, 1000]]), CONFIG);
      expect(r).toMatchObject({ outcome: 'needs_review', reviewReason: 'invariant_failed', orderId: null });
      expect(await count(`SELECT count(*) n FROM platform.orders WHERE business_id = $1 AND client_sale_id = (SELECT client_sale_id FROM business_operations.offline_sales WHERE id = $2)`, [w.biz, r.offlineSaleId])).toBe(0);
    });
    it('an unexpected (non-domain) error surfaces and stores nothing', async () => {
      const a = await product(w, 1);
      class Boom extends OrderRepository { override async create(): Promise<never> { throw new Error('boom'); } }
      const req = sale(w, [[a, 1, 1000]]);
      const before = await salesFor(w);
      await expect(new OfflineSaleRepository(new Boom(), undefined, () => NOW).process(w.ctx, w.biz, req, CONFIG)).rejects.toThrow('boom');
      expect(await salesFor(w)).toBe(before);
      expect((await svc.process(w.ctx, w.biz, req, CONFIG)).outcome).toBe('accepted');   // and the same sale can still be sent afterwards
    });
  });

  describe('the door stores nothing', () => {
    it('refuses an old sale, a future clock, a bad total and non-cash with a ValidationError and writes no record', async () => {
      const a = await product(w, 1);
      const before = await salesFor(w);
      const tooOld = sale(w, [[a, 1, 1000]], { deviceCreatedAt: new Date(NOW.getTime() - (OFFLINE_MAX_AGE_SECONDS + 60) * 1000), catalogueSnapshotAt: new Date(NOW.getTime() - (OFFLINE_MAX_AGE_SECONDS + 600) * 1000) });
      await expect(svc.process(w.ctx, w.biz, tooOld, CONFIG)).rejects.toBeInstanceOf(OfflineSaleRequestError);
      await expect(svc.process(w.ctx, w.biz, sale(w, [[a, 1, 1000]], { deviceCreatedAt: new Date(NOW.getTime() + 3_600_000) }), CONFIG)).rejects.toThrow(/clock is ahead/);
      await expect(svc.process(w.ctx, w.biz, sale(w, [[a, 1, 1000]], { provisionalTotalMinor: 1 }), CONFIG)).rejects.toThrow(/provisional total/);
      await expect(svc.process(w.ctx, w.biz, sale(w, [[a, 1, 1000]], { tenders: [{ method: 'card' as any, amountTenderedMinor: 1000 }] }), CONFIG)).rejects.toThrow(/only cash/);
      expect(await salesFor(w)).toBe(before);
    });
    it('refuses to process a business without a declared currency', async () => {
      const bare = await makeWorld();
      await admin.query('DELETE FROM platform.business_currency_declarations WHERE business_id = $1', [bare.biz]).catch(async () => {
        const c = await admin.connect();
        try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM platform.business_currency_declarations WHERE business_id = $1', [bare.biz]); await c.query('COMMIT'); } finally { c.release(); }
      });
      const a = await product(bare, 1);
      const before = await salesFor(bare);
      await expect(svc.process(bare.ctx, bare.biz, sale(bare, [[a, 1, 1000]]), CONFIG)).rejects.toThrow(/no declared currency/);
      expect(await salesFor(bare)).toBe(before);
    });
  });

  describe('tenant isolation', () => {
    it('the same client_sale_id in two tenants is two independent sales, and a foreign business is not reachable', async () => {
      const a = await product(w, 1); const b = await product(other, 1);
      const id = randomUUID();
      const r1 = await svc.process(w.ctx, w.biz, sale(w, [[a, 1, 1000]], { clientSaleId: id }), CONFIG);
      const r2 = await svc.process(other.ctx, other.biz, sale(other, [[b, 1, 1000]], { clientSaleId: id }), CONFIG);
      expect(r1.outcome).toBe('accepted'); expect(r2.outcome).toBe('accepted');
      expect(r1.offlineSaleId).not.toBe(r2.offlineSaleId); expect(r1.orderId).not.toBe(r2.orderId);
      // tenant A's context aimed at tenant B's business cannot see its currency declaration, session or products
      await expect(svc.process(w.ctx, other.biz, sale(other, [[b, 1, 1000]], { clientSaleId: randomUUID() }), CONFIG)).rejects.toThrow(/no declared currency/);
    });
  });

  describe('online equivalence: the offline order totals what the online order totals', () => {
    it('for random baskets of fractional KWD prices, the order total and every line total match the online path to the fil', async () => {
      const onlineWorld = await makeWorld();
      let seed = 4242;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      for (let i = 0; i < 25; i += 1) {
        const n = 1 + Math.floor(rnd() * 4);
        const basket: Array<{ price: number; qty: number }> = Array.from({ length: n }, () => ({ price: Math.floor(rnd() * 90_000) / 1000, qty: 1 + Math.floor(rnd() * 9) }));
        const offlineIds: string[] = []; const onlineIds: string[] = [];
        for (const item of basket) { offlineIds.push(await product(w, item.price)); onlineIds.push(await product(onlineWorld, item.price)); }
        const shown = basket.map((x) => Math.round(x.price * 1000));
        const total = basket.reduce((s, x, k) => s + x.qty * shown[k], 0);
        const off = await svc.process(w.ctx, w.biz, sale(w, basket.map((x, k) => [offlineIds[k], x.qty, shown[k]] as [string, number, number]), {}, total + 1000), CONFIG);
        expect(off.outcome, JSON.stringify(basket)).toBe('accepted');

        let order = await orders.create(onlineWorld.ctx, { businessId: onlineWorld.biz });
        for (const [k, x] of basket.entries()) order = await orders.addLineItem(onlineWorld.ctx, order.id, onlineWorld.biz, { catalogProductId: onlineIds[k], quantity: x.qty });
        const done = await orders.complete(onlineWorld.ctx, order.id, onlineWorld.biz, [{ method: 'cash', amountTendered: (total + 1000) / 1000 }]);
        const offOrder = (await admin.query('SELECT total_amount FROM platform.orders WHERE id = $1', [off.orderId])).rows[0];
        expect(Number(offOrder.total_amount), JSON.stringify(basket)).toBe(done.totalAmount);
        const offLines = (await admin.query('SELECT line_total FROM business_operations.order_line_items WHERE order_id = $1 ORDER BY line_number', [off.orderId])).rows.map((r) => Number(r.line_total));
        expect(offLines).toEqual(done.lineItems.map((l) => l.lineTotal));
        await registers.close(onlineWorld.ctx, onlineWorld.session, { closingCash: 0 }, onlineWorld.biz).catch(() => undefined);
        onlineWorld.session = (await registers.open(onlineWorld.ctx, { businessId: onlineWorld.biz, openingCash: 0 })).id;
      }
    });
  });

  describe('row-level security on what the service wrote', () => {
    it('the application role sees only its own tenant\'s offline sales', async () => {
      const app = new Pool({ connectionString: process.env.DATABASE_URL! });
      try {
        const c = await app.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [other.t, other.ws]);
          const rows = (await c.query('SELECT DISTINCT tenant_id FROM business_operations.offline_sales')).rows.map((r) => r.tenant_id);
          expect(rows).toEqual([other.t]);
        } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
      } finally { await app.end(); }
    });
  });
});
