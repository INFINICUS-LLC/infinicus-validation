import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ApiError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { SalesHistoryController, SALES_PAGE_SIZE, salesHistoryPath, type SalesHistoryState } from '../lib/client/salesHistory';
import type { Order } from '../lib/client/schemas';
import { SalesHistoryView } from '../app/(client)/businesses/[businessId]/sales/sales-view';
import { BusinessReceipt } from '../app/(client)/businesses/[businessId]/counter/business-receipt';
import SalesPage from '../app/(client)/businesses/[businessId]/sales/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

const identity = vi.hoisted(() => ({ resource: { kind: 'loading' } as any, path: '' }));
vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: (path: string) => { identity.path = path; return { resource: identity.resource, reload: vi.fn() }; } }));

let businessParam = '00000000-0000-4000-8000-000000000002';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: businessParam }) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BUSINESS = id(2);
const scope: Scope = { tenantId: id(3), workspaceId: id(4) };
const order = (n: number, over: Partial<Order> = {}): Order => ({
  id: id(n), businessId: BUSINESS, customerId: null, orderNumber: `ORD-${n}`, orderDate: '2026-10-20T12:00:00Z', createdAt: '2026-10-20T12:00:01Z', updatedAt: '2026-10-20T12:00:02Z',
  currencyCode: 'KWD', registerSessionId: id(5), totalAmount: 1.375, operationalStatus: 'completed', lineItems: [], payments: [], changeDue: 0, ...over,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function setup(rows: Order[] = [order(100)]) {
  const calls: { path: string; scope?: Scope }[] = [];
  const handler = { get: async (path: string): Promise<unknown> => {
    if (path.includes('?')) {
      const cursor = new URL(`https://example.test${path}`).searchParams.get('before');
      const start = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0;
      return { orders: rows.slice(start, start + SALES_PAGE_SIZE + 1) };
    }
    return rows.find(row => row.id === path.split('/').at(-1));
  } };
  const mutation = vi.fn(async () => { throw new Error('Sales history must never write'); });
  const api: ApiClient = {
    get: async <T,>(path: string, init?: RequestInitLite<T>): Promise<T> => {
      calls.push({ path, scope: init?.scope });
      const data = await handler.get(path);
      return init?.schema ? init.schema.parse(data) : data as T;
    }, post: mutation, delete: mutation,
  };
  return { history: new SalesHistoryController(api, scope, BUSINESS), calls, handler, mutation, api };
}

describe('completed sales history: scoped reads and stable cursor navigation', () => {
  it('pages older and newer using the last displayed server ID, with no writes or client money calculations', async () => {
    const rows = Array.from({ length: 25 }, (_, n) => order(100 + n));
    const { history, calls, mutation } = setup(rows);
    await history.refresh();
    expect(history.getState()).toMatchObject({ orders: rows.slice(0, 20), hasOlder: true, hasNewer: false, busy: false });
    await history.older();
    expect(history.getState()).toMatchObject({ orders: rows.slice(20), hasOlder: false, hasNewer: true });
    expect(calls[1].path).toBe(salesHistoryPath(BUSINESS, rows[19].id));
    await history.newer();
    expect(history.getState().orders).toEqual(rows.slice(0, 20));
    expect(calls.every(call => call.scope === scope)).toBe(true);
    expect(mutation).not.toHaveBeenCalled();
    expect(salesHistoryPath('a/b', 'c/d')).toContain('a%2Fb/orders?status=completed&limit=21&before=c%2Fd');
  });

  it('fetches full lines and payments for a receipt instead of printing the incomplete list row', async () => {
    const full = order(100, { lineItems: [{ id: id(101), lineNumber: 1, productId: null, itemType: 'product', description: 'Coffee', quantity: 1, unitPrice: 1.375, lineTotal: 1.375 }], payments: [{ id: id(102), position: 1, method: 'cash', currencyCode: 'KWD', amountTendered: 2, amountApplied: 1.375, changeGiven: 0.625, reference: null, createdAt: '2026-10-20T12:00:02Z' }], changeDue: 0.625 });
    const { history, handler, calls } = setup();
    await history.refresh();
    expect(history.getState().orders[0].payments).toEqual([]);
    handler.get = async () => full;
    await history.openReceipt(full.id);
    expect(calls.at(-1)?.path).toBe(`/v1/businesses/${BUSINESS}/orders/${full.id}`);
    expect(history.getState().receipt).toMatchObject({ kind: 'ok', data: full });
  });

  it('ignores an older list response after a refresh supersedes it', async () => {
    const { history, handler } = setup();
    const late = deferred<unknown>();
    handler.get = () => late.promise;
    const first = history.refresh();
    handler.get = async () => ({ orders: [order(200)] });
    await history.refresh();
    late.resolve({ orders: [order(100)] }); await first;
    expect(history.getState().orders[0].id).toBe(id(200));
  });

  it('a newer receipt selection wins, and closing or changing page prevents a late receipt from reopening', async () => {
    const rows = Array.from({ length: 21 }, (_, n) => order(100 + n));
    const { history, handler } = setup(rows);
    await history.refresh();
    const first = deferred<unknown>(); const second = deferred<unknown>();
    handler.get = path => path.endsWith(rows[0].id) ? first.promise : second.promise;
    const a = history.openReceipt(rows[0].id); const b = history.openReceipt(rows[1].id);
    second.resolve(rows[1]); await b; first.resolve(rows[0]); await a;
    expect(history.getState().selectedId).toBe(rows[1].id);
    const closed = deferred<unknown>(); handler.get = () => closed.promise;
    const c = history.openReceipt(rows[0].id);
    history.closeReceipt(); closed.resolve(rows[0]); await c;
    expect(history.getState().receipt).toBeNull();
    const paged = deferred<unknown>(); handler.get = () => paged.promise;
    const d = history.openReceipt(rows[0].id);
    handler.get = async () => ({ orders: [rows[20]] });
    await history.older(); paged.resolve(rows[0]); await d;
    expect(history.getState().receipt).toBeNull();
  });

  it('rejects foreign/non-completed data and wrong detail identity instead of rendering a receipt', async () => {
    for (const bad of [order(100, { businessId: id(99) }), order(100, { operationalStatus: 'planned' })]) {
      const { history } = setup([bad]); await history.refresh();
      expect(history.getState().orders).toEqual([]);
      expect(history.getState().message).toContain('unexpected format');
    }
    for (const bad of [order(101), order(100, { businessId: id(99) }), order(100, { operationalStatus: 'failed' }), { id: id(100) }]) {
      const { history, handler } = setup(); await history.refresh(); handler.get = async () => bad;
      await history.openReceipt(id(100)); expect(history.getState().receipt?.kind).toBe('error');
    }
  });

  it('handles permission failures without showing raw server text and allows read retry', async () => {
    const { history, handler, calls } = setup();
    handler.get = async () => { throw new ApiError(403, 'DENIED', 'internal confidential text'); };
    await history.refresh();
    expect(history.getState().message).toContain('do not have permission');
    expect(history.getState().message).not.toContain('confidential');
    handler.get = async () => ({ orders: [order(100)] }); await history.refresh();
    expect(history.getState().message).toBeNull();
    const count = calls.length; await history.openReceipt(id(999));
    expect(calls).toHaveLength(count);
  });

  it('a separate workspace controller starts empty and cannot inherit an older instance receipt', async () => {
    const { history, api } = setup(); await history.refresh(); await history.openReceipt(id(100));
    const next = new SalesHistoryController(api, { ...scope, workspaceId: id(55) }, BUSINESS);
    expect(next.getState()).toMatchObject({ orders: [], receipt: null, selectedId: null, busy: true });
  });
});

const noop = () => undefined;
const view = (patch: Partial<SalesHistoryState> = {}) => renderToString(<SalesHistoryView
  state={{ orders: [], busy: false, message: null, hasOlder: false, hasNewer: false, selectedId: null, receipt: null, ...patch }}
  onRefresh={noop} onOlder={noop} onNewer={noop} onReceipt={noop} onCloseReceipt={noop} />).replace(/<!-- -->/g, '');

describe('sales history view', () => {
  it('renders loading, errors and empty pages with accessible pagination', () => {
    expect(view({ busy: true })).toContain('Loading sales');
    expect(view({ message: 'Permission refused.' })).toContain('role="alert"');
    expect(view()).toContain('No completed sales');
    expect(view()).toContain('aria-label="Sales pages"');
    expect(view()).toMatch(/disabled[^>]*>Older sales/);
  });
  it('shows server totals at currency precision and prints only a fetched receipt', () => {
    const out = view({ orders: [order(100)], hasOlder: true });
    expect(out).toContain('KWD 1.375');
    expect(out).toContain('View receipt for ORD-100');
    expect(out).not.toContain('Print receipt');
    expect(view({ receipt: { kind: 'ok', data: order(100) } })).not.toContain('Print receipt');
    expect(view({ receipt: { kind: 'error', message: 'Could not read receipt.' }, selectedId: id(100) })).toContain('Retry receipt');
    expect(out).not.toMatch(/Complete sale|Void order|New order|Refund/);
  });
  it('historical reprints wait for the exact business identity and preserve full server receipt details', () => {
    const sale = order(100, {
      lineItems: [{ id: id(77), lineNumber: 1, itemType: 'product', productId: null, description: 'Recorded product', quantity: 1.2345, unitPrice: 1, lineTotal: 1.375 }],
      payments: [{ id: id(78), position: 1, method: 'card', currencyCode: 'KWD', amountTendered: 1.375, amountApplied: 1.375, changeGiven: 0, reference: 'SLIP-HISTORY', createdAt: '2026-10-20T12:00:00Z' }],
    });
    const render = () => renderToString(<SalesHistoryView state={{ orders: [sale], busy: false, message: null, hasOlder: false, hasNewer: false, selectedId: sale.id, receipt: { kind: 'ok', data: sale } }}
      receiptContent={<BusinessReceipt order={sale} onClose={noop} />} onRefresh={noop} onOlder={noop} onNewer={noop} onReceipt={noop} onCloseReceipt={noop} />).replace(/<!-- -->/g, '');
    identity.resource = { kind: 'loading' };
    expect(render()).toContain('Loading receipt business details');
    expect(render()).not.toContain('Print receipt');
    expect(identity.path).toBe('/v1/businesses/' + BUSINESS);
    identity.resource = { kind: 'ok', data: { id: BUSINESS, legalName: 'Verified History Café', businessCode: 'HIST', status: 'active', industry: null } };
    const html = render();
    expect(html).toContain('Verified History Café');
    expect(html).toContain('Recorded product');
    expect(html).toContain('1.2345');
    expect(html).toContain('SLIP-HISTORY');
    expect(html).toContain('Print receipt');
    identity.resource = { kind: 'error', message: 'Not found in this workspace' };
    expect(render()).toContain('Retry receipt');
    expect(render()).not.toContain('Print receipt');
  });

  it('the route rejects invalid business IDs and signed-out state before showing sales', () => {
    const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: noop };
    businessParam = 'invalid';
    const out = renderToString(<AuthContext.Provider value={value}><SalesPage /></AuthContext.Provider>);
    expect(out).toContain('business address is not valid');
    businessParam = BUSINESS;
    expect(renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><SalesPage /></AuthContext.Provider>)).not.toContain('Completed sales');
  });
});
