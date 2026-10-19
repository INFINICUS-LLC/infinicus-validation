import { describe, it, expect } from 'vitest';
import { ApiContractError, ApiError, ApiUnavailableError, SessionExpiredError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { COMPLETE_CONFLICT, VOID_CONFLICT, VOID_REASON_MAX, OrderSession, openOrdersPath } from '../lib/client/orders';
import { orderListSchema, orderSchema, type Order, type Product } from '../lib/client/schemas';

const scope: Scope = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222' };
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (n: number, over: Partial<Product> = {}): Product => ({ id: uuid(n), name: `Item ${n}`, price: n + 0.5, category: 'other', icon: null, active: true, sortOrder: 0, ...over });

interface Call { method: 'GET' | 'POST' | 'DELETE'; path: string; body: unknown; key: string | undefined; scope: Scope | undefined }

/** In-memory stand-in for the orders API: totals are computed HERE (the server's job), and a repeated Idempotency-Key replays the first answer like the real server. */
class FakeOrdersApi implements ApiClient {
  calls: Call[] = [];
  order: Order | null = null;
  private replays = new Map<string, Order>();
  /** Fail the next N matching requests (before or after applying) with this error; `applied` = the server applied it but the answer was lost. */
  failNext: { error: Error; applied: boolean; times: number } | null = null;
  gate: Promise<void> | null = null;
  private seq = 0;

  private snapshot(): Order { return JSON.parse(JSON.stringify(this.order)) as Order; }
  private recompute(): void { this.order!.totalAmount = Math.round(this.order!.lineItems.reduce((t, l) => t + l.lineTotal, 0) * 100) / 100; }

  private async handle(method: Call['method'], path: string, init: RequestInitLite<unknown> = {}): Promise<unknown> {
    this.calls.push({ method, path, body: init.body, key: init.idempotencyKey, scope: init.scope });
    if (this.gate) await this.gate;
    if (method !== 'GET') {
      const replay = init.idempotencyKey ? this.replays.get(init.idempotencyKey) : undefined;
      if (replay) return JSON.parse(JSON.stringify(replay));
    }
    const fail = this.failNext && this.failNext.times > 0 ? this.failNext : null;
    if (fail && !fail.applied) { fail.times -= 1; throw fail.error; }
    const result = this.apply(method, path, init.body);
    if (method !== 'GET' && init.idempotencyKey) this.replays.set(init.idempotencyKey, JSON.parse(JSON.stringify(result)));
    if (fail && fail.applied) { fail.times -= 1; throw fail.error; }
    return result;
  }

  private apply(method: Call['method'], path: string, body: unknown): Order {
    if (method === 'POST' && /\/orders$/.test(path)) {
      this.order = { id: uuid(900), businessId: BUSINESS, customerId: null, orderNumber: 'ORD-TEST', orderDate: '2026-10-18', currencyCode: 'KWD', totalAmount: 0, operationalStatus: 'planned', createdAt: 'x', updatedAt: 'x', lineItems: [] };
    } else if (method === 'POST' && /\/line-items$/.test(path)) {
      const b = body as { description: string; quantity: number; unitPrice: number; productId?: string; itemType?: string };
      this.order!.lineItems.push({ id: uuid(1000 + ++this.seq), lineNumber: this.seq, itemType: b.itemType ?? 'product', productId: b.productId ?? null, description: b.description, quantity: b.quantity, unitPrice: b.unitPrice, lineTotal: Math.round(b.quantity * b.unitPrice * 100) / 100 });
      this.recompute();
    } else if (method === 'POST' && /\/complete$/.test(path)) {
      if (this.order!.operationalStatus !== 'planned' || this.order!.lineItems.length === 0) throw new ApiError(409, 'X', 'x');
      this.order!.operationalStatus = 'completed';
    } else if (method === 'POST' && /\/void$/.test(path)) {
      if (this.order!.operationalStatus !== 'planned') throw new ApiError(409, 'X', 'x');
      this.order!.operationalStatus = 'failed';
    } else if (method === 'DELETE') {
      const id = path.split('/').pop();
      this.order!.lineItems = this.order!.lineItems.filter((l) => l.id !== id);
      this.recompute();
    }
    return this.snapshot();
  }

  get = <T>(path: string, init?: RequestInitLite<T>) => this.handle('GET', path, init as RequestInitLite<unknown>) as Promise<T>;
  post = <T>(path: string, init?: RequestInitLite<T>) => this.handle('POST', path, init as RequestInitLite<unknown>) as Promise<T>;
  delete = <T>(path: string, init?: RequestInitLite<T>) => this.handle('DELETE', path, init as RequestInitLite<unknown>) as Promise<T>;
}

function setup() {
  const api = new FakeOrdersApi();
  let n = 0;
  const session = new OrderSession(api, scope, BUSINESS, () => `key-${++n}`);
  return { api, session };
}
const apiError = (status: number) => new ApiError(status, 'X', 'x');

describe('order session (POS-2): server-owned orders, one action at a time, safe retries', () => {
  it('the order schemas accept the API shape and reject drift', () => {
    const order = { id: uuid(1), businessId: BUSINESS, customerId: null, orderNumber: 'ORD-1', orderDate: '2026-10-18', currencyCode: 'KWD', totalAmount: 7.5, operationalStatus: 'planned', createdAt: 'a', updatedAt: 'b', lineItems: [] };
    expect(orderSchema.safeParse(order).success).toBe(true);
    expect(orderListSchema.safeParse({ orders: [order] }).success).toBe(true);
    expect(orderSchema.safeParse({ ...order, totalAmount: '7.5' }).success).toBe(false);
    expect(orderSchema.safeParse({ ...order, currencyCode: 'kwd' }).success).toBe(false);
    const { currencyCode: _c, ...noCurrency } = order;
    expect(orderSchema.safeParse(noCurrency).success).toBe(false);
    expect(orderSchema.safeParse({ ...order, operationalStatus: 'open' }).success).toBe(false);
    expect(orderListSchema.safeParse({ items: [order] }).success).toBe(false);
  });

  it('starts an order, adds products at their catalogue price, removes a line, and always shows the SERVER total', async () => {
    const { api, session } = setup();
    expect(await session.start()).toBe(true);
    expect(session.getState().order?.operationalStatus).toBe('planned');
    expect(await session.add(product(1, { name: 'Espresso', price: 3.5 }))).toBe(true);
    expect(await session.add(product(2, { name: 'Milk', price: 2 }))).toBe(true);
    expect(session.getState().order?.totalAmount).toBe(5.5);
    const milk = session.getState().order!.lineItems[1];
    expect(await session.remove(milk.id)).toBe(true);
    expect(session.getState().order?.totalAmount).toBe(3.5);
    expect(session.getState().order?.lineItems.map((l) => l.description)).toEqual(['Espresso']);
    const add = api.calls[1];
    expect(add).toMatchObject({ method: 'POST', path: `/v1/businesses/${BUSINESS}/orders/${uuid(900)}/line-items`, body: { description: 'Espresso', quantity: 1, unitPrice: 3.5, productId: uuid(1), itemType: 'product' } });
    expect(api.calls[3]).toMatchObject({ method: 'DELETE', path: `/v1/businesses/${BUSINESS}/orders/${uuid(900)}/line-items/${milk.id}` });
  });

  it('sends the workspace claim and a distinct idempotency key on every change, and none on a read', async () => {
    const { api, session } = setup();
    await session.start(); await session.add(product(1)); await session.add(product(1));
    await session.open(uuid(900));
    expect(api.calls.every((c) => c.scope?.tenantId === scope.tenantId && c.scope?.workspaceId === scope.workspaceId)).toBe(true);
    const keys = api.calls.filter((c) => c.method !== 'GET').map((c) => c.key);
    expect(keys).toEqual(['key-1', 'key-2', 'key-3']);
    expect(api.calls.find((c) => c.method === 'GET')?.key).toBeUndefined();
  });

  it('ignores a second action while one is running (double tap), and sends exactly one request', async () => {
    const { api, session } = setup();
    await session.start();
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = session.add(product(1));
    expect(session.getState().busy).toBe(true);
    expect(await session.add(product(1))).toBe(false);
    expect(await session.remove(uuid(5))).toBe(false);
    release(); api.gate = null;
    expect(await first).toBe(true);
    expect(api.calls.filter((c) => c.path.endsWith('/line-items'))).toHaveLength(1);
    expect(session.getState().order?.lineItems).toHaveLength(1);
  });

  it('after a lost answer, retry reuses the SAME key and body, so the line is recorded once; new actions are refused until it is resolved', async () => {
    const { api, session } = setup();
    await session.start();
    api.failNext = { error: new ApiUnavailableError(), applied: true, times: 1 };
    expect(await session.add(product(1, { name: 'Espresso', price: 3.5 }))).toBe(false);
    expect(session.getState()).toMatchObject({ retryable: true, busy: false });
    expect(session.getState().message).toMatch(/could not be reached/);
    expect(await session.add(product(2))).toBe(false);                       // blocked while the unresolved action waits
    expect(await session.start()).toBe(false);
    expect(await session.retry()).toBe(true);
    const adds = api.calls.filter((c) => c.path.endsWith('/line-items'));
    expect(adds).toHaveLength(2);
    expect(adds[1].key).toBe(adds[0].key);
    expect(adds[1].body).toEqual(adds[0].body);
    expect(session.getState().order?.lineItems).toHaveLength(1);              // the server replayed, it did not add a second line
    expect(session.getState().order?.totalAmount).toBe(3.5);
    expect(session.getState()).toMatchObject({ retryable: false, message: null });
    expect(await session.add(product(2))).toBe(true);                         // and new actions work again, with a new key
    expect(api.calls.at(-1)?.key).not.toBe(adds[0].key);
  });

  it('treats an unexpected answer and a 5xx as unknown outcomes (retryable), but a 4xx or an ended session as definite (not retryable, new key next time)', async () => {
    for (const error of [new ApiContractError(), apiError(502)]) {
      const { api, session } = setup();
      await session.start();
      api.failNext = { error, applied: false, times: 1 };
      expect(await session.add(product(1))).toBe(false);
      expect(session.getState().retryable).toBe(true);
    }
    for (const error of [apiError(409), apiError(403), apiError(422), new SessionExpiredError()]) {
      const { api, session } = setup();
      await session.start();
      api.failNext = { error, applied: false, times: 1 };
      expect(await session.add(product(1))).toBe(false);
      expect(session.getState().retryable).toBe(false);
      expect(session.getState().message).toBeTruthy();
      expect(await session.retry()).toBe(false);                              // nothing to retry
      expect(await session.add(product(1))).toBe(true);                       // the next action is allowed and uses a fresh key
      const adds = api.calls.filter((c) => c.path.endsWith('/line-items'));
      expect(adds[1].key).not.toBe(adds[0].key);
    }
  });

  it('discard drops the unresolved action and reloads the order from the server, showing what was really recorded', async () => {
    const { api, session } = setup();
    await session.start();
    api.failNext = { error: new ApiUnavailableError(), applied: true, times: 1 };    // the server applied it, the answer was lost
    await session.add(product(1, { name: 'Espresso' }));
    expect(session.getState().order?.lineItems).toHaveLength(0);                     // the screen has not seen it yet
    await session.discard();
    expect(api.calls.at(-1)).toMatchObject({ method: 'GET', path: `/v1/businesses/${BUSINESS}/orders/${uuid(900)}` });
    expect(session.getState().order?.lineItems.map((l) => l.description)).toEqual(['Espresso']);
    expect(session.getState()).toMatchObject({ retryable: false, message: null });
    expect(await session.retry()).toBe(false);
  });

  it('refuses to add or remove without an open planned order, and sends nothing', async () => {
    const { api, session } = setup();
    expect(await session.add(product(1))).toBe(false);
    expect(await session.remove(uuid(1))).toBe(false);
    expect(api.calls).toEqual([]);
    await session.start();
    api.order!.operationalStatus = 'completed';
    await session.open(uuid(900));
    const before = api.calls.length;
    expect(await session.add(product(1))).toBe(false);
    expect(await session.remove(uuid(1))).toBe(false);
    expect(api.calls).toHaveLength(before);
  });

  it('a failed read keeps the current order and shows the message; notifies subscribers of every change', async () => {
    const { api, session } = setup();
    let notified = 0;
    const off = session.subscribe(() => { notified += 1; });
    await session.start();
    expect(notified).toBeGreaterThan(0);
    api.failNext = { error: apiError(404), applied: false, times: 1 };
    expect(await session.open(uuid(404))).toBe(false);
    expect(session.getState().order?.id).toBe(uuid(900));
    expect(session.getState().message).toMatch(/Not found/);
    off();
    const seen = notified;
    await session.add(product(1));
    expect(notified).toBe(seen);
  });

  it('the open-orders path asks for planned orders with a limit and encodes the business id', () => {
    expect(openOrdersPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/orders?status=planned&limit=20`);
    expect(openOrdersPath('a/b')).toContain('/v1/businesses/a%2Fb/orders');
  });
});

describe('complete and void (POS-3)', () => {
  it('completes an order with lines: one POST with its own key, the server answer shows the closed sale, and the total is unchanged', async () => {
    const { api, session } = setup();
    await session.start(); await session.add(product(1, { price: 3.5 }));
    expect(await session.complete()).toBe(true);
    expect(session.getState().order).toMatchObject({ operationalStatus: 'completed', totalAmount: 3.5, currencyCode: 'KWD' });
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/businesses/${BUSINESS}/orders/${uuid(900)}/complete`, key: 'key-3' });
    expect(await session.add(product(1))).toBe(false);                         // a completed order is closed
    expect(await session.complete()).toBe(false);                              // and cannot be completed twice
    expect(api.calls.filter((c) => c.path.endsWith('/complete'))).toHaveLength(1);
  });

  it('refuses to complete an empty order or without an order, and sends nothing', async () => {
    const { api, session } = setup();
    expect(await session.complete()).toBe(false);
    await session.start();
    const before = api.calls.length;
    expect(await session.complete()).toBe(false);
    expect(api.calls).toHaveLength(before);
  });

  it('a lost answer on complete is retried with the SAME key and records the sale once', async () => {
    const { api, session } = setup();
    await session.start(); await session.add(product(1));
    api.failNext = { error: new ApiUnavailableError(), applied: true, times: 1 };
    expect(await session.complete()).toBe(false);
    expect(session.getState()).toMatchObject({ retryable: true });
    expect(await session.voidOrder()).toBe(false);                             // blocked while unresolved: no void on a maybe-completed order
    expect(await session.retry()).toBe(true);
    const completes = api.calls.filter((c) => c.path.endsWith('/complete'));
    expect(completes).toHaveLength(2);
    expect(completes[1].key).toBe(completes[0].key);
    expect(session.getState().order?.operationalStatus).toBe('completed');
    expect(api.calls.filter((c) => c.path.endsWith('/void'))).toHaveLength(0);
  });

  it('a 409 on complete gives the plain conflict sentence (never the raw server text) and is not retryable', async () => {
    const { api, session } = setup();
    await session.start(); await session.add(product(1));
    api.failNext = { error: new ApiError(409, 'X', 'order ... cannot be completed (status: failed)'), applied: false, times: 1 };
    expect(await session.complete()).toBe(false);
    expect(session.getState()).toMatchObject({ retryable: false, message: COMPLETE_CONFLICT });
    expect(await session.complete()).toBe(true);                               // the next attempt gets a new key and works
  });

  it('voids an open order with a trimmed reason; with no reason the body carries none', async () => {
    const a = setup();
    await a.session.start();
    expect(await a.session.voidOrder('  wrong table  ')).toBe(true);
    expect(a.session.getState().order?.operationalStatus).toBe('failed');
    expect(a.api.calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/businesses/${BUSINESS}/orders/${uuid(900)}/void`, body: { reason: 'wrong table' }, key: 'key-2' });
    const b = setup();
    await b.session.start();
    expect(await b.session.voidOrder('   ')).toBe(true);
    expect(b.api.calls.at(-1)?.body).toEqual({});
  });

  it('refuses an over-long reason locally (nothing sent) and a void without an open planned order', async () => {
    const { api, session } = setup();
    expect(await session.voidOrder()).toBe(false);
    await session.start();
    const before = api.calls.length;
    expect(await session.voidOrder('x'.repeat(VOID_REASON_MAX + 1))).toBe(false);
    expect(session.getState().message).toMatch(/too long/);
    expect(api.calls).toHaveLength(before);
    expect(await session.voidOrder('x'.repeat(VOID_REASON_MAX))).toBe(true);
  });

  it('a 409 on void gives the plain conflict sentence', async () => {
    const { api, session } = setup();
    await session.start();
    api.failNext = { error: new ApiError(409, 'X', 'raw'), applied: false, times: 1 };
    expect(await session.voidOrder('r')).toBe(false);
    expect(session.getState()).toMatchObject({ retryable: false, message: VOID_CONFLICT });
  });

  it('a double tap on Complete sends exactly one request', async () => {
    const { api, session } = setup();
    await session.start(); await session.add(product(1));
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = session.complete();
    expect(await session.complete()).toBe(false);
    expect(await session.voidOrder()).toBe(false);
    release(); api.gate = null;
    expect(await first).toBe(true);
    expect(api.calls.filter((c) => c.path.endsWith('/complete'))).toHaveLength(1);
  });
});
