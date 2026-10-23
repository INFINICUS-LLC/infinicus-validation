import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  formatOrderTotal, isPoStatus, mayBeTruncated, purchaseOrdersPath, purchaseOrdersSchema, PURCHASING_LIMIT, statusText, suppliersPath, suppliersSchema, utcDate,
  type PurchaseOrdersResponse, type SuppliersResponse,
} from '../lib/client/purchasing';
import { PurchasingView } from '../app/(client)/businesses/[businessId]/purchasing/purchasing-view';
import PurchasingPage from '../app/(client)/businesses/[businessId]/purchasing/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const po = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), supplierId: id(200 + n), supplierName: `Supplier ${n}`, poNumber: `PO-${n}`, orderDate: '2026-03-10T08:30:00.000Z', expectedDate: '2026-03-20T00:00:00.000Z',
  currencyCode: 'KWD', totalAmount: 1250.5, poStatus: 'approved', approvedAt: '2026-03-11T09:00:00.000Z', ...over,
});
const supplier = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(300 + n), name: `Supplier ${n}`, supplierCode: `SUP-${n}`, riskStatus: 'low', status: 'active', latestPerformanceScore: 87.5, latestPerformanceAt: '2026-03-01T00:00:00.000Z', ...over,
});
const orders = (rows: ReturnType<typeof po>[]): PurchaseOrdersResponse => purchaseOrdersSchema.parse({ purchaseOrders: rows });
const sups = (rows: ReturnType<typeof supplier>[]): SuppliersResponse => suppliersSchema.parse({ suppliers: rows });
const view = (o: Parameters<typeof PurchasingView>[0]['orders'], s: Parameters<typeof PurchasingView>[0]['suppliers'], status: Parameters<typeof PurchasingView>[0]['status'] = null) =>
  renderToString(<PurchasingView orders={o} suppliers={s} status={status} onStatus={vi.fn()} />).replace(/<!-- -->/g, '');

describe('request paths', () => {
  it('asks for the largest page for exactly this business, with the status only when one is chosen', () => {
    expect(purchaseOrdersPath(BUSINESS, null)).toBe(`/v1/businesses/${BUSINESS}/operations/procurement?limit=100`);
    expect(purchaseOrdersPath(BUSINESS, 'partially_received')).toBe(`/v1/businesses/${BUSINESS}/operations/procurement?limit=100&status=partially_received`);
    expect(suppliersPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/operations/suppliers?limit=100`);
    expect(PURCHASING_LIMIT).toBe(100);
  });
  it('encodes an id so it can never add path segments or a query', () => {
    expect(purchaseOrdersPath('a/b?x=1', null)).toContain('/v1/businesses/a%2Fb%3Fx%3D1/operations/procurement');
    expect(suppliersPath('a/b?x=1')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/operations/suppliers');
  });
  it('only a known status is accepted from the control', () => {
    expect(isPoStatus('approved')).toBe(true);
    expect(isPoStatus('')).toBe(false);
    expect(isPoStatus('approved&limit=1000')).toBe(false);
  });
});

describe('formatOrderTotal: exact in the order currency, never rounded', () => {
  it.each([[1250.5, 'KWD', '1,250.500'], [0.125, 'KWD', '0.125'], [300, 'JPY', '300'], [99.99, 'USD', '99.99'], [1234567.89, 'USD', '1,234,567.89'], [0, 'KWD', '0.000'], [-5, 'USD', '-5.00']])('%d %s is shown as %s', (n, code, text) => {
    expect(formatOrderTotal(n, code)).toBe(text);
  });
  it('refuses an amount with more decimals than the currency has (no silent rounding) and an unknown currency', () => {
    expect(formatOrderTotal(10.005, 'USD')).toBeNull();
    expect(formatOrderTotal(1.2345, 'KWD')).toBeNull();
    expect(formatOrderTotal(100, 'XXX')).toBeNull();
    expect(formatOrderTotal(100, '')).toBeNull();
  });
});

describe('statusText and utcDate', () => {
  it('uses plain words for known statuses and shows an unknown one as sent', () => {
    expect(statusText('partially_received')).toBe('Partly received');
    expect(statusText('on_hold')).toBe('on_hold');
  });
  it('shows the UTC date of a timestamp and says so when it cannot be read', () => {
    expect(utcDate('2026-03-10T23:30:00.000Z')).toBe('2026-03-10');
    expect(utcDate('not a date')).toBe('unavailable');
  });
});

describe('response contracts', () => {
  it('rejects the wrong shape: string amount, missing field, non-finite score', () => {
    expect(() => purchaseOrdersSchema.parse({ purchaseOrders: [{ ...po(1), totalAmount: '1250.5' }] })).toThrow();
    expect(() => purchaseOrdersSchema.parse({ purchaseOrders: [{ ...po(1), currencyCode: undefined }] })).toThrow();
    expect(() => suppliersSchema.parse({ suppliers: [{ ...supplier(1), latestPerformanceScore: Number.NaN }] })).toThrow();
    expect(() => suppliersSchema.parse({})).toThrow();
  });
  it('treats a full page as possibly cut short', () => {
    expect(mayBeTruncated(PURCHASING_LIMIT)).toBe(true);
    expect(mayBeTruncated(PURCHASING_LIMIT - 1)).toBe(false);
  });
});

describe('PurchasingView', () => {
  it('shows loading and error states for each list with the right roles', () => {
    const out = view({ kind: 'loading' }, { kind: 'error', message: 'Could not load suppliers.' });
    expect(out).toContain('Loading purchase orders');
    expect(out).toMatch(/role="alert"[^>]*>Could not load suppliers\./);
    expect(out).toContain('aria-busy="true"');
  });
  it('says so when there are no purchase orders or suppliers, and names the filter when one is chosen', () => {
    expect(view({ kind: 'ok', data: orders([]) }, { kind: 'ok', data: sups([]) })).toContain('No purchase orders are recorded for this business yet.');
    expect(view({ kind: 'ok', data: orders([]) }, { kind: 'ok', data: sups([]) })).toContain('No suppliers are recorded for this business yet.');
    expect(view({ kind: 'ok', data: orders([]) }, { kind: 'ok', data: sups([]) }, 'received')).toContain('No received purchase orders.');
  });
  it('shows each purchase order in its own currency, exactly, with plain statuses and dates', () => {
    const out = view({ kind: 'ok', data: orders([po(1), po(2, { currencyCode: 'USD', totalAmount: 99.99, poStatus: 'partially_received', expectedDate: null, approvedAt: null })]) }, { kind: 'ok', data: sups([]) });
    expect(out).toContain('PO-1'); expect(out).toContain('KWD 1,250.500'); expect(out).toContain('USD 99.99');
    expect(out).toContain('Partly received'); expect(out).toContain('not set'); expect(out).toContain('not approved');
    expect(out).toContain('2026-03-10');
    expect(out).toContain('not added together');
    expect(out).not.toMatch(/Total (spend|value)|All currencies/);
  });
  it('shows an amount it cannot show exactly as unavailable instead of rounding it', () => {
    expect(view({ kind: 'ok', data: orders([po(1, { totalAmount: 1.2345 })]) }, { kind: 'ok', data: sups([]) })).toContain('amount unavailable');
  });
  it('shows suppliers with their latest score, or says none exists yet', () => {
    const out = view({ kind: 'ok', data: orders([]) }, { kind: 'ok', data: sups([supplier(1), supplier(2, { latestPerformanceScore: null, latestPerformanceAt: null, riskStatus: 'high' })]) });
    expect(out).toContain('SUP-1'); expect(out).toContain('87.5'); expect(out).toContain('2026-03-01');
    expect(out).toContain('not scored yet'); expect(out).toContain('high');
  });
  it('warns that a full page may be incomplete, and not otherwise', () => {
    const full = Array.from({ length: PURCHASING_LIMIT }, (_, i) => po(i + 1));
    expect(view({ kind: 'ok', data: orders(full) }, { kind: 'ok', data: sups([]) })).toContain('There may be more that are not listed here.');
    expect(view({ kind: 'ok', data: orders(full.slice(1)) }, { kind: 'ok', data: sups([]) })).not.toContain('There may be more');
  });
  it('is read-only: the only control chooses which status to list, and nothing offers to order, approve, receive or pay', () => {
    const out = view({ kind: 'ok', data: orders([po(1)]) }, { kind: 'ok', data: sups([supplier(1)]) });
    expect(out.match(/<select/g)).toHaveLength(1);
    expect(out).not.toMatch(/<(button|form|input|textarea)\b/);
    expect(out).not.toMatch(/\b(Approve now|Pay now|Receive now|Delete|Edit|Save|New order)\b/);
  });
  it('lists every status in the filter, with the chosen one selected', () => {
    const out = view({ kind: 'loading' }, { kind: 'loading' }, 'approved');
    for (const label of ['All statuses', 'Draft', 'Submitted', 'Approved', 'Partly received', 'Received', 'Cancelled']) expect(out).toContain(label);
    expect(out).toMatch(/<option value="approved" selected/);
  });
});

describe('PurchasingPage', () => {
  const scope = { tenantId: id(3), workspaceId: id(4) };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows nothing before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><PurchasingPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><PurchasingPage /></AuthContext.Provider>);
    expect(out).not.toContain('Purchase orders');
  });
});
