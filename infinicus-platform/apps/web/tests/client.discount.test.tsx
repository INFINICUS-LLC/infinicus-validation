import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ApiError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { buildDiscount, DISCOUNT_REASON_MAX } from '../lib/client/discount';
import { DISCOUNT_CONFLICT, DISCOUNT_FORBIDDEN, DISCOUNT_REFUSED, OrderSession } from '../lib/client/orders';
import { OrderPanelView, type OrderPanelProps } from '../app/(client)/businesses/[businessId]/counter/order-panel';
import type { Order } from '../lib/client/schemas';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { tenantId: uuid(1), workspaceId: uuid(2) };
const entry = (amountText: string, reason = '') => ({ amountText, reason });

const order = (over: Partial<Order> = {}): Order => ({
  id: uuid(10), businessId: uuid(3), customerId: null, orderNumber: 'ORD-0009', orderDate: '2026-10-20T08:00:00.000Z', currencyCode: 'USD', registerSessionId: uuid(4),
  totalAmount: 10, operationalStatus: 'planned', createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z',
  lineItems: [{ id: uuid(11), lineNumber: 1, itemType: 'product', productId: uuid(12), description: 'Coffee beans', quantity: 1, unitPrice: 10, lineTotal: 10 }],
  payments: [], changeDue: 0, ...over,
});

describe('buildDiscount (local check before anything is sent)', () => {
  it('accepts a clear amount within the total; the reason is trimmed and optional', () => {
    expect(buildDiscount(entry('2.5', '  Staff meal '), 10, 'USD')).toEqual({ ok: true, amount: 2.5, reason: 'Staff meal' });
    expect(buildDiscount(entry('2.5'), 10, 'USD')).toEqual({ ok: true, amount: 2.5, reason: null });
    expect(buildDiscount(entry('10'), 10, 'USD')).toMatchObject({ ok: true, amount: 10 });         // the whole order
    expect(buildDiscount(entry('0.125'), 4.25, 'KWD')).toMatchObject({ ok: true, amount: 0.125 });  // exact to the fil
  });

  it('refuses nothing-or-nonsense amounts', () => {
    for (const bad of ['', '0', '-1', 'abc', '1,5', '1e2', '.5']) expect(buildDiscount(entry(bad), 10, 'USD'), bad).toMatchObject({ ok: false });
  });

  it('refuses more than the order total and more decimals than the currency has', () => {
    expect(buildDiscount(entry('10.01'), 10, 'USD')).toEqual({ ok: false, reason: 'The discount cannot be more than the order total.' });
    expect(buildDiscount(entry('0.125'), 10, 'USD')).toMatchObject({ ok: false });
    expect(buildDiscount(entry('150.5'), 1000, 'JPY')).toMatchObject({ ok: false });
    expect(buildDiscount(entry('150'), 1000, 'JPY')).toMatchObject({ ok: true, amount: 150 });
  });

  it('refuses an over-long reason and an unsupported currency', () => {
    expect(buildDiscount(entry('1', 'x'.repeat(DISCOUNT_REASON_MAX + 1)), 10, 'USD')).toMatchObject({ ok: false });
    expect(buildDiscount(entry('1', 'x'.repeat(DISCOUNT_REASON_MAX)), 10, 'USD')).toMatchObject({ ok: true });
    expect(buildDiscount(entry('1'), 10, 'ZZZ')).toMatchObject({ ok: false });
  });
});

/** Answers the discount route like the server: a signed line and a new total, or the configured error. Records what was sent. */
class FakeApi implements ApiClient {
  calls: { path: string; body: unknown; key?: string }[] = [];
  failWith: ApiError | null = null;
  constructor(public current: Order) {}
  async post<T>(path: string, init: RequestInitLite<T> = {}): Promise<T> {
    this.calls.push({ path, body: init.body, key: init.idempotencyKey });
    if (this.failWith) throw this.failWith;
    const { amount, reason } = init.body as { amount: number; reason?: string };
    this.current = { ...this.current, totalAmount: this.current.totalAmount - amount, lineItems: [...this.current.lineItems,
      { id: uuid(20), lineNumber: 2, itemType: 'discount', productId: null, description: reason ? `Discount: ${reason}` : 'Discount', quantity: 1, unitPrice: -amount, lineTotal: -amount }] };
    return JSON.parse(JSON.stringify(this.current)) as T;
  }
  async get<T>(): Promise<T> { return JSON.parse(JSON.stringify(this.current)) as T; }
  async delete<T>(): Promise<T> { throw new Error('not used'); }
}

describe('OrderSession.discount', () => {
  const sessionWith = async (api: FakeApi) => {
    const session = new OrderSession(api, scope, uuid(3), () => 'key-1');
    await session.open(api.current.id);
    return session;
  };

  it('posts the amount and the trimmed reason with an idempotency key, and shows the server total', async () => {
    const api = new FakeApi(order());
    const session = await sessionWith(api);
    expect(await session.discount(2.5, '  Staff meal ')).toBe(true);
    expect(api.calls[0]).toEqual({ path: `/v1/businesses/${uuid(3)}/orders/${uuid(10)}/discounts`, body: { amount: 2.5, reason: 'Staff meal' }, key: 'key-1' });
    expect(session.getState().order?.totalAmount).toBe(7.5);
    expect(session.getState().order?.lineItems.at(-1)).toMatchObject({ itemType: 'discount', lineTotal: -2.5 });
  });

  it('sends no reason field when there is none', async () => {
    const api = new FakeApi(order());
    const session = await sessionWith(api);
    await session.discount(1, '   ');
    expect(api.calls[0].body).toEqual({ amount: 1 });
  });

  it('a 403 says plainly that only an owner or admin can discount; 400 and 409 get their own sentences; nothing is retried', async () => {
    for (const [status, text] of [[403, DISCOUNT_FORBIDDEN], [400, DISCOUNT_REFUSED], [409, DISCOUNT_CONFLICT]] as const) {
      const api = new FakeApi(order());
      const session = await sessionWith(api);
      api.failWith = new ApiError(status, 'X', 'raw server words must not be shown');
      expect(await session.discount(1)).toBe(false);
      expect(session.getState().message).toBe(text);
      expect(session.getState().message).not.toContain('raw server');
      expect(session.getState().retryable).toBe(false);
    }
  });

  it('is ignored on an order that is not open, and refuses a reason that is too long without calling the server', async () => {
    const done = new FakeApi(order({ operationalStatus: 'completed' }));
    expect(await (await sessionWith(done)).discount(1)).toBe(false);
    expect(done.calls).toHaveLength(0);
    const api = new FakeApi(order());
    const session = await sessionWith(api);
    expect(await session.discount(1, 'x'.repeat(DISCOUNT_REASON_MAX + 1))).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(session.getState().message).toContain('too long');
  });
});

describe('order panel: discount', () => {
  const panel = (props: Partial<OrderPanelProps>, o: Order | null = order()) =>
    renderToString(<OrderPanelView state={{ order: o, busy: false, message: null, retryable: false }} openOrders={[]} onStart={() => undefined} onRemove={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} onOpen={() => undefined} {...props} />).replace(/<!-- -->/g, '');

  it('an open order with items has an enabled Discount button; with no items or a zero total it is disabled; a completed or voided order has none', () => {
    expect(panel({})).toMatch(/<button type="button" class="secondary">Discount<\/button>/);
    expect(panel({}, order({ lineItems: [], totalAmount: 0 }))).toMatch(/<button[^>]*disabled=""[^>]*>Discount<\/button>/);
    expect(panel({}, order({ totalAmount: 0 }))).toMatch(/<button[^>]*disabled=""[^>]*>Discount<\/button>/);
    expect(panel({}, order({ operationalStatus: 'completed' }))).not.toContain('>Discount<');
    expect(panel({}, order({ operationalStatus: 'failed' }))).not.toContain('>Discount<');
  });

  it('the discount step shows the total, the two fields, and enables Confirm only for a valid entry', () => {
    const ok = panel({ confirm: 'discount', discount: entry('2'), discountCheck: buildDiscount(entry('2'), 10, 'USD') });
    for (const text of ['Give a discount', 'USD 10.00', 'Amount off', 'Reason (optional)', 'Confirm: give discount', 'owner or admin']) expect(ok).toContain(text);
    expect(ok).not.toMatch(/Confirm: give discount<\/button>.*disabled/s);
    const bad = panel({ confirm: 'discount', discount: entry('99'), discountCheck: buildDiscount(entry('99'), 10, 'USD') });
    expect(bad).toContain('The discount cannot be more than the order total.');
    expect(bad).toMatch(/<button[^>]*disabled=""[^>]*>Confirm: give discount/);
  });

  it('a discount line reads as money off, not as "1 ×", and shows a negative amount', () => {
    const withDiscount = order({ totalAmount: 7.5, lineItems: [...order().lineItems, { id: uuid(21), lineNumber: 2, itemType: 'discount', productId: null, description: 'Discount: Staff meal', quantity: 1, unitPrice: -2.5, lineTotal: -2.5 }] });
    const html = panel({}, withDiscount);
    expect(html).toContain('Discount: Staff meal');
    expect(html).not.toContain('1 × Discount');
    expect(html).toContain('-2.50');
    expect(html).toContain('USD 7.50');
  });
});
