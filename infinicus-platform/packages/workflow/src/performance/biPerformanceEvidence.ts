/**
 * Assembly and verification of the BI -> BDT performance evidence (NEW-BDT-01; contract `bi-performance-evidence/1`). Pure and database-free.
 *
 * It does NOT calculate a KPI. Every financial and sales figure is copied verbatim from the BI report that derived it; this module only
 *  1. verifies that each BI report is what was asked for (business, reporting period, contract, structure, unique and sorted currencies),
 *  2. records the provenance (contract, period, SHA-256 of the canonical source report as received),
 *  3. checks that the two independently derived reports AGREE on the revenue of each currency (a comparison, not a calculation) and refuses to represent a
 *     disagreement, and
 *  4. seals the result with an integrity digest so a stored copy can be verified later.
 * Money is never converted or summed across currencies: financial decimals and sales minor units stay in their own fields.
 */
import { createHash } from 'node:crypto';
import {
  BI_PERFORMANCE_EVIDENCE_CONTRACT, BI_FINANCIAL_REPORT_CONTRACT, validateBiPerformanceEvidenceShape, validateFinancialReport,
  type BiPerformanceEvidence, type DomainEvidence, type FinancialKpis, type FinancialReport, type PerformancePeriod, type RevenueCrossCheckState, type SalesKpis,
} from '@infinicus/handoff-contracts';
import { parseMoney } from '../financial/money.js';
import type { FinancialReportOutcome } from '../financial/FinancialIntelligenceService.js';
import type { SalesReport, SalesReportResult } from '../SalesReportService.js';

export const SALES_REPORT_PROVENANCE_CONTRACT = 'bi-sales-report (BI-SALES-1)';

export type PerformanceRefusalCode = 'BI_EVIDENCE_MISSING' | 'BI_EVIDENCE_INSUFFICIENT' | 'BI_EVIDENCE_INCONSISTENT';
export type AssembleResult = { ok: true; evidence: BiPerformanceEvidence } | { ok: false; code: PerformanceRefusalCode; detail: string };

/** Canonical JSON: object keys sorted recursively, arrays in order, `undefined` members omitted. The same value always yields the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
export const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));

const samePeriod = (a: PerformancePeriod, b: PerformancePeriod): boolean => a.from === b.from && a.to === b.to;
const sortedUnique = (codes: readonly string[]): boolean => new Set(codes).size === codes.length && codes.join(',') === [...codes].sort().join(',');

type Domain<F> = { ok: true; domain: DomainEvidence<F> } | { ok: false; detail: string };

function financialDomain(out: FinancialReportOutcome, businessId: string, period: PerformancePeriod): Domain<FinancialKpis> {
  if (out.outcome !== 'REPORT') return { ok: true, domain: { status: 'MISSING', code: out.code, detail: out.detail } };
  const report: FinancialReport = out.report;
  const check = validateFinancialReport(report);
  if (!check.valid) return { ok: false, detail: `the financial report is structurally invalid: ${check.reasons.join(',')}` };
  if (report.contract !== BI_FINANCIAL_REPORT_CONTRACT) return { ok: false, detail: 'the financial report has an unsupported contract' };
  if (report.businessId !== businessId) return { ok: false, detail: 'the financial report describes another business' };
  if (!samePeriod(report.period.range, period)) return { ok: false, detail: 'the financial report covers a different reporting period' };
  return {
    ok: true,
    domain: { status: 'PROVIDED', provenance: { contract: report.contract, digest: digestOf(report), period }, coverage: [...report.coverage], currencies: report.period.currencies },
  };
}

function salesDomain(out: SalesReportResult, businessId: string, period: PerformancePeriod): Domain<SalesKpis> {
  if (out.outcome !== 'REPORT') return { ok: true, domain: { status: 'MISSING', code: out.code, detail: out.detail } };
  const report: SalesReport = out.report;
  if (report.businessId !== businessId) return { ok: false, detail: 'the sales report describes another business' };
  if (report.period.from !== period.from || report.period.to !== period.to) return { ok: false, detail: 'the sales report covers a different reporting period' };
  if (!sortedUnique(report.currencies.map((c) => c.currency.code))) return { ok: false, detail: 'the sales report currencies are duplicated or not sorted' };
  const currencies: SalesKpis[] = [];
  for (const section of report.currencies) {
    const t = section.totals;
    const exponent = section.currency.minorUnitExponent;
    const counts = [t.completedOrders, t.voidedOrders, t.openOrders, t.otherStatusOrders];
    if (!/^[A-Z]{3}$/.test(section.currency.code) || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) return { ok: false, detail: `the sales report currency ${section.currency.code} is not valid` };
    if (counts.some((n) => !Number.isInteger(n) || n < 0) || [t.grossMinor, t.discountMinor, t.netMinor].some((n) => !Number.isSafeInteger(n))) {
      return { ok: false, detail: `the sales report figures for ${section.currency.code} are not exact integers` };
    }
    currencies.push({
      currency: section.currency.code, minorUnitExponent: exponent, completedOrders: t.completedOrders, voidedOrders: t.voidedOrders, openOrders: t.openOrders,
      otherStatusOrders: t.otherStatusOrders, grossMinor: t.grossMinor, discountMinor: t.discountMinor, netMinor: t.netMinor,
      averageOrderNetMinor: t.averageOrderNetMinor, reconciles: t.reconciles,
    });
  }
  return { ok: true, domain: { status: 'PROVIDED', provenance: { contract: SALES_REPORT_PROVENANCE_CONTRACT, digest: digestOf(report), period }, coverage: [report.source.definition], currencies } };
}

/** Exact revenue comparison per currency across the two BI reports. Returns the states, or the first currency on which they disagree. */
export function crossCheckRevenue(financial: FinancialKpis[], sales: SalesKpis[]): { ok: true; revenue: { currency: string; state: RevenueCrossCheckState }[] } | { ok: false; currency: string } {
  const fin = new Map(financial.map((f) => [f.currency, f]));
  const sal = new Map(sales.map((s) => [s.currency, s]));
  const revenue: { currency: string; state: RevenueCrossCheckState }[] = [];
  for (const currency of [...new Set([...fin.keys(), ...sal.keys()])].sort()) {
    const f = fin.get(currency); const s = sal.get(currency);
    const finCount = f?.revenue.count ?? 0; const salCount = s?.completedOrders ?? 0;
    if (finCount !== salCount) return { ok: false, currency };
    if (finCount === 0) { revenue.push({ currency, state: 'NOT_COMPARABLE' }); continue; }    // no completed order on either side: nothing to compare
    const salesUnits = BigInt(s!.netMinor) * 10n ** BigInt(4 - s!.minorUnitExponent);          // minor units -> the scale-4 units of the financial decimals (exact)
    if (parseMoney(f!.revenue.amount) !== salesUnits) return { ok: false, currency };
    revenue.push({ currency, state: 'AGREE' });
  }
  return { ok: true, revenue };
}

export function assembleBiPerformanceEvidence(input: { businessId: string; period: PerformancePeriod; financial: FinancialReportOutcome; sales: SalesReportResult }): AssembleResult {
  const { businessId, period } = input;
  const inconsistent = (detail: string): AssembleResult => ({ ok: false, code: 'BI_EVIDENCE_INCONSISTENT', detail });
  const fin = financialDomain(input.financial, businessId, period);
  if (!fin.ok) return inconsistent(fin.detail);
  const sal = salesDomain(input.sales, businessId, period);
  if (!sal.ok) return inconsistent(sal.detail);
  if (fin.domain.status === 'MISSING' && sal.domain.status === 'MISSING') {
    return { ok: false, code: 'BI_EVIDENCE_MISSING', detail: `neither BI report is available (financial: ${fin.domain.code}; sales: ${sal.domain.code})` };
  }
  const recorded = (d: DomainEvidence<{ currency: string }>): number => (d.status === 'PROVIDED' ? d.currencies.length : 0);
  if (recorded(fin.domain) + recorded(sal.domain) === 0) {
    return { ok: false, code: 'BI_EVIDENCE_INSUFFICIENT', detail: 'no sales, expenses or goods received are recorded for the period, so nothing can be represented' };
  }
  let crossCheck: BiPerformanceEvidence['crossCheck'] = { performed: false, revenue: [] };
  if (fin.domain.status === 'PROVIDED' && sal.domain.status === 'PROVIDED') {
    const checked = crossCheckRevenue(fin.domain.currencies, sal.domain.currencies);
    if (!checked.ok) return inconsistent(`the financial and sales reports disagree on the revenue of ${checked.currency}`);
    crossCheck = { performed: true, revenue: checked.revenue };
  }
  const body = { contract: BI_PERFORMANCE_EVIDENCE_CONTRACT, businessId, period, financial: fin.domain, sales: sal.domain, crossCheck };
  // Own the sealed evidence: a reader retaining its report (or the caller retaining its period) must not mutate a snapshot after its digest was computed.
  return { ok: true, evidence: structuredClone({ ...body, evidenceDigest: digestOf(body) }) };
}

/** Verifies a (stored) evidence: structure, and that its integrity digest matches its content. Pure. */
export function verifyBiPerformanceEvidence(evidence: unknown): { valid: boolean; reasons: string[] } {
  const shape = validateBiPerformanceEvidenceShape(evidence);
  if (!shape.valid) return shape;
  const { evidenceDigest, ...body } = evidence as BiPerformanceEvidence;
  return digestOf(body) === evidenceDigest ? { valid: true, reasons: [] } : { valid: false, reasons: ['evidence_digest_mismatch'] };
}
