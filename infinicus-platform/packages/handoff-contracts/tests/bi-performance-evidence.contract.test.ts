/** NEW-BDT-01: the BI -> BDT performance evidence contract: names, the frozen-contract boundary, and the structural validator. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BI_PERFORMANCE_EVIDENCE_CONTRACT, BUSINESS_PERFORMANCE_TWIN_MODEL, BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA, BI_TO_DT_CONTRACT_VERSION, validateBiPerformanceEvidenceShape,
  type BiPerformanceEvidence,
} from '../src/index';

const D = 'a'.repeat(64);
const good = (): BiPerformanceEvidence => ({
  contract: BI_PERFORMANCE_EVIDENCE_CONTRACT, businessId: 'b', period: { from: '2026-10-01', to: '2026-10-31' },
  financial: { status: 'PROVIDED', provenance: { contract: 'bi-financial-report/1', digest: D, period: { from: '2026-10-01', to: '2026-10-31' } }, coverage: ['NO_CURRENCY_CONVERSION'], currencies: [] },
  sales: { status: 'MISSING', code: 'AMOUNT_NOT_REPRESENTABLE', detail: 'x' },
  crossCheck: { performed: false, revenue: [] }, evidenceDigest: D,
});

describe('bi-performance-evidence/1', () => {
  it('has stable names, versioned and distinct from the frozen BUILD-12 contract, which is unchanged', () => {
    expect(BI_PERFORMANCE_EVIDENCE_CONTRACT).toBe('bi-performance-evidence/1');
    expect(BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA).toBe('business-performance-twin-state/1');
    expect(BUSINESS_PERFORMANCE_TWIN_MODEL).toEqual({ name: 'business-performance-representation', version: '1', method: 'VERBATIM_BI_EVIDENCE' });
    expect(Object.isFrozen(BUSINESS_PERFORMANCE_TWIN_MODEL)).toBe(true);
    expect(BI_TO_DT_CONTRACT_VERSION).toBe('1.0.0');
    expect(readFileSync(resolve(__dirname, '../src/bi-performance-evidence.ts'), 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/bi-to-dt|BIToDT/);
  });
  it('accepts a well-formed evidence with a missing domain that carries no figures', () => {
    expect(validateBiPerformanceEvidenceShape(good())).toEqual({ valid: true, reasons: [] });
  });
  it.each([
    ['array root', [], 'not_an_object'],
    ['impossible date', { ...good(), period: { from: '2026-02-30', to: '2026-10-31' } }, 'period_invalid'],
    ['non-leap day', { ...good(), period: { from: '2026-02-29', to: '2026-10-31' } }, 'period_invalid'],
    ['absent currencies', { ...good(), financial: { ...good().financial, currencies: undefined } }, 'financial_currencies_invalid'],
    ['object currencies', { ...good(), financial: { ...good().financial, currencies: {} } }, 'financial_currencies_invalid'],
    ['null currency', { ...good(), financial: { ...good().financial, currencies: [null] } }, 'financial_currency_invalid'],
    ['primitive domain', { ...good(), sales: 7 }, 'sales_missing'],
    ['empty provenance', { ...good(), financial: { ...good().financial, provenance: { contract: '', digest: D } } }, 'financial_provenance_invalid'],
    ['non-string coverage', { ...good(), financial: { ...good().financial, coverage: [null] } }, 'financial_coverage_invalid'],
    ['absent missing detail', { ...good(), sales: { status: 'MISSING', code: 'UNAVAILABLE' } }, 'sales_missing_detail_absent'],
    ['null revenue row', { ...good(), crossCheck: { performed: false, revenue: [null] } }, 'cross_check_revenue_invalid'],
    ['absent revenue', { ...good(), crossCheck: { performed: false } }, 'cross_check_revenue_invalid'],
    ['unsupported check state', { ...good(), crossCheck: { performed: false, revenue: [{ currency: 'USD', state: 'GUESSED' }] } }, 'cross_check_revenue_invalid'],
    ['unperformed results', { ...good(), crossCheck: { performed: false, revenue: [{ currency: 'USD', state: 'AGREE' }] } }, 'cross_check_unperformed_carries_results'],
    ['duplicate check currencies', { ...good(), crossCheck: { performed: false, revenue: [{ currency: 'USD', state: 'AGREE' }, { currency: 'USD', state: 'AGREE' }] } }, 'cross_check_currencies_invalid'],
    ['unsorted check currencies', { ...good(), crossCheck: { performed: false, revenue: [{ currency: 'USD', state: 'AGREE' }, { currency: 'KWD', state: 'AGREE' }] } }, 'cross_check_currencies_invalid'],
  ])('fails closed on %s without throwing', (_name, value, reason) => {
    expect(validateBiPerformanceEvidenceShape(value)).toMatchObject({ valid: false, reasons: expect.arrayContaining([reason]) });
  });
  it('accepts a real leap day', () => {
    const e = good(); e.period.from = '2024-02-29';
    if (e.financial.status === 'PROVIDED') e.financial.provenance.period.from = e.period.from;
    expect(validateBiPerformanceEvidenceShape(e)).toEqual({ valid: true, reasons: [] });
  });
  it.each([
    ['not an object', null, ['not_an_object']],
    ['an unsupported contract', { ...good(), contract: 'x' }, ['contract_unsupported']],
    ['a reversed period', { ...good(), period: { from: '2026-11-01', to: '2026-10-01' } }, ['period_invalid']],
    ['a malformed evidence digest', { ...good(), evidenceDigest: 'ABC' }, ['evidence_digest_invalid']],
    ['a missing business', { ...good(), businessId: '' }, ['business_missing']],
    ['an absent domain', { ...good(), sales: undefined }, ['sales_missing']],
    ['a provenance digest that is not SHA-256 hex', { ...good(), financial: { ...good().financial, provenance: { contract: 'c', digest: 'zz', period: { from: '2026-10-01', to: '2026-10-31' } } } }, ['financial_provenance_invalid']],
    ['a missing domain with no reason code', { ...good(), sales: { status: 'MISSING', code: '', detail: 'x' } }, ['sales_missing_code_absent']],
    ['an unknown domain status', { ...good(), sales: { status: 'GUESSED' } }, ['sales_status_invalid']],
    ['a cross-check flagged performed while a domain is missing', { ...good(), crossCheck: { performed: true, revenue: [] } }, ['cross_check_inconsistent_with_domains']],
  ])('rejects %s', (_n, value, reasons) => {
    const out = validateBiPerformanceEvidenceShape(value);
    expect(out.valid).toBe(false);
    for (const r of reasons) expect(out.reasons).toContain(r);
  });
});
