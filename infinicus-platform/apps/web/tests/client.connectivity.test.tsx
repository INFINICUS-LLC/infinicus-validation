import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { ApiUnavailableError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { browserConnectivity, OFFLINE_NOTICE, shouldWarnBeforeLeave, watchReconnect, type ConnectivitySource } from '../lib/client/connectivity';
import { OrderSession } from '../lib/client/orders';
import { RegisterPanelView, type RegisterPanelProps } from '../app/(client)/businesses/[businessId]/counter/register-panel';
import { OrderPanelView, type OrderPanelProps } from '../app/(client)/businesses/[businessId]/counter/order-panel';
import { ConnectionBanner } from '../app/(client)/businesses/[businessId]/counter/connection';
import type { RegisterState } from '../lib/client/register';
import type { Order } from '../lib/client/schemas';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { tenantId: uuid(1), workspaceId: uuid(2) };

/** A connectivity source the test drives by hand. */
class FakeSource implements ConnectivitySource {
  online = true;
  private listeners = new Set<() => void>();
  isOnline = (): boolean => this.online;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(online: boolean): void { this.online = online; for (const l of [...this.listeners]) l(); }
  get listenerCount(): number { return this.listeners.size; }
}

describe('watchReconnect (retry once when the connection returns)', () => {
  it('retries when the connection returns while an action is unconfirmed', () => {
    const src = new FakeSource(); let retries = 0;
    watchReconnect(src, () => { retries += 1; }, () => true);
    src.set(false);
    expect(retries).toBe(0);              // going offline does nothing
    src.set(true);
    expect(retries).toBe(1);              // coming back retries once
  });

  it('does nothing when nothing is waiting, when the connection never dropped, or on repeated online events', () => {
    const src = new FakeSource(); let retries = 0; let waiting = false;
    watchReconnect(src, () => { retries += 1; }, () => waiting);
    src.set(true); src.set(true);
    expect(retries).toBe(0);              // never dropped
    src.set(false); src.set(true);
    expect(retries).toBe(0);              // dropped and returned, but nothing was waiting
    waiting = true;
    src.set(false); src.set(true); src.set(true); src.set(true);
    expect(retries).toBe(1);              // one return = one retry, however many online events follow
  });

  it('starts from an already-offline connection and retries on the first return; each later return retries again', () => {
    const src = new FakeSource(); src.online = false; let retries = 0;
    watchReconnect(src, () => { retries += 1; }, () => true);
    src.set(true);
    src.set(false); src.set(true);
    expect(retries).toBe(2);
  });

  it('stops watching when asked', () => {
    const src = new FakeSource(); let retries = 0;
    const stop = watchReconnect(src, () => { retries += 1; }, () => true);
    expect(src.listenerCount).toBe(1);
    stop();
    expect(src.listenerCount).toBe(0);
    src.set(false); src.set(true);
    expect(retries).toBe(0);
  });

  it('the browser source is safe without a window (server rendering): online, and subscribing is a no-op', () => {
    expect(browserConnectivity.isOnline()).toBe(true);
    expect(() => browserConnectivity.subscribe(() => undefined)()).not.toThrow();
  });
});

describe('leaving the page', () => {
  it('is warned about while an action is in flight or unconfirmed, in either controller', () => {
    const idle = { busy: false, retryable: false };
    expect(shouldWarnBeforeLeave(idle, idle)).toBe(false);
    expect(shouldWarnBeforeLeave({ busy: true, retryable: false }, idle)).toBe(true);
    expect(shouldWarnBeforeLeave(idle, { busy: false, retryable: true })).toBe(true);
    expect(shouldWarnBeforeLeave()).toBe(false);
  });
});

/** A server that applies a completion once per Idempotency-Key and replays the first answer for a repeated key. The first answer can be "lost" in transit. */
class LossyServer implements ApiClient {
  applied = 0;
  keysSeen: (string | undefined)[] = [];
  loseNextAnswer = false;
  private replays = new Map<string, Order>();
  constructor(private order: Order) {}
  async get<T>(): Promise<T> { return JSON.parse(JSON.stringify(this.order)) as T; }
  async delete<T>(): Promise<T> { throw new Error('not used'); }
  async post<T>(_path: string, init: RequestInitLite<T> = {}): Promise<T> {
    this.keysSeen.push(init.idempotencyKey);
    const replay = init.idempotencyKey ? this.replays.get(init.idempotencyKey) : undefined;
    if (replay) return JSON.parse(JSON.stringify(replay)) as T;
    this.applied += 1;
    this.order = { ...this.order, operationalStatus: 'completed' };
    if (init.idempotencyKey) this.replays.set(init.idempotencyKey, this.order);
    if (this.loseNextAnswer) { this.loseNextAnswer = false; throw new ApiUnavailableError('connection lost'); }
    return JSON.parse(JSON.stringify(this.order)) as T;
  }
}
const order = (over: Partial<Order> = {}): Order => ({
  id: uuid(10), businessId: uuid(3), customerId: null, orderNumber: 'ORD-0042', orderDate: '2026-10-20T10:00:00.000Z', currencyCode: 'USD', registerSessionId: uuid(4),
  totalAmount: 5, operationalStatus: 'planned', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z',
  lineItems: [{ id: uuid(11), lineNumber: 1, itemType: 'product', productId: null, description: 'Coffee', quantity: 1, unitPrice: 5, lineTotal: 5 }],
  payments: [], changeDue: 0, ...over,
});

describe('a sale whose confirmation was lost is retried safely when the connection returns', () => {
  it('the retry carries the SAME key, so the sale is recorded exactly once', async () => {
    const server = new LossyServer(order());
    const session = new OrderSession(server, scope, uuid(3), (() => { let n = 0; return () => `key-${(n += 1)}`; })());
    await session.open(uuid(10));
    const src = new FakeSource();
    watchReconnect(src, () => { void session.retry(); }, () => session.getState().retryable);

    server.loseNextAnswer = true;
    src.set(false);                                                      // the connection drops while the sale is being recorded
    expect(await session.complete([{ method: 'cash', amountTendered: 5 }])).toBe(false);
    expect(session.getState().retryable).toBe(true);                     // outcome unknown: held in memory with its key
    expect(server.applied).toBe(1);                                      // the server did record it

    src.set(true);                                                       // the connection returns -> one automatic retry
    await new Promise((r) => setTimeout(r, 0));
    expect(server.applied).toBe(1);                                      // replayed, NOT applied a second time
    expect(server.keysSeen).toEqual(['key-1', 'key-1']);                 // the same Idempotency-Key both times
    expect(session.getState().order?.operationalStatus).toBe('completed');
    expect(session.getState().retryable).toBe(false);
  });

  it('nothing is retried when nothing is unconfirmed', async () => {
    const server = new LossyServer(order());
    const session = new OrderSession(server, scope, uuid(3), () => 'k');
    await session.open(uuid(10));
    const src = new FakeSource();
    watchReconnect(src, () => { void session.retry(); }, () => session.getState().retryable);
    src.set(false); src.set(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(server.keysSeen).toEqual([]);
  });
});

describe('panels while offline', () => {
  const html = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, '');
  const orderPanel = (props: Partial<OrderPanelProps>, o: Order | null = order(), retryable = false) =>
    html(<OrderPanelView state={{ order: o, busy: false, message: retryable ? 'x' : null, retryable }} openOrders={[order({ id: uuid(99), orderNumber: 'ORD-0099' })]} onStart={() => undefined} onRemove={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} onOpen={() => undefined} {...props} />);
  /** The opening tag of the first button whose text is exactly `label`, or null when there is none (plain string search, no dynamic pattern). */
  const buttonTag = (out: string, label: string): string | null => {
    const end = out.indexOf(`>${label}</button>`);
    if (end < 0) return null;
    const start = out.lastIndexOf('<button', end);
    return out.slice(start, end + 1);
  };
  const disabled = (out: string, label: string): boolean => buttonTag(out, label)?.includes('disabled=""') === true;
  const enabled = (out: string, label: string): boolean => { const tag = buttonTag(out, label); return tag !== null && !tag.includes('disabled'); };

  it('online, an open order can be completed, voided, discounted and a new one started', () => {
    const out = orderPanel({});
    for (const label of ['Complete sale', 'Void order', 'Discount', 'New order']) expect(enabled(out, label), label).toBe(true);
  });

  it('offline, every order action is disabled, including New order and resuming an open order', () => {
    const out = orderPanel({ offline: true });
    for (const label of ['Complete sale', 'Void order', 'Discount', 'New order', 'Open']) expect(disabled(out, label), label).toBe(true);
  });

  it('offline, an unconfirmed action shows Retry and Discard but both wait for the connection', () => {
    const out = orderPanel({ offline: true }, order(), true);
    expect(disabled(out, 'Retry')).toBe(true);
    expect(disabled(out, 'Discard and reload')).toBe(true);
    expect(enabled(orderPanel({}, order(), true), 'Retry')).toBe(true);
  });

  const baseState: RegisterState = { loaded: true, session: null, summary: null, justClosed: null, busy: false, message: null, retryable: false };
  const registerPanel = (state: Partial<RegisterState>, over: Partial<RegisterPanelProps> = {}) =>
    html(<RegisterPanelView state={{ ...baseState, ...state }} cashText="25" cashValid confirmingClose={false} onCashChange={() => undefined} onOpen={() => undefined} onAskClose={() => undefined} onCancelClose={() => undefined} onConfirmClose={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} {...over} />);

  it('the register cannot be opened while offline, and can online', () => {
    expect(enabled(registerPanel({}), 'Open register')).toBe(true);
    expect(disabled(registerPanel({}, { offline: true }), 'Open register')).toBe(true);
  });

  it('the banner explains the situation offline and renders nothing online', () => {
    expect(renderToString(<ConnectionBanner online />)).toBe('');
    const off = renderToString(<ConnectionBanner online={false} />);
    expect(off).toContain('role="status"');
    expect(off.replace(/&#x27;/g, "'")).toContain(OFFLINE_NOTICE.slice(0, 40));
    expect(OFFLINE_NOTICE).toMatch(/cannot be recorded/);
    expect(OFFLINE_NOTICE).toMatch(/retried safely/);
  });
});
