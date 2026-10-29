import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  changeLabel, declaredCurrencyHistoryPath, declaredCurrencyHistorySchema, declaredCurrencyPath, declaredCurrencySchema, utcDateTime,
  type DeclaredCurrencyHistoryResponse, type DeclaredCurrencyResponse,
} from '../lib/client/businessAdministration';
import { BusinessView } from '../app/(client)/businesses/[businessId]/business/business-view';
import BusinessPage from '../app/(client)/businesses/[businessId]/business/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const decl = (n: number, over: Record<string, unknown> = {}) => ({
  declarationId: id(100 + n), version: n, currency: 'KWD', priorCurrency: null, supersedesVersion: null, provenance: 'EXPLICIT_DECLARATION',
  declaredByUserId: id(900), permissionUsed: 'platform:admin', reason: null, correlationId: id(300 + n), declaredAt: '2026-03-01T08:30:00.000Z', ...over,
});
const current = (d: ReturnType<typeof decl> | null): DeclaredCurrencyResponse =>
  declaredCurrencySchema.parse({ status: d ? 'DECLARED' : 'UNDECLARED', businessId: BUSINESS, declaration: d });
const history = (items: ReturnType<typeof decl>[]): DeclaredCurrencyHistoryResponse => declaredCurrencyHistorySchema.parse({ businessId: BUSINESS, items });
const ok = <T,>(data: T) => ({ kind: 'ok' as const, data });
const loading = { kind: 'loading' as const };
const html = (c: Parameters<typeof BusinessView>[0]['current'], h: Parameters<typeof BusinessView>[0]['history']) =>
  renderToString(<BusinessView current={c} history={h} />).replace(/<!-- -->/g, '');

describe('paths and helpers', () => {
  it('ask for this business and encode its id', () => {
    expect(declaredCurrencyPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/declared-currency`);
    expect(declaredCurrencyHistoryPath(BUSINESS)).toBe(`/v1/businesses/${BUSINESS}/declared-currency/history`);
    expect(declaredCurrencyPath('a/b?x=1')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/declared-currency');
  });
  it('shows UTC time and unavailable for an unreadable one', () => {
    expect(utcDateTime('2026-03-01T08:30:00.000Z')).toBe('2026-03-01 08:30 UTC');
    expect(utcDateTime('nope')).toBe('unavailable');
  });
  it('says whether a declaration was the first or a change', () => {
    expect(changeLabel({ currency: 'KWD', priorCurrency: null })).toBe('First declaration');
    expect(changeLabel({ currency: 'USD', priorCurrency: 'KWD' })).toBe('Changed from KWD to USD');
  });
});

describe('response contracts', () => {
  it('reject a status that disagrees with the declaration, a wrong provenance and a missing field', () => {
    expect(() => declaredCurrencySchema.parse({ status: 'DECLARED', businessId: BUSINESS, declaration: null })).toThrow();
    expect(() => declaredCurrencySchema.parse({ status: 'UNDECLARED', businessId: BUSINESS, declaration: decl(1) })).toThrow();
    expect(() => declaredCurrencyHistorySchema.parse({ businessId: BUSINESS, items: [decl(1, { provenance: 'DEFAULT' })] })).toThrow();
    const { currency: _c, ...missing } = decl(1);
    expect(() => declaredCurrencyHistorySchema.parse({ businessId: BUSINESS, items: [missing] })).toThrow();
  });
});

describe('view states', () => {
  it('shows loading for both sections', () => {
    const h = html(loading, loading);
    expect(h).toContain('Loading the declared currency');
    expect(h).toContain('Loading the history');
    expect(h).toContain('aria-busy="true"');
  });
  it('shows an error as an alert', () => {
    const h = html({ kind: 'error', message: 'You do not have permission.' } as never, loading);
    expect(h).toContain('role="alert"');
    expect(h).toContain('You do not have permission.');
  });
  it('says plainly that an undeclared business has no default', () => {
    const h = html(ok(current(null)), ok(history([])));
    expect(h).toContain('has not declared a currency yet. No default is assumed.');
    expect(h).toContain('No currency has ever been declared');
  });
  it('shows the declared currency exactly as returned, with its reason', () => {
    const h = html(ok(current(decl(2, { currency: 'USD', priorCurrency: 'KWD', reason: 'Trading in dollars' }))), ok(history([decl(1), decl(2, { currency: 'USD', priorCurrency: 'KWD', reason: 'Trading in dollars' })])));
    expect(h).toContain('USD');
    expect(h).toContain('Changed from KWD to USD');
    expect(h).toContain('Trading in dollars');
    expect(h).toContain('First declaration');
    expect(h.indexOf('First declaration')).toBeLessThan(h.lastIndexOf('Changed from KWD to USD'));
  });
  it('escapes a reason as text', () => {
    const h = html(ok(current(decl(1, { reason: '<script>alert(1)</script>' }))), loading);
    expect(h).not.toContain('<script>alert');
    expect(h).toContain('&lt;script&gt;');
  });
  it('is read-only: no form, button or input, and it says it does not change anything', () => {
    const h = html(ok(current(decl(1))), ok(history([decl(1)])));
    expect(h).not.toMatch(/<(form|button|input|select|textarea)\b/);
    expect(h).toContain('does not declare or change it');
  });
});

describe('page', () => {
  it('asks the signed-out visitor to sign in instead of reading anything', () => {
    const value = { state: { status: 'signed-out' }, scope: null } as unknown as AuthContextValue;
    const h = renderToString(<AuthContext.Provider value={value}><BusinessPage /></AuthContext.Provider>);
    expect(h).not.toContain('Declared currency');
  });
});
