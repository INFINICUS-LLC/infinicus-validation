/** NEW-BDT-01: assembly, provenance, integrity and cross-check of the BI -> BDT performance evidence (pure; no database, no clock). */
import { describe, expect, it } from 'vitest';
import {
  BI_PERFORMANCE_EVIDENCE_CONTRACT, BO_FINANCIAL_FACTS_CONTRACT, validateBiPerformanceEvidenceShape, type BiPerformanceEvidence, type FinancialFacts,
} from '@infinicus/handoff-contracts';
import { buildFinancialReport } from '../src/financial/financialReport.js';
import type { FinancialReportOutcome } from '../src/financial/FinancialIntelligenceService.js';
import type { SalesCurrencySection, SalesReport, SalesReportResult } from '../src/SalesReportService.js';
import { assembleBiPerformanceEvidence, canonicalJson, crossCheckRevenue, digestOf, verifyBiPerformanceEvidence } from '../src/performance/biPerformanceEvidence.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

const finFacts = (over: Partial<FinancialFacts> = {}): FinancialFacts => ({
  contract: BO_FINANCIAL_FACTS_CONTRACT, businessId: BIZ, range: PERIOD, completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0,
  goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [], ...over,
});
const financial = (over: Partial<FinancialFacts> = {}): FinancialReportOutcome => ({ outcome: 'REPORT', report: buildFinancialReport({ current: finFacts(over), previous: null, granularity: 'month' }) });
const section = (code: string, exponent: number, over: Partial<SalesCurrencySection['totals']> = {}): SalesCurrencySection => ({
  currency: { code, minorUnitExponent: exponent },
  totals: { completedOrders: 0, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 0, discountMinor: 0, netMinor: 0, averageOrderNetMinor: null, reconciles: true, ...over },
  daily: [],
});
const salesReport = (currencies: SalesCurrencySection[], over: Partial<SalesReport> = {}): SalesReportResult => ({
  outcome: 'REPORT',
  report: { businessId: BIZ, period: { ...PERIOD, days: 31, basis: 'order_date', inclusive: true }, source: { layer: 'BO', definition: 'completed orders; net = order total; gross = non-discount lines; discounts = discount lines' }, currencies, ...over },
});
// USD 150.00 over 2 orders, KWD 31.500 over 1 order: the financial and the sales view of the SAME completed orders.
const orders = [
  { date: '2026-10-05', currency: 'USD', amount: '150.0000', count: 2 }, { date: '2026-10-20', currency: 'KWD', amount: '31.5000', count: 1 },
];
const goodFin = () => financial({ completedOrders: orders });
const goodSales = () => salesReport([
  section('KWD', 3, { completedOrders: 1, netMinor: 31500, grossMinor: 31500, averageOrderNetMinor: 31500 }),
  section('USD', 2, { completedOrders: 2, voidedOrders: 1, netMinor: 15000, grossMinor: 15000, averageOrderNetMinor: 7500 }),
]);
const assemble = (f = goodFin(), s = goodSales(), period = PERIOD, businessId = BIZ) => assembleBiPerformanceEvidence({ businessId, period, financial: f, sales: s });
const ok = (r: ReturnType<typeof assemble>): BiPerformanceEvidence => { if (!r.ok) throw new Error(`${r.code}: ${r.detail}`); return r.evidence; };

describe('canonical JSON and digests', () => {
  it('is independent of key order and sensitive to every value', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(digestOf({ a: [1, 2] })).not.toBe(digestOf({ a: [2, 1] }));
    expect(digestOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('assembly: both BI reports provided', () => {
  const e = ok(assemble());
  it('owns its sealed evidence independently of mutable BI reports and the caller period', () => {
    const f = goodFin(); const s = goodSales(); const p = { ...PERIOD };
    const sealed = ok(assemble(f, s, p));
    const before = structuredClone(sealed);
    if (f.outcome !== 'REPORT' || s.outcome !== 'REPORT') throw new Error('expected reports');
    f.report.period.currencies[0]!.revenue.amount = '999.0000';
    f.report.coverage.push('MUTATED');
    s.report.currencies[0]!.totals.netMinor = 999;
    p.from = '2026-09-01';
    expect(sealed).toEqual(before);
    expect(verifyBiPerformanceEvidence(sealed)).toEqual({ valid: true, reasons: [] });
  });
  it('keeps currencies separate, sorted, and the figures VERBATIM from the BI reports (nothing recalculated, nothing converted)', () => {
    expect(e.contract).toBe(BI_PERFORMANCE_EVIDENCE_CONTRACT);
    if (e.financial.status !== 'PROVIDED' || e.sales.status !== 'PROVIDED') throw new Error('expected provided');
    const fin = goodFin(); if (fin.outcome !== 'REPORT') throw new Error('x');
    expect(e.financial.currencies).toEqual(fin.report.period.currencies);
    expect(e.financial.currencies.map((c) => c.currency)).toEqual(['KWD', 'USD']);
    expect(e.sales.currencies.map((c) => [c.currency, c.minorUnitExponent, c.netMinor])).toEqual([['KWD', 3, 31500], ['USD', 2, 15000]]);
    expect(e.financial.coverage).toContain('NO_CURRENCY_CONVERSION');
    expect(JSON.stringify(e)).not.toMatch(/"(total|combined|allCurrencies|netProfit|profit)"/);
  });
  it('cross-checks the two independently derived revenues exactly (decimal vs minor units, per currency)', () => {
    expect(e.crossCheck).toEqual({ performed: true, revenue: [{ currency: 'KWD', state: 'AGREE' }, { currency: 'USD', state: 'AGREE' }] });
  });
  it('records provenance: contract, the reporting period and a SHA-256 of each source report', () => {
    if (e.financial.status !== 'PROVIDED' || e.sales.status !== 'PROVIDED') throw new Error('expected provided');
    expect(e.financial.provenance).toMatchObject({ contract: 'bi-financial-report/1', period: PERIOD });
    expect(e.sales.provenance).toMatchObject({ contract: 'bi-sales-report (BI-SALES-1)', period: PERIOD });
    expect(e.financial.provenance.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(e.financial.provenance.digest).not.toBe(e.sales.provenance.digest);
    const fin = goodFin(); const sal = goodSales();
    if (fin.outcome !== 'REPORT' || sal.outcome !== 'REPORT') throw new Error('x');
    expect(e.financial.provenance.digest).toBe(digestOf(fin.report));       // the digest of the source report AS RECEIVED, not of a copy
    expect(e.sales.provenance.digest).toBe(digestOf(sal.report));
    const changed = goodFin(); if (changed.outcome !== 'REPORT') throw new Error('x');
    changed.report.trend.buckets[0]!.currencies[0]!.orderCount += 1;          // a source change outside the copied figures still changes the provenance
    const e2 = ok(assemble(changed));
    expect(e2.financial.status === 'PROVIDED' && e2.financial.provenance.digest).not.toBe(e.financial.status === 'PROVIDED' && e.financial.provenance.digest);
  });
  it('is deterministic: the same BI reports always produce the same evidence and digest', () => {
    expect(ok(assemble())).toEqual(e);
    expect(ok(assemble()).evidenceDigest).toBe(e.evidenceDigest);
  });
  it('validates structurally and verifies against its own digest', () => {
    expect(validateBiPerformanceEvidenceShape(e)).toEqual({ valid: true, reasons: [] });
    expect(verifyBiPerformanceEvidence(e)).toEqual({ valid: true, reasons: [] });
  });
});

describe('insufficient evidence is carried as the BI state, never as a value', () => {
  it('gross profit without cost evidence stays INSUFFICIENT_COST_EVIDENCE with no amount', () => {
    const e = ok(assemble());
    if (e.financial.status !== 'PROVIDED') throw new Error('x');
    const usd = e.financial.currencies.find((c) => c.currency === 'USD')!;
    expect(usd.grossProfit).toMatchObject({ state: 'INSUFFICIENT_COST_EVIDENCE', amount: null, marginPercent: null });
  });
  it('an expense-only currency has no revenue on either side and is NOT_COMPARABLE, not a disagreement', () => {
    const f = financial({ completedOrders: orders, expenseItems: [{ date: '2026-10-07', currency: 'EUR', amount: '9.0000', count: 1 }] });
    const e = ok(assemble(f));
    expect(e.crossCheck.revenue).toEqual([{ currency: 'EUR', state: 'NOT_COMPARABLE' }, { currency: 'KWD', state: 'AGREE' }, { currency: 'USD', state: 'AGREE' }]);
  });
  it('a sales currency with only voided or open orders and no completed revenue is NOT_COMPARABLE', () => {
    const s = salesReport([section('USD', 2, { completedOrders: 2, netMinor: 15000, grossMinor: 15000 }), section('KWD', 3, { voidedOrders: 1 }), section('EUR', 2, { openOrders: 3 })].sort((a, b) => (a.currency.code < b.currency.code ? -1 : 1)));
    const e = ok(assemble(financial({ completedOrders: [orders[0]!] }), s));
    expect(e.crossCheck.revenue.find((r) => r.currency === 'EUR')!.state).toBe('NOT_COMPARABLE');
  });
});

describe('missing evidence', () => {
  const finDown: FinancialReportOutcome = { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'financial facts are down' };
  const salesDown: SalesReportResult = { outcome: 'NOT_AVAILABLE', code: 'AMOUNT_NOT_REPRESENTABLE', detail: 'a sale cannot be stated exactly' };
  it('one unavailable domain is represented as MISSING with its code and no figures; the other is kept; no cross-check is performed', () => {
    const e = ok(assemble(finDown, goodSales()));
    expect(e.financial).toEqual({ status: 'MISSING', code: 'FACTS_UNAVAILABLE', detail: 'financial facts are down' });
    expect(e.sales.status).toBe('PROVIDED');
    expect(e.crossCheck).toEqual({ performed: false, revenue: [] });
    const e2 = ok(assemble(goodFin(), salesDown));
    expect(e2.sales).toEqual({ status: 'MISSING', code: 'AMOUNT_NOT_REPRESENTABLE', detail: 'a sale cannot be stated exactly' });
    expect(verifyBiPerformanceEvidence(e2).valid).toBe(true);
  });
  it('both domains unavailable is BI_EVIDENCE_MISSING naming both causes', () => {
    const r = assemble(finDown, salesDown);
    expect(r).toMatchObject({ ok: false, code: 'BI_EVIDENCE_MISSING' });
    expect(!r.ok && r.detail).toContain('FACTS_UNAVAILABLE');
  });
  it('nothing recorded in the period is BI_EVIDENCE_INSUFFICIENT (absence of data is not data), including with one domain unavailable', () => {
    expect(assemble(financial(), salesReport([]))).toMatchObject({ ok: false, code: 'BI_EVIDENCE_INSUFFICIENT' });
    expect(assemble(finDown, salesReport([]))).toMatchObject({ ok: false, code: 'BI_EVIDENCE_INSUFFICIENT' });
  });
  it('expenses recorded with no completed sale still publish; the sales side with only voided orders has no revenue to compare', () => {
    const e = ok(assemble(financial({ expenseItems: [{ date: '2026-10-07', currency: 'EUR', amount: '9.0000', count: 1 }] }), salesReport([section('EUR', 2, { voidedOrders: 1 })])));
    expect(e.crossCheck).toEqual({ performed: true, revenue: [{ currency: 'EUR', state: 'NOT_COMPARABLE' }] });
  });
  it('completed sales next to an empty financial report is a disagreement, never silently accepted', () => {
    expect(assemble(financial(), goodSales())).toMatchObject({ ok: false, code: 'BI_EVIDENCE_INCONSISTENT' });
  });
});

describe('reporting-period, business and cross-report consistency are enforced', () => {
  const refused = (r: ReturnType<typeof assemble>) => { expect(r).toMatchObject({ ok: false, code: 'BI_EVIDENCE_INCONSISTENT' }); return r.ok ? '' : r.detail; };
  it('a financial report for another period is refused', () => {
    const f = financial(); if (f.outcome !== 'REPORT') throw new Error('x');
    f.report.period.range = { from: '2026-09-01', to: '2026-09-30' };
    expect(refused(assemble(f))).toContain('different reporting period');
  });
  it('a sales report for another period is refused', () => {
    const s = goodSales(); if (s.outcome !== 'REPORT') throw new Error('x');
    s.report.period = { ...s.report.period, to: '2026-10-30' };
    expect(refused(assemble(goodFin(), s))).toContain('different reporting period');
  });
  it('a report about another business is refused (cross-business isolation at the evidence boundary)', () => {
    const f = financial(); if (f.outcome !== 'REPORT') throw new Error('x');
    f.report.businessId = '22222222-2222-4222-8222-222222222222';
    expect(refused(assemble(f))).toContain('another business');
    const s = goodSales(); if (s.outcome !== 'REPORT') throw new Error('x');
    s.report.businessId = '22222222-2222-4222-8222-222222222222';
    expect(refused(assemble(goodFin(), s))).toContain('another business');
  });
  it('an invalid financial report (unsorted currencies, wrong contract) is refused', () => {
    const f = goodFin(); if (f.outcome !== 'REPORT') throw new Error('x');
    f.report.period.currencies.reverse();
    expect(refused(assemble(f))).toContain('structurally invalid');
    const g = goodFin(); if (g.outcome !== 'REPORT') throw new Error('x');
    (g.report as { contract: string }).contract = 'bi-financial-report/9';
    expect(refused(assemble(g))).toContain('structurally invalid');
  });
  it('sales currencies that are duplicated, unsorted, malformed or not exact integers are refused', () => {
    const dup = salesReport([section('USD', 2, { completedOrders: 1, netMinor: 100 }), section('USD', 2, { completedOrders: 1, netMinor: 100 })]);
    expect(refused(assemble(goodFin(), dup))).toContain('duplicated or not sorted');
    expect(refused(assemble(goodFin(), salesReport([section('USD', 2), section('KWD', 3)])))).toContain('duplicated or not sorted');
    expect(refused(assemble(goodFin(), salesReport([section('usd', 2)])))).toContain('not valid');
    expect(refused(assemble(goodFin(), salesReport([section('USD', 7)])))).toContain('not valid');
    expect(refused(assemble(goodFin(), salesReport([section('USD', 2, { netMinor: 1.5 })])))).toContain('not exact integers');
    expect(refused(assemble(goodFin(), salesReport([section('USD', 2, { completedOrders: -1 })])))).toContain('not exact integers');
  });
  it('revenue amounts that disagree between the two BI reports are refused, for the currency concerned', () => {
    const s = goodSales(); if (s.outcome !== 'REPORT') throw new Error('x');
    s.report.currencies[1]!.totals.netMinor = 15001;
    expect(refused(assemble(goodFin(), s))).toContain('USD');
    const t = goodSales(); if (t.outcome !== 'REPORT') throw new Error('x');
    t.report.currencies[0]!.totals.netMinor = 3150;          // a 10x exponent slip on KWD
    expect(refused(assemble(goodFin(), t))).toContain('KWD');
  });
  it('order counts that disagree are refused, and so is a currency present on one side only with completed revenue', () => {
    const s = goodSales(); if (s.outcome !== 'REPORT') throw new Error('x');
    s.report.currencies[1]!.totals.completedOrders = 3;
    expect(refused(assemble(goodFin(), s))).toContain('USD');
    expect(refused(assemble(goodFin(), salesReport([section('USD', 2, { completedOrders: 2, netMinor: 15000 })])))).toContain('KWD');
    expect(refused(assemble(financial({ completedOrders: [orders[0]!] }), goodSales()))).toContain('KWD');
  });
});

describe('crossCheckRevenue', () => {
  it('compares exact amounts at the currency exponent (JPY 0 decimals, KWD 3, a 4-decimal unit)', () => {
    const fin = (currency: string, amount: string, count: number) => ({ currency, revenue: { amount, count } }) as never;
    const sal = (currency: string, exponent: number, netMinor: number, completedOrders: number) => ({ currency, minorUnitExponent: exponent, netMinor, completedOrders }) as never;
    expect(crossCheckRevenue([fin('JPY', '3000', 1)], [sal('JPY', 0, 3000, 1)])).toEqual({ ok: true, revenue: [{ currency: 'JPY', state: 'AGREE' }] });
    expect(crossCheckRevenue([fin('JPY', '3000', 1)], [sal('JPY', 0, 3001, 1)])).toEqual({ ok: false, currency: 'JPY' });
    expect(crossCheckRevenue([fin('CLF', '1.2345', 1)], [sal('CLF', 4, 12345, 1)])).toMatchObject({ ok: true });
    expect(crossCheckRevenue([fin('KWD', '0.001', 1)], [sal('KWD', 3, 1, 1)])).toMatchObject({ ok: true });
  });
});

describe('integrity verification of a stored evidence', () => {
  const tamper = (mutate: (e: any) => void): string[] => { const e = structuredClone(ok(assemble())) as any; mutate(e); return verifyBiPerformanceEvidence(e).reasons; };
  it('detects a changed figure, a changed period, a swapped digest and a removed currency', () => {
    expect(tamper((e) => { e.financial.currencies[0].revenue.amount = '999.00'; })).toContain('evidence_digest_mismatch');
    expect(tamper((e) => { e.sales.currencies[1].netMinor += 1; })).toContain('evidence_digest_mismatch');
    expect(tamper((e) => { e.financial.currencies.pop(); })).toContain('evidence_digest_mismatch');
    expect(tamper((e) => { e.crossCheck.revenue[0].state = 'NOT_COMPARABLE'; })).toContain('evidence_digest_mismatch');
    expect(tamper((e) => { e.evidenceDigest = '0'.repeat(64); })).toContain('evidence_digest_mismatch');
  });
  it('rejects structurally broken evidence', () => {
    expect(tamper((e) => { e.contract = 'x'; })).toContain('contract_unsupported');
    expect(tamper((e) => { e.evidenceDigest = 'short'; })).toContain('evidence_digest_invalid');
    expect(tamper((e) => { e.period = { from: '2026-11-01', to: '2026-10-01' }; })).toContain('period_invalid');
    expect(tamper((e) => { e.financial.provenance.period = { from: '2026-09-01', to: '2026-09-30' }; })).toContain('financial_period_mismatch');
    expect(tamper((e) => { e.sales.currencies.push({ ...e.sales.currencies[0] }); })).toContain('sales_currency_duplicated');
    expect(tamper((e) => { e.sales.currencies.reverse(); })).toContain('sales_currencies_not_sorted');
    expect(tamper((e) => { e.crossCheck.performed = false; })).toContain('cross_check_inconsistent_with_domains');
    expect(tamper((e) => { e.financial = { status: 'MISSING', code: 'X', detail: 'd', currencies: [] }; })).toContain('financial_missing_domain_carries_figures');
    expect(verifyBiPerformanceEvidence(null)).toEqual({ valid: false, reasons: ['not_an_object'] });
  });
});
