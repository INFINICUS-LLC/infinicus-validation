import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

let routeParams: Record<string, string> = { businessId: '33333333-3333-4333-8333-333333333333' };
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useParams: () => routeParams }));

import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';
import CounterPage from '../app/(client)/businesses/[businessId]/counter/page';
import { CounterCatalogue } from '../app/(client)/businesses/[businessId]/counter/counter-view';
import { OrderPanelView, type OrderPanelProps } from '../app/(client)/businesses/[businessId]/counter/order-panel';
import { ALL_CATEGORIES, categoriesOf, filterProducts, formatAmount, visibleProducts } from '../lib/client/counter';
import { productListSchema, type Order, type Product } from '../lib/client/schemas';
import type { AuthState } from '../lib/client/authController';
import { membership } from './helpers/fakes';

const value = (state: AuthState): AuthContextValue => ({
  state, api: null, signIn: async () => ({ ok: true as const }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined,
});
const html = (state: AuthState, el: ReactElement) => renderToString(<AuthContext.Provider value={value(state)}>{el}</AuthContext.Provider>).replace(/<!-- -->/g, '');
const a = membership('Acme');
const ready: AuthState = { status: 'ready', email: 'owner@example.test', memberships: [a], scope: { tenantId: a.tenantId, workspaceId: a.workspaceId } };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (n: number, over: Partial<Product> = {}): Product => ({ id: id(n), name: `Item ${n}`, price: n, category: 'other', icon: null, active: true, sortOrder: 0, ...over });
const catalogue: Product[] = [
  product(1, { name: 'Milk', price: 2, category: 'Drinks', sortOrder: 2 }),
  product(2, { name: 'Espresso', price: 3.5, category: 'Drinks', sortOrder: 1, icon: '☕' }),
  product(3, { name: 'Cake', price: 4.25, category: 'Desserts', sortOrder: 3 }),
  product(4, { name: 'Retired special', price: 9, category: 'Desserts', active: false }),
];

describe('counter catalogue helpers (pure; no storage, no network)', () => {
  it('the products schema accepts the API shape and fails loudly on drift', () => {
    expect(productListSchema.safeParse({ products: catalogue }).success).toBe(true);
    expect(productListSchema.safeParse({ products: [] }).success).toBe(true);
    expect(productListSchema.safeParse({ products: [{ ...catalogue[0], price: '2.00' }] }).success).toBe(false);   // a string price is drift, not a number
    expect(productListSchema.safeParse({ products: [{ ...catalogue[0], id: 'not-a-uuid' }] }).success).toBe(false);
    expect(productListSchema.safeParse({ items: catalogue }).success).toBe(false);
    const { icon: _icon, ...withoutIcon } = catalogue[0];
    expect(productListSchema.safeParse({ products: [withoutIcon] }).success).toBe(false);
  });

  it('shows active products only, in the shop order (sortOrder, then name), without mutating its input', () => {
    const input = [...catalogue];
    expect(visibleProducts(input).map((p) => p.name)).toEqual(['Espresso', 'Milk', 'Cake']);
    expect(input).toEqual(catalogue);
    expect(visibleProducts([product(5, { name: 'B' }), product(6, { name: 'A' })]).map((p) => p.name)).toEqual(['A', 'B']);   // ties fall back to the name
  });

  it('lists each category once, sorted; filters by name (case and surrounding spaces ignored) and by category', () => {
    expect(categoriesOf(catalogue)).toEqual(['Desserts', 'Drinks']);
    const active = visibleProducts(catalogue);
    expect(filterProducts(active, '  ESP ', ALL_CATEGORIES).map((p) => p.name)).toEqual(['Espresso']);
    expect(filterProducts(active, '', 'Desserts').map((p) => p.name)).toEqual(['Cake']);
    expect(filterProducts(active, 'm', 'Drinks').map((p) => p.name)).toEqual(['Milk']);          // both conditions must hold
    expect(filterProducts(active, 'zzz', ALL_CATEGORIES)).toEqual([]);
    expect(filterProducts(active, '', ALL_CATEGORIES)).toHaveLength(3);
  });

  it('formats an amount to two decimals with no invented currency symbol', () => {
    expect(formatAmount(3.5)).toBe('3.50');
    expect(formatAmount(1234.5)).toBe('1,234.50');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(2)).not.toMatch(/[$€£]/);
  });
});

describe('counter page and catalogue (server-rendered output)', () => {
  it('the catalogue shows labelled search, category buttons, a live count, tiles with name and price, and hides inactive products', () => {
    const out = html(ready, <CounterCatalogue products={catalogue} />);
    expect(out).toContain('for="product-search"');
    expect(out).toContain('id="product-search"');
    expect(out).toContain('aria-label="Categories"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);                                    // only "All" starts pressed
    expect(out).toContain('3 of 3 products');
    for (const name of ['Milk', 'Espresso', 'Cake']) expect(out).toContain(name);
    expect(out).toContain('3.50');
    expect(out).toContain('☕');
    expect(out).not.toContain('Retired special');
    expect(out).toContain('aria-label="Products"');
  });

  it('is read only: no product tile holds a button or link, and the order panel states that building comes next', () => {
    const out = html(ready, <CounterCatalogue products={catalogue} />);
    const grid = out.slice(out.indexOf('class="product-grid"'), out.indexOf('</ul>', out.indexOf('class="product-grid"')));
    expect(grid).not.toMatch(/<button|<a |onClick|href=/);
    expect(out).toContain('Building an order comes in the next step');
  });

  it('has explained empty states and omits the category group when there is nothing to filter', () => {
    const none = html(ready, <CounterCatalogue products={[]} />);
    expect(none).toContain('No products yet');
    expect(none).toContain('0 of 0 products');
    expect(none).not.toContain('aria-label="Categories"');
    const oneCategory = html(ready, <CounterCatalogue products={[product(7, { category: 'Drinks' })]} />);
    expect(oneCategory).not.toContain('aria-label="Categories"');
    expect(html(ready, <CounterCatalogue products={[product(8, { active: false })]} />)).toContain('No products yet');   // only inactive products
  });

  it('the page shows the shared states: loading inside a workspace, an invalid business address, and the not-configured state', () => {
    routeParams = { businessId: '33333333-3333-4333-8333-333333333333' };
    const loading = html(ready, <CounterPage />);
    expect(loading).toContain('<h1>Counter</h1>');
    expect(loading).toContain('Loading');
    expect(loading).toContain('href="/businesses"');
    routeParams = { businessId: 'not-a-uuid' };
    const bad = html(ready, <CounterPage />);
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('That business address is not valid');
    expect(bad).not.toContain('Counter</h1>');
    routeParams = { businessId: '33333333-3333-4333-8333-333333333333' };
    const unconfigured = html({ status: 'unconfigured', missing: ['NEXT_PUBLIC_API_BASE_URL'], invalid: [] }, <CounterPage />);
    expect(unconfigured).toContain('role="alert"');
    expect(unconfigured).toContain('NEXT_PUBLIC_API_BASE_URL');
  });
});

const line = (n: number, over: Partial<Order['lineItems'][number]> = {}): Order['lineItems'][number] => ({ id: id(100 + n), lineNumber: n, itemType: 'product', productId: id(n), description: `Item ${n}`, quantity: 1, unitPrice: n, lineTotal: n, ...over });
const order = (over: Partial<Order> = {}): Order => ({ id: id(900), businessId: id(800), customerId: null, orderNumber: 'ORD-TEST', orderDate: '2026-10-18', currencyCode: 'USD', totalAmount: 5.5, operationalStatus: 'planned', createdAt: 'a', updatedAt: 'b', lineItems: [line(2, { description: 'Espresso', unitPrice: 3.5, lineTotal: 3.5 }), line(3, { description: 'Milk', unitPrice: 2, lineTotal: 2 })], ...over });
const noop = () => undefined;
const panel = (over: Partial<OrderPanelProps> = {}) => html(ready, <OrderPanelView state={{ order: null, busy: false, message: null, retryable: false }} openOrders={[]} onStart={noop} onRemove={noop} onRetry={noop} onDiscard={noop} onOpen={noop} {...over} />);

describe('order panel and interactive catalogue (POS-2, server-rendered output)', () => {
  it('with no order it explains what to do and offers New order; nothing else', () => {
    const out = panel();
    expect(out).toContain('No order open');
    expect(out).toContain('New order');
    expect(out).not.toContain('aria-label="Order lines"');
    expect(out).not.toContain('Retry');
  });

  it('shows the lines, a labelled Remove button per line, the order number and status, and the server total', () => {
    const out = panel({ state: { order: order(), busy: false, message: null, retryable: false } });
    expect(out).toContain('ORD-TEST');
    expect(out).toContain('planned');
    expect(out).toContain('aria-label="Order lines"');
    expect(out).toContain('aria-label="Remove Espresso"');
    expect(out).toContain('aria-label="Remove Milk"');
    expect(out).toContain('Total <strong>USD 5.50</strong>');
    expect(out).toContain('3.50');
    expect(out).toContain('role="status"');
  });

  it('an order with no lines says so; a completed order cannot be edited (Remove disabled)', () => {
    expect(panel({ state: { order: order({ lineItems: [], totalAmount: 0 }), busy: false, message: null, retryable: false } })).toContain('No items yet');
    const done = panel({ state: { order: order({ operationalStatus: 'completed' }), busy: false, message: null, retryable: false } });
    expect(done.match(/aria-label="Remove [^"]+"[^>]*disabled/g)).toHaveLength(2);
  });

  it('while an action runs every button is disabled and the region is marked busy', () => {
    const out = panel({ state: { order: order(), busy: true, message: null, retryable: false }, openOrders: [order({ id: id(901), orderNumber: 'ORD-OTHER' })] });
    expect(out).toContain('aria-busy="true"');
    const buttons = out.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    expect(buttons.every((b) => b.includes('disabled'))).toBe(true);
  });

  it('a retryable failure is announced with Retry and Discard and blocks other actions; a definite refusal shows the message without Retry', () => {
    const unknownOutcome = panel({ state: { order: order(), busy: false, message: 'The service could not be reached. Check your connection and try again.', retryable: true } });
    expect(unknownOutcome).toContain('role="alert"');
    expect(unknownOutcome).toContain('Retry');
    expect(unknownOutcome).toContain('Discard and reload');
    expect((unknownOutcome.match(/<button[^>]*aria-label="Remove[^>]*>/g) ?? []).every((b) => b.includes('disabled'))).toBe(true);
    expect(unknownOutcome).toMatch(/<button[^>]*disabled[^>]*>New order/);
    const refused = panel({ state: { order: order(), busy: false, message: 'This conflicts with an existing record, or was already recorded.', retryable: false } });
    expect(refused).toContain('role="alert"');
    expect(refused).not.toContain('Retry');
  });

  it('lists other open orders to resume (not the current one), each with a labelled Open button', () => {
    const out = panel({ state: { order: order(), busy: false, message: null, retryable: false }, openOrders: [order(), order({ id: id(901), orderNumber: 'ORD-OTHER', totalAmount: 9 })] });
    expect(out).toContain('aria-label="Open orders"');
    expect(out).toContain('aria-label="Open ORD-OTHER"');
    expect(out).not.toContain('aria-label="Open ORD-TEST"');
  });

  it('the catalogue turns tiles into labelled buttons when adding is enabled, greys them out when disabled, and shows the supplied order panel instead of the placeholder', () => {
    const on = html(ready, <CounterCatalogue products={catalogue} onAdd={noop} orderPanel={<p>PANEL</p>} />);
    expect(on).toContain('aria-label="Add Espresso"');
    expect(on).toContain('PANEL');
    expect(on).not.toContain('Building an order comes in the next step');
    expect(on).not.toMatch(/aria-label="Add [^"]+"[^>]*disabled/);
    const off = html(ready, <CounterCatalogue products={catalogue} onAdd={noop} disabled />);
    expect(off.match(/aria-label="Add [^"]+"[^>]*disabled/g)).toHaveLength(3);
    expect(html(ready, <CounterCatalogue products={catalogue} />)).not.toContain('aria-label="Add ');   // read-only mode is unchanged
  });
});

describe('complete and void on the order panel (POS-3, server-rendered output)', () => {
  const open = (over: Partial<OrderPanelProps> = {}, o: Partial<Order> = {}, st: Partial<OrderPanelProps['state']> = {}) =>
    panel({ state: { order: order(o), busy: false, message: null, retryable: false, ...st }, ...over });

  it('an open order with lines offers Complete sale and Void order; with no lines Complete is disabled', () => {
    const out = open();
    expect(out).toContain('Complete sale');
    expect(out).toContain('Void order');
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Complete sale/);
    expect(open({}, { lineItems: [], totalAmount: 0 })).toMatch(/<button[^>]*disabled[^>]*>Complete sale/);
  });

  it('asking to complete shows a confirmation with the server total and currency, and hides the first-step buttons', () => {
    const out = open({ confirm: 'complete' });
    expect(out).toContain('aria-label="Confirm completing the sale"');
    expect(out).toContain('USD 5.50');
    expect(out).toContain('Confirm: complete sale');
    expect(out).not.toContain('>Complete sale<');
  });

  it('asking to void shows an optional reason field (limited to 500 characters) and a confirmation', () => {
    const out = open({ confirm: 'void', voidReason: 'wrong table' });
    expect(out).toContain('aria-label="Confirm voiding the order"');
    expect(out).toContain('Reason (optional)');
    expect(out).toContain('maxLength="500"');
    expect(out).toContain('value="wrong table"');
    expect(out).toContain('Confirm: void order');
  });

  it('while an action runs, the confirm buttons and the reason field are disabled (double-tap protection)', () => {
    const out = open({ confirm: 'void' }, {}, { busy: true });
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Confirm: void order/);
    expect(out).toMatch(/<input[^>]*id="void-reason"[^>]*disabled/);
    expect(open({ confirm: 'complete' }, {}, { busy: true })).toMatch(/<button[^>]*disabled[^>]*>Confirm: complete sale/);
  });

  it('a completed order shows the recorded sale and no complete or void buttons; a voided order says no sale was recorded', () => {
    const done = open({}, { operationalStatus: 'completed' });
    expect(done).toContain('Sale recorded: ORD-TEST, USD 5.50');
    expect(done).not.toContain('Complete sale');
    expect(done).not.toContain('Void order');
    const voided = open({}, { operationalStatus: 'failed' });
    expect(voided).toContain('was voided. No sale was recorded.');
    expect(voided).not.toContain('Complete sale');
  });

  it('an unresolved (retryable) action disables Complete and Void', () => {
    const out = open({}, {}, { retryable: true, message: 'The service could not be reached. Check your connection and try again.' });
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Complete sale/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Void order/);
  });
});

describe('amounts use the currency decimal places (POS-1.6, server-rendered output)', () => {
  it('formatAmount keeps the old two-decimal look without a currency and shows exactly the currency decimals with one', () => {
    expect(formatAmount(3.5)).toBe('3.50');
    expect(formatAmount(3.5, 'KWD')).toBe('3.500');
    expect(formatAmount(300, 'JPY')).toBe('300');
    expect(formatAmount(0.125)).toBe('0.125');     // a three-decimal price is never shown as 0.13
  });

  it('a KWD order panel shows lines and total with three decimals and the currency code', () => {
    const kwd = order({ currencyCode: 'KWD', totalAmount: 0.5, lineItems: [line(1, { description: 'Tea', unitPrice: 0.125, quantity: 4, lineTotal: 0.5 })] });
    const out = panel({ state: { order: kwd, busy: false, message: null, retryable: false }, openOrders: [order({ id: id(901), orderNumber: 'ORD-OTHER', currencyCode: 'KWD', totalAmount: 0.375 })] });
    expect(out).toContain('0.500');
    expect(out).toContain('Total <strong>KWD 0.500</strong>');
    expect(out).toContain('KWD 0.375');
  });

  it('a JPY order panel shows whole units', () => {
    const jpy = order({ currencyCode: 'JPY', totalAmount: 300, lineItems: [line(1, { description: 'Onigiri', unitPrice: 150, quantity: 2, lineTotal: 300 })] });
    expect(panel({ state: { order: jpy, busy: false, message: null, retryable: false } })).toContain('Total <strong>JPY 300</strong>');
  });

  it('catalogue tiles do not round a three-decimal price up (the products API carries no currency)', () => {
    const out = html(ready, <CounterCatalogue products={[product(1, { name: 'Tea', price: 0.125 })]} />);
    expect(out).toContain('0.125');
    expect(out).not.toContain('0.13');
  });
});

