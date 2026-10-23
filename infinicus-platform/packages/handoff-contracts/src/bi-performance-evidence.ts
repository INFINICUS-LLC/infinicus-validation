// The Business Intelligence -> Business Digital Twin PERFORMANCE evidence contract (NEW-BDT-01). Pure types and a structural validator; no I/O, no clock.
//
// WHAT IT CARRIES: the governed KPI figures Business Intelligence already derived (the financial report `bi-financial-report/1` and the sales report BI-SALES-1)
// for ONE business and ONE reporting period, VERBATIM, per currency, with the provenance (contract, period, SHA-256 of the source report as received) and an
// integrity digest. The twin consumes and represents this evidence; it derives no KPI of its own, converts no currency and writes no operational record.
//
// WHY A NEW CONTRACT: the frozen BUILD-12 `bi-to-dt` handoff carries publication-package metrics as plain numbers with no currency, which cannot carry exact
// per-currency money (and these reports are computed on request, not published as packages). This contract is ADDITIVE; `bi-to-dt.ts` is not modified or used.
import type { CurrencyFigures } from './bi-financial';

export const BI_PERFORMANCE_EVIDENCE_CONTRACT = 'bi-performance-evidence/1' as const;
export const BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA = 'business-performance-twin-state/1' as const;
export const BUSINESS_PERFORMANCE_TWIN_MODEL = Object.freeze({ name: 'business-performance-representation', version: '1', method: 'VERBATIM_BI_EVIDENCE' });

export interface PerformancePeriod { from: string; to: string }

/** Where a domain's figures came from: the BI contract, the period it covered and the SHA-256 (hex) of the canonical source report as received. */
export interface PerformanceProvenance { contract: string; digest: string; period: PerformancePeriod }

export type DomainEvidence<F> =
  | { status: 'PROVIDED'; provenance: PerformanceProvenance; /** Stable BI coverage codes: what the figures do and do not cover. */ coverage: string[]; currencies: F[] }
  | { status: 'MISSING'; code: string; detail: string };

/** The financial KPIs of one currency exactly as `bi-financial-report/1` states them (decimal strings, explicit states instead of fabricated values). */
export type FinancialKpis = CurrencyFigures;

/** The sales figures of one currency exactly as BI-SALES-1 states them: integer MINOR units of that currency (never mixed with the financial decimals). */
export interface SalesKpis {
  currency: string;
  minorUnitExponent: number;
  completedOrders: number; voidedOrders: number; openOrders: number; otherStatusOrders: number;
  grossMinor: number; discountMinor: number; netMinor: number;
  averageOrderNetMinor: number | null;
  reconciles: boolean;
}

/** Whether two independently derived BI reports agree on the revenue of a currency (count and exact amount). A disagreement is never published. */
export type RevenueCrossCheckState = 'AGREE' | 'NOT_COMPARABLE';

export interface BiPerformanceEvidence {
  contract: typeof BI_PERFORMANCE_EVIDENCE_CONTRACT;
  businessId: string;
  period: PerformancePeriod;
  financial: DomainEvidence<FinancialKpis>;
  sales: DomainEvidence<SalesKpis>;
  /** Performed only when both domains are PROVIDED. */
  crossCheck: { performed: boolean; revenue: { currency: string; state: RevenueCrossCheckState }[] };
  /** SHA-256 (hex) of the canonical JSON of this evidence without this field. */
  evidenceDigest: string;
}

export interface BusinessPerformanceTwinState {
  schema: typeof BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA;
  model: typeof BUSINESS_PERFORMANCE_TWIN_MODEL;
  observedAt: string;
  evidence: BiPerformanceEvidence;
}

const DIGEST = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const date = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export interface PerformanceEvidenceValidation { valid: boolean; reasons: string[] }

/** Structural validation: shape, digests, period, currency uniqueness and order, and "a missing domain carries no figures". Pure. */
export function validateBiPerformanceEvidenceShape(value: unknown): PerformanceEvidenceValidation {
  const reasons: string[] = [];
  const e = value as Partial<BiPerformanceEvidence> | null;
  if (!record(e)) return { valid: false, reasons: ['not_an_object'] };
  if (e.contract !== BI_PERFORMANCE_EVIDENCE_CONTRACT) reasons.push('contract_unsupported');
  if (typeof e.businessId !== 'string' || e.businessId.length === 0) reasons.push('business_missing');
  if (!e.period || !date(e.period.from) || !date(e.period.to) || e.period.from > e.period.to) reasons.push('period_invalid');
  if (typeof e.evidenceDigest !== 'string' || !DIGEST.test(e.evidenceDigest)) reasons.push('evidence_digest_invalid');
  const domain = (d: DomainEvidence<{ currency: string }> | undefined, label: string): void => {
    if (!record(d)) { reasons.push(`${label}_missing`); return; }
    if (d.status === 'MISSING') {
      if ('currencies' in d) reasons.push(`${label}_missing_domain_carries_figures`);
      if (typeof d.code !== 'string' || d.code.length === 0) reasons.push(`${label}_missing_code_absent`);
      if (typeof d.detail !== 'string') reasons.push(`${label}_missing_detail_absent`);
      return;
    }
    if (d.status !== 'PROVIDED') { reasons.push(`${label}_status_invalid`); return; }
    if (!record(d.provenance) || typeof d.provenance.digest !== 'string' || !DIGEST.test(d.provenance.digest) || !text(d.provenance.contract)) reasons.push(`${label}_provenance_invalid`);
    else if (e.period && (d.provenance.period?.from !== e.period.from || d.provenance.period?.to !== e.period.to)) reasons.push(`${label}_period_mismatch`);
    if (!Array.isArray(d.coverage) || d.coverage.some((c) => typeof c !== 'string')) reasons.push(`${label}_coverage_invalid`);
    if (!Array.isArray(d.currencies)) { reasons.push(`${label}_currencies_invalid`); return; }
    if (d.currencies.some((c) => !record(c) || typeof c.currency !== 'string')) { reasons.push(`${label}_currency_invalid`); return; }
    const codes = d.currencies.map((c) => c.currency);
    if (codes.some((c) => !CURRENCY.test(c))) reasons.push(`${label}_currency_invalid`);
    if (new Set(codes).size !== codes.length) reasons.push(`${label}_currency_duplicated`);
    if (codes.join(',') !== [...codes].sort().join(',')) reasons.push(`${label}_currencies_not_sorted`);
  };
  domain(e.financial as DomainEvidence<{ currency: string }> | undefined, 'financial');
  domain(e.sales as DomainEvidence<{ currency: string }> | undefined, 'sales');
  if (!record(e.crossCheck) || typeof e.crossCheck.performed !== 'boolean') reasons.push('cross_check_missing');
  else if (e.crossCheck.performed !== (e.financial?.status === 'PROVIDED' && e.sales?.status === 'PROVIDED')) reasons.push('cross_check_inconsistent_with_domains');
  if (!Array.isArray(e.crossCheck?.revenue)) reasons.push('cross_check_revenue_invalid');
  else {
    const rows = e.crossCheck.revenue;
    if (rows.some((r) => !record(r) || typeof r.currency !== 'string' || !CURRENCY.test(r.currency) || !['AGREE', 'NOT_COMPARABLE'].includes(r.state))) reasons.push('cross_check_revenue_invalid');
    else {
      const codes = rows.map((r) => r.currency);
      if (new Set(codes).size !== codes.length || codes.join(',') !== [...codes].sort().join(',')) reasons.push('cross_check_currencies_invalid');
      if (e.crossCheck.performed === false && rows.length !== 0) reasons.push('cross_check_unperformed_carries_results');
    }
  }
  return { valid: reasons.length === 0, reasons };
}
