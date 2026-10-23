import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  flagCounts, formatMovement, formatQuantity, INVENTORY_LIMIT, inventoryPath, inventoryResponseSchema, mayBeTruncated, stockFlag,
  type InventoryResponse,
} from '../lib/client/inventory';
import { InventoryView } from '../app/(client)/businesses/[businessId]/inventory/inventory-view';
import InventoryPage from '../app/(client)/businesses/[businessId]/inventory/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), inventoryItemId: id(200 + n), warehouseId: id(300 + n), itemName: `Item ${n}`, sku: `SKU-${n}`, warehouseName: 'Main store',
  quantityOnHand: 20, quantityReserved: 5, quantityAvailable: 15, reorderPoint: 10, reorderQuantity: 40, lastMovementAt: '2026-03-10T08:30:00.000Z', ...over,
});
const data = (rows: ReturnType<typeof row>[]): InventoryResponse => inventoryResponseSchema.parse({ items: rows });
const view = (resource: Parameters<typeof InventoryView>[0]['resource']) => renderToString(<InventoryView resource={resource} />).replace(/<!-- -->/g, '');

describe('inventoryPath', () => {
  it('asks for the largest page the API allows, for exactly this business', () => {
    expect(inventoryPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/operations/inventory?limit=${INVENTORY_LIMIT}`);
    expect(INVENTORY_LIMIT).toBe(100);
  });
  it('encodes an id so it can never add path segments or a query', () => {
    expect(inventoryPath('a/b?x=1')).toBe(`/v1/businesses/a%2Fb%3Fx%3D1/operations/inventory?limit=100`);
  });
});

describe('stockFlag: restates the Business Operations low-stock comparison, nothing more', () => {
  it.each([
    [{ quantityAvailable: 15, reorderPoint: 10 }, 'none'],
    [{ quantityAvailable: 10, reorderPoint: 10 }, 'at-or-below-reorder-point'],   // at the point counts (<=), as in the BO rule
    [{ quantityAvailable: 3, reorderPoint: 10 }, 'at-or-below-reorder-point'],
    [{ quantityAvailable: 3, reorderPoint: 0 }, 'none'],                           // no reorder point set: no reorder flag
    [{ quantityAvailable: 0, reorderPoint: 0 }, 'none-available'],
    [{ quantityAvailable: 0, reorderPoint: 10 }, 'none-available'],               // none available outranks the reorder flag
    [{ quantityAvailable: -2, reorderPoint: 10 }, 'none-available'],              // reserved above on hand
  ])('%j is %s', (input, expected) => { expect(stockFlag(input)).toBe(expected); });
});

describe('formatQuantity and formatMovement', () => {
  it.each([[15, '15'], [12.5, '12.5'], [0.0001, '0.0001'], [1234567.8912, '1,234,567.8912'], [-2, '-2'], [0, '0']])('%d is shown as %s', (n, text) => { expect(formatQuantity(n)).toBe(text); });
  it('fails closed on a value that is not a finite number', () => {
    expect(formatQuantity(Number.NaN)).toBeNull();
    expect(formatQuantity(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('shows the last movement in UTC, and says so when there is none or it cannot be read', () => {
    expect(formatMovement('2026-03-10T08:30:00.000Z')).toBe('2026-03-10 08:30 UTC');
    expect(formatMovement(null)).toBe('no movement yet');
    expect(formatMovement('not a date')).toBe('unavailable');
  });
});

describe('response contract', () => {
  it('rejects a response that is not the Business Operations shape (missing field, string quantity, non-finite)', () => {
    expect(() => inventoryResponseSchema.parse({ items: [{ ...row(1), quantityOnHand: '20' }] })).toThrow();
    expect(() => inventoryResponseSchema.parse({ items: [{ ...row(1), sku: undefined }] })).toThrow();
    expect(() => inventoryResponseSchema.parse({ items: [{ ...row(1), itemName: 7 }] })).toThrow();
    expect(() => inventoryResponseSchema.parse({})).toThrow();
  });
});

describe('flagCounts and truncation', () => {
  it('counts rows by flag and never adds quantities', () => {
    const rows = data([row(1), row(2, { quantityAvailable: 4 }), row(3, { quantityAvailable: 0 }), row(4, { quantityAvailable: 0, reorderPoint: 0 })]).items;
    expect(flagCounts(rows)).toEqual({ rows: 4, noneAvailable: 2, atOrBelowReorderPoint: 1 });
  });
  it('treats a full page as possibly cut short, a shorter one as complete', () => {
    const many = Array.from({ length: INVENTORY_LIMIT }, (_, i) => row(i + 1));
    expect(mayBeTruncated(data(many).items)).toBe(true);
    expect(mayBeTruncated(data(many.slice(1)).items)).toBe(false);
  });
});

describe('InventoryView', () => {
  it('shows loading, error and empty states with the right roles', () => {
    expect(view({ kind: 'loading' })).toContain('role="status"');
    expect(view({ kind: 'loading' })).toContain('aria-busy="true"');
    expect(view({ kind: 'error', message: 'Could not load.' })).toMatch(/role="alert"[^>]*>Could not load\./);
    expect(view({ kind: 'ok', data: data([]) })).toContain('No stock is recorded for this business yet.');
  });
  it('shows each row exactly as returned, with its flag in words', () => {
    const out = view({ kind: 'ok', data: data([row(1), row(2, { quantityAvailable: 4, lastMovementAt: null }), row(3, { quantityOnHand: 0, quantityAvailable: 0, lastMovementAt: '2026-03-11T00:00:00.000Z' })]) });
    expect(out).toContain('Item 1'); expect(out).toContain('SKU-1');
    expect(out).toContain('2026-03-10 08:30 UTC');
    expect(out).toContain('no movement yet');
    expect(out).toContain('At or below reorder point</strong>');
    expect(out).toContain('None available</strong>');
    expect(out).toContain('Quantities are in each item&#x27;s own unit and are not added together.');
  });
  it('says when no reorder point is set instead of showing 0', () => {
    expect(view({ kind: 'ok', data: data([row(1, { reorderPoint: 0 })]) })).toContain('not set');
  });
  it('warns that a full page may be incomplete, and not otherwise', () => {
    const full = Array.from({ length: INVENTORY_LIMIT }, (_, i) => row(i + 1));
    expect(view({ kind: 'ok', data: data(full) })).toContain('There may be more that are not listed here.');
    expect(view({ kind: 'ok', data: data(full.slice(1)) })).not.toContain('There may be more');
  });
  it('shows a quantity it cannot display as unavailable rather than a guess', () => {
    const bad = { items: [{ ...row(1), quantityOnHand: 1 }] } as InventoryResponse;
    (bad.items[0] as { quantityOnHand: number }).quantityOnHand = Number.NaN;
    expect(view({ kind: 'ok', data: bad })).toContain('unavailable');
  });
  it('is read-only: no button, form or input exists', () => {
    const out = view({ kind: 'ok', data: data([row(1)]) });
    expect(out).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(out).not.toMatch(/\b(Delete|Order now|Adjust|Edit|Save|Transfer)\b/);
  });
});

describe('InventoryPage', () => {
  const scope = { tenantId: id(3), workspaceId: id(4) };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows no stock before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><InventoryPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    expect(ready).not.toContain('Stock by item');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><InventoryPage /></AuthContext.Provider>);
    expect(out).not.toContain('Stock by item');
  });
});
