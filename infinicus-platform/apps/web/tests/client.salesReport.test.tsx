import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  barPercent, dayNumber, formatMinor, localDate, periodProblem, presetPeriod, salesReportPath, salesReportResponseSchema, MAX_REPORT_DAYS,
  type SalesReportResponse,
} from '../lib/client/salesReport';
import { SalesReportView } from '../app/(client)/businesses/[businessId]/reports/report-view';
import ReportsPage from '../app/(client)/businesses/[businessId]/reports/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const point = (over: Record<string, number> = {}) => ({ completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossMinor: 5250, discountMinor: 500, netMinor: 4750, ...over });
const report = (over: Partial<{ currencies: unknown[] }> = {}): SalesReportResponse => salesReportResponseSchema.parse({
  outcome: 'REPORT',
  report: {
    businessId: BUSINESS, period: { from: '2026-03-10', to: '2026-03-11', days: 2, basis: 'order_date', inclusive: true },
    source: { layer: 'BO', definition: 'completed orders' },
    currencies: over.currencies ?? [{
      currency: { code: 'KWD', minorUnitExponent: 3 },
      totals: { ...point(), averageOrderNetMinor: 2375, reconciles: true },
      daily: [{ date: '2026-03-10', ...point() }, { date: '2026-03-11', ...point({ completedOrders: 0, voidedOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 }) }],
    }],
  },
});
const view = (resource: Parameters<typeof SalesReportView>[0]['resource'], period = { from: '2026-03-10', to: '2026-03-11' }) =>
  renderToString(<SalesReportView period={period} resource={resource} onApply={vi.fn()} today="2026-03-11" />).replace(/<!-- -->/g, '');   // React separates adjacent text nodes with comments

describe('formatMinor: exact display of integer minor units', () => {
  it.each([
    [4750, 3, 'KWD', '4.750'], [5, 3, 'KWD', '0.005'], [0, 3, 'KWD', '0.000'], [1500, 0, 'JPY', '1,500'], [123456789, 2, 'USD', '1,234,567.89'],
    [-250, 2, 'USD', '-2.50'], [9007199254740991, 2, 'USD', '90,071,992,547,409.91'], [12, 4, 'CLF', '0.0012'],
  ])('%i at exponent %i (%s) is %s', (minor, exp, code, expected) => { expect(formatMinor(minor, exp, code)).toBe(expected); });
  it('fails closed: a non-integer, an unsafe integer, or an exponent that disagrees with the currency is not displayed', () => {
    expect(formatMinor(1.5, 2, 'USD')).toBeNull();
    expect(formatMinor(Number.MAX_SAFE_INTEGER + 2, 2, 'USD')).toBeNull();
    expect(formatMinor(100, 2, 'KWD')).toBeNull();              // KWD has 3 decimals: a server claiming 2 is refused
    expect(formatMinor(100, 3, 'XXX')).toBeNull();              // unknown currency
    expect(formatMinor(Number.NaN, 2, 'USD')).toBeNull();
  });
});

describe('period helpers', () => {
  it('validates real calendar dates only', () => {
    expect(dayNumber('2026-03-10')).not.toBeNull();
    for (const bad of ['2026-02-30', '2026-13-01', '26-03-10', '2026-3-1', '', 'x']) expect(dayNumber(bad), bad).toBeNull();
  });
  it('the presets end today and include both ends', () => {
    expect(presetPeriod('today', '2026-03-10')).toEqual({ from: '2026-03-10', to: '2026-03-10' });
    expect(presetPeriod('last7', '2026-03-10')).toEqual({ from: '2026-03-04', to: '2026-03-10' });
    expect(presetPeriod('last30', '2026-03-10')).toEqual({ from: '2026-02-09', to: '2026-03-10' });
    expect(presetPeriod('last7', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });      // across a year end
    expect(() => presetPeriod('today', 'nope')).toThrow(RangeError);
  });
  it('explains why a period cannot be requested, with the same rules as the server', () => {
    expect(periodProblem('2026-03-10', '2026-03-10')).toBeNull();
    expect(periodProblem('', '2026-03-10')).toMatch(/start date/);
    expect(periodProblem('2026-03-10', '')).toMatch(/end date/);
    expect(periodProblem('2026-03-11', '2026-03-10')).toMatch(/before/);
    expect(periodProblem('2024-01-01', '2024-12-31')).toBeNull();                    // 366 days (leap year)
    expect(periodProblem('2024-01-01', '2025-01-01')).toMatch(new RegExp(String(MAX_REPORT_DAYS)));
  });
  it('localDate is the device calendar date, zero padded', () => { expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05'); });
  it('builds the API path with the business and the period encoded', () => {
    expect(salesReportPath(BUSINESS, '2026-03-10', '2026-03-11')).toBe(`/v1/businesses/${BUSINESS}/bi/sales-report?from=2026-03-10&to=2026-03-11`);
  });
  it('barPercent is a bounded integer share of the largest day', () => {
    expect([barPercent(0, 0), barPercent(5, 10), barPercent(10, 10), barPercent(-3, 10), barPercent(20, 10)]).toEqual([0, 50, 100, 0, 100]);
  });
});

describe('response contract', () => {
  it('rejects a response that is not the contract: float money, unknown outcome, a different basis', () => {
    expect(() => salesReportResponseSchema.parse({ outcome: 'REPORT', report: { ...(report() as { report: object }).report, currencies: [{ currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { ...point({ netMinor: 4.75 }), averageOrderNetMinor: null, reconciles: true }, daily: [] }] } })).toThrow();
    expect(() => salesReportResponseSchema.parse({ outcome: 'SOMETHING' })).toThrow();
    expect(() => salesReportResponseSchema.parse({ outcome: 'REPORT', report: { ...(report() as { report: { period: object } }).report, period: { from: 'a', to: 'b', days: 1, basis: 'created_at', inclusive: true } } })).toThrow();
  });
});

describe('SalesReportView', () => {
  it('shows the server figures exactly, per currency, with a daily table and labelled KPIs', () => {
    const out = view({ kind: 'ok', data: report() });
    expect(out).toContain('KWD sales');
    expect(out).toContain('KWD 4.750');            // net
    expect(out).toContain('KWD 2.375');            // average
    expect(out).toContain('KWD 5.250');            // gross
    expect(out).toContain('KWD 0.500');            // discounts
    expect(out).toContain('<caption>Net sales by order date</caption>');
    expect(out).toContain('2026-03-10');
    expect(out).toContain('2026-03-11');
    expect(out).not.toContain('do not reconcile');
  });
  it('keeps currencies in separate sections and never adds them together', () => {
    const out = view({ kind: 'ok', data: report({ currencies: [
      { currency: { code: 'JPY', minorUnitExponent: 0 }, totals: { ...point({ grossMinor: 1500, discountMinor: 0, netMinor: 1500 }), averageOrderNetMinor: 750, reconciles: true }, daily: [{ date: '2026-03-10', ...point({ grossMinor: 1500, discountMinor: 0, netMinor: 1500 }) }] },
      { currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { ...point(), averageOrderNetMinor: 2375, reconciles: true }, daily: [{ date: '2026-03-10', ...point() }] },
    ] }) });
    expect(out).toContain('JPY sales');
    expect(out).toContain('KWD sales');
    expect(out).toContain('JPY 1,500');
    expect(out).toContain('KWD 4.750');
  });
  it('says plainly when nothing was ordered and invents no figure', () => {
    const out = view({ kind: 'ok', data: report({ currencies: [] }) });
    expect(out).toContain('No orders were created between 2026-03-10 and 2026-03-11.');
    expect(out).not.toContain('sales</h2>');
  });
  it('states no average when nothing was sold', () => {
    const out = view({ kind: 'ok', data: report({ currencies: [{ currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { ...point({ completedOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 }), averageOrderNetMinor: null, reconciles: true }, daily: [{ date: '2026-03-10', ...point({ completedOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0 }) }] }] }) });
    expect(out).toContain('none yet');
  });
  it('flags a section that does not reconcile instead of hiding it', () => {
    const out = view({ kind: 'ok', data: report({ currencies: [{ currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { ...point(), averageOrderNetMinor: 2375, reconciles: false }, daily: [{ date: '2026-03-10', ...point() }] }] }) });
    expect(out).toContain('do not reconcile');
    expect(out).toContain('role="alert"');
  });
  it('shows no amount at all for a currency whose scale disagrees with the platform table (fails closed)', () => {
    const out = view({ kind: 'ok', data: report({ currencies: [{ currency: { code: 'KWD', minorUnitExponent: 2 }, totals: { ...point(), averageOrderNetMinor: 2375, reconciles: true }, daily: [{ date: '2026-03-10', ...point() }] }] }) });
    expect(out).toContain('could not be shown exactly');
    expect(out).not.toContain('4.75');
  });
  it('shows loading, error and not-available states with the right roles', () => {
    expect(view({ kind: 'loading' })).toContain('role="status">Loading the report');
    expect(view({ kind: 'error', message: 'You do not have access.' })).toMatch(/role="alert">You do not have access\./);
    const na = view({ kind: 'ok', data: salesReportResponseSchema.parse({ outcome: 'NOT_AVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: 'XXX on 2026-03-10' }) });
    expect(na).toContain('cannot be shown exactly right now (UNSUPPORTED_CURRENCY)');
  });
  it('has accessible period controls: labelled date inputs, preset buttons, and a disabled submit for an invalid period', () => {
    const ok = view({ kind: 'loading' });
    expect(ok).toContain('Today');
    expect(ok).toContain('Last 7 days');
    expect(ok).toContain('Last 30 days');
    expect(ok).toMatch(/<label>From <input type="date"/);
    expect(ok).toMatch(/<label>To <input type="date"/);
    const bad = view({ kind: 'loading' }, { from: '2026-03-12', to: '2026-03-10' });
    expect(bad).toContain('The end date cannot be before the start date.');
    expect(bad).toMatch(/<button type="submit" disabled/);
  });
  it('is read-only: no control writes anything (the only buttons choose a period)', () => {
    const out = view({ kind: 'ok', data: report() });
    expect(out.match(/<button/g)).toHaveLength(4);       // three presets and one submit
    expect(out).not.toMatch(/\b(Delete|Void order|Refund|Edit|Save)\b/);
  });
});

describe('ReportsPage', () => {
  const scope = { tenantId: '00000000-0000-4000-8000-000000000003', workspaceId: '00000000-0000-4000-8000-000000000004' };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined };
  it('shows no report before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><ReportsPage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    expect(ready).not.toContain('KWD');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><ReportsPage /></AuthContext.Provider>);
    expect(out).not.toContain('Sales report');
  });
});
