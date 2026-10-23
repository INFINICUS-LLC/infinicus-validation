import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { coverageText, financialReportPath, financialReportSchema, granularityFor, groupDecimal, isDecimalText, type FinancialReport } from '../lib/client/financialReport';
import { FinanceView } from '../app/(client)/businesses/[businessId]/finance/finance-view';
import FinancePage from '../app/(client)/businesses/[businessId]/finance/page';
import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';

vi.mock('../app/(client)/use-scoped-resource', () => ({ useScopedResource: () => ({ resource: { kind: 'loading' }, reload: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useParams: () => ({ businessId: '00000000-0000-4000-8000-000000000002' }) }));

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const delta = (over: Record<string, unknown> = {}) => ({ current: '1500.000', previous: '1000.000', change: '500.000', changePercent: '50.00', state: 'OK', ...over });
const figures = (code = 'KWD', over: Record<string, unknown> = {}) => ({
  currency: code,
  revenue: { amount: '1500.000', count: 12 },
  averageOrderValue: { amount: '125.000', state: 'OK' },
  expenses: { amount: '400.500', count: 3 },
  goodsReceived: { amount: '250.000', count: 2 },
  grossProfit: { state: 'COMPUTED', amount: '600.000', marginPercent: '40.00', evidence: { saleLines: 20, saleLinesWithCostEvidence: 20 } },
  ...over,
});
const range = { from: '2026-03-01', to: '2026-03-31' };
const report = (over: Record<string, unknown> = {}): FinancialReport => financialReportSchema.parse({
  contract: 'bi-financial-report/1', basedOn: 'bo-financial-facts/1', businessId: BUSINESS,
  period: { range, currencies: [figures()] },
  comparison: { range: { from: '2026-01-29', to: '2026-02-28' }, currencies: [figures()], deltas: [{ currency: 'KWD', revenue: delta(), expenses: delta({ current: '400.500', previous: '0.000', change: '400.500', changePercent: null, state: 'NO_BASELINE' }), orderCount: delta({ current: '12', previous: '10', change: '2', changePercent: '20.00' }), grossProfit: delta() }] },
  trend: { granularity: 'day', buckets: [{ start: '2026-03-01', end: '2026-03-01', currencies: [{ currency: 'KWD', revenue: '100.000', expenses: '0.000', orderCount: 1 }] }] },
  ordersByStatus: [{ status: 'completed', count: 12 }, { status: 'failed', count: 1 }],
  indicators: [{ metricCode: 'CSAT', metricName: 'Customer satisfaction', category: 'customers', unit: 'pts', value: '4.5', target: '4.8', variance: '-0.3', periodStart: '2026-03-01', periodEnd: '2026-03-31' }],
  coverage: ['REVENUE_IS_COMPLETED_ORDERS_ONLY', 'NO_CURRENCY_CONVERSION', 'SOMETHING_NEW_FROM_THE_SERVER'],
  ...over,
});
const view = (resource: Parameters<typeof FinanceView>[0]['resource']) =>
  renderToString(<FinanceView period={range} resource={resource} onApply={vi.fn()} today="2026-03-31" />).replace(/<!-- -->/g, '');
/** The visible text of a rendered view (tags removed), so a figure and its percentage can be read together. */
const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('groupDecimal and isDecimalText: the server decimal is only regrouped, never converted', () => {
  it.each([['1500.000', '1,500.000'], ['1234567.8912', '1,234,567.8912'], ['-2.5', '-2.5'], ['0', '0'], ['999', '999'], ['1000', '1,000'], ['-1234.50', '-1,234.50']])('%s is shown as %s', (a, b) => { expect(groupDecimal(a)).toBe(b); });
  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', '1e5', '1,000', '1.2.3', '.5', '5.', '--1', 'abc', ' 1']) expect(groupDecimal(bad), bad).toBeNull();
  });
  it('accepts at most four decimal digits, as the API contract does', () => {
    expect(isDecimalText('12.3456')).toBe(true);
    expect(isDecimalText('12.34567')).toBe(false);
    expect(isDecimalText('-0.5')).toBe(true);
    expect(isDecimalText('1e3')).toBe(false);
  });
});

describe('request path and granularity', () => {
  it('asks for this business, the exact period, previous-period comparison and a granularity that keeps the trend readable', () => {
    expect(financialReportPath(BUSINESS, '2026-03-01', '2026-03-31')).toBe(`/v1/businesses/${BUSINESS}/intelligence/financial-report?from=2026-03-01&to=2026-03-31&granularity=day&compare=previous`);
    expect(financialReportPath('a/b?x=1', '2026-03-01', '2026-03-02')).toContain('/v1/businesses/a%2Fb%3Fx%3D1/intelligence/');
  });
  it.each([['2026-03-01', '2026-03-01', 'day'], ['2026-03-01', '2026-03-31', 'day'], ['2026-03-01', '2026-04-01', 'week'], ['2026-01-01', '2026-07-05', 'week'], ['2026-01-01', '2026-07-06', 'month'], ['2026-01-01', '2026-12-31', 'month'], ['bad', '2026-12-31', 'day']])('%s to %s uses %s buckets', (f, t, g) => { expect(granularityFor(f, t)).toBe(g); });
});

describe('response contract', () => {
  it('rejects the wrong contract, a numeric amount, and an amount that is not a plain decimal', () => {
    const ok = JSON.parse(JSON.stringify(report()));
    expect(() => financialReportSchema.parse({ ...ok, contract: 'bi-financial-report/2' })).toThrow();
    const numeric = JSON.parse(JSON.stringify(ok)); numeric.period.currencies[0].revenue.amount = 1500;
    expect(() => financialReportSchema.parse(numeric)).toThrow();
    const bad = JSON.parse(JSON.stringify(ok)); bad.period.currencies[0].revenue.amount = '1,500.00';
    expect(() => financialReportSchema.parse(bad)).toThrow();
    const lowercase = JSON.parse(JSON.stringify(ok)); lowercase.period.currencies[0].currency = 'kwd';
    expect(() => financialReportSchema.parse(lowercase)).toThrow();
  });
});

describe('coverageText', () => {
  it('explains known notes, names the currency of the dynamic one, and shows an unknown note as sent', () => {
    expect(coverageText('NO_CURRENCY_CONVERSION')).toBe('Currencies are never converted or added together.');
    expect(coverageText('GROSS_PROFIT_COST_EVIDENCE_INCOMPLETE:KWD')).toContain('KWD');
    expect(coverageText('SOMETHING_NEW_FROM_THE_SERVER')).toBe('SOMETHING_NEW_FROM_THE_SERVER');
  });
});

describe('FinanceView', () => {
  it('shows loading and error states with the right roles', () => {
    expect(view({ kind: 'loading' })).toContain('aria-busy="true"');
    expect(view({ kind: 'loading' })).toContain('role="status"');
    expect(view({ kind: 'error', message: 'Could not load.' })).toMatch(/role="alert"[^>]*>Could not load\./);
  });
  it('shows each figure exactly as the server sent it, per currency, with grouping only', () => {
    const out = view({ kind: 'ok', data: report({ period: { range, currencies: [figures('KWD', { revenue: { amount: '1234567.500', count: 12 } }), figures('USD')] } }) });
    expect(out).toContain('KWD 1,234,567.500');
    expect(out).toContain('USD 1,500.000');
    expect(out).toContain('Revenue (12 orders)');
    expect(out).toContain('KWD 400.500');
    expect(out).toContain('Currencies are never converted or added together.');
    expect(out).not.toMatch(/Total|All currencies/);
  });
  it('shows gross profit with its margin when computed, and explains why not otherwise', () => {
    expect(plain(view({ kind: 'ok', data: report() }))).toContain('KWD 600.000 (40.00%)');
    const none = view({ kind: 'ok', data: report({ period: { range, currencies: [figures('KWD', { grossProfit: { state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null, evidence: { saleLines: 20, saleLinesWithCostEvidence: 15 } } })] } }) });
    expect(none).toContain('not shown: cost is recorded for 15 of 20 sale lines');
    const noRevenue = view({ kind: 'ok', data: report({ period: { range, currencies: [figures('KWD', { grossProfit: { state: 'NO_REVENUE', amount: null, marginPercent: null, evidence: { saleLines: 0, saleLinesWithCostEvidence: 0 } } })] } }) });
    expect(noRevenue).toContain('no revenue in this period');
  });
  it('says so when there are no orders or the currency has no average, instead of showing zero or a guess', () => {
    const out = view({ kind: 'ok', data: report({ period: { range, currencies: [figures('KWD', { averageOrderValue: { amount: null, state: 'NO_ORDERS' } })] } }) });
    expect(out).toContain('no orders yet');
    const unsupported = view({ kind: 'ok', data: report({ period: { range, currencies: [figures('KWD', { averageOrderValue: { amount: null, state: 'UNSUPPORTED_CURRENCY' } })] } }) });
    expect(unsupported).toContain('not available for this currency');
  });
  it('shows the comparison, and "no earlier figure" instead of a percentage when there is no baseline', () => {
    const out = view({ kind: 'ok', data: report() });
    expect(out).toContain('Compared with 2026-01-29 to 2026-02-28');
    expect(plain(out)).toContain('KWD 500.000 (50.00%)');
    expect(out).toContain('no earlier figure to compare with');
    expect(out).toContain('none recorded');
    const none = view({ kind: 'ok', data: report({ comparison: null }) });
    expect(none).not.toContain('Compared with');
  });
  it('shows the trend, orders by status, indicators and the coverage notes (an unknown note as sent)', () => {
    const out = view({ kind: 'ok', data: report() });
    expect(out).toContain('By day');
    expect(out).toContain('Orders by status');
    expect(out).toContain('Customer satisfaction');
    expect(out).toContain('Revenue counts completed orders only.');
    expect(out).toContain('SOMETHING_NEW_FROM_THE_SERVER');
  });
  it('says so when nothing was recorded in the period', () => {
    expect(view({ kind: 'ok', data: report({ period: { range, currencies: [] }, comparison: null, trend: { granularity: 'day', buckets: [] }, ordersByStatus: [], indicators: [] }) })).toContain('No sales or expenses were recorded in this period.');
  });
  it('is read-only: the only buttons choose a period, and nothing offers to change a figure', () => {
    const out = view({ kind: 'ok', data: report() });
    expect(out.match(/<button/g)).toHaveLength(4);       // three presets and one submit
    expect(out).not.toMatch(/\b(Delete|Approve|Pay|Edit|Save|Refund)\b/);
  });
  it('rejects a period the server would refuse before any request', () => {
    const out = renderToString(<FinanceView period={{ from: '2026-03-31', to: '2026-03-01' }} resource={{ kind: 'loading' }} onApply={vi.fn()} today="2026-03-31" />);
    expect(out).toContain('The end date cannot be before the start date.');
    expect(out).toContain('disabled');
  });
});

describe('FinancePage', () => {
  const scope = { tenantId: '00000000-0000-4000-8000-000000000003', workspaceId: '00000000-0000-4000-8000-000000000004' };
  const value: AuthContextValue = { state: { status: 'ready', email: 'staff@example.test', scope, memberships: [] }, api: null, signIn: async () => ({ ok: true }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined };
  it('shows no figures before the business address is known (server render), and nothing at all when signed out', () => {
    const ready = renderToString(<AuthContext.Provider value={value}><FinancePage /></AuthContext.Provider>);
    expect(ready).toContain('business address is not valid');
    const out = renderToString(<AuthContext.Provider value={{ ...value, state: { status: 'signed-out' } }}><FinancePage /></AuthContext.Provider>);
    expect(out).not.toContain('Finance overview');
  });
});
