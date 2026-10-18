import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

let routeParams: Record<string, string> = { businessId: '33333333-3333-4333-8333-333333333333' };
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useParams: () => routeParams }));

import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';
import CounterPage from '../app/(client)/businesses/[businessId]/counter/page';
import { CounterCatalogue } from '../app/(client)/businesses/[businessId]/counter/counter-view';
import { ALL_CATEGORIES, categoriesOf, filterProducts, formatAmount, visibleProducts } from '../lib/client/counter';
import { productListSchema, type Product } from '../lib/client/schemas';
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
