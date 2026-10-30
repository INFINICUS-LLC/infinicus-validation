import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const SUPPLIER = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
const SCORES = ['qualityScore', 'deliveryScore', 'priceScore', 'serviceScore', 'overallScore'] as const;
const sp = (data: Record<string, unknown>) => ({
  recordType: 'supplier_performance',
  data: { supplierId: SUPPLIER, periodStart: '2026-01-01', periodEnd: '2026-03-31', qualityScore: 90, deliveryScore: 80, priceScore: 70, serviceScore: 60, overallScore: 75, ...data },
});
const prep = (record: unknown) => preparer.prepareRecord(record, 0);

describe('supplier_performance: valid records', () => {
  it('a minimal record passes unchanged as VALID and nothing is invented (no notes)', () => {
    const r = prep(sp({}));
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual(sp({}));
    expect(Object.keys(r.prepared!.data)).not.toContain('notes');
  });
  it('score boundaries 0, 100, 0.01 and two-decimal values pass without loss', () => {
    for (const v of [0, '0', 100, '100', '100.00', 0.01, '99.99', 85.5, '12.34']) {
      const r = prep(sp({ qualityScore: v, overallScore: v }));
      expect(r.issues, String(v)).toEqual([]);
      expect(r.prepared!.data.qualityScore).toBe(Number(v));
    }
  });
  it('a single-day period and calendar boundaries pass', () => {
    expect(prep(sp({ periodStart: '2024-02-29', periodEnd: '2024-02-29' })).issues).toEqual([]);
    expect(prep(sp({ periodStart: '0001-01-01', periodEnd: '9999-12-31' })).issues).toEqual([]);
  });
});

describe('supplier_performance: deterministic normalization', () => {
  it('trims, lower-cases the uuid, converts decimal strings, and reports every action', () => {
    const r = prep(sp({ supplierId: ` ${SUPPLIER.toUpperCase()} `, periodStart: ' 2026-01-01 ', qualityScore: ' 88.50 ', notes: '  good ' }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toMatchObject({ supplierId: SUPPLIER, periodStart: '2026-01-01', qualityScore: 88.5, notes: 'good' });
    expect(r.actions.map((a) => `${a.field}:${a.rule}`)).toEqual(expect.arrayContaining([
      'supplierId:trim', 'supplierId:lowercase_uuid', 'periodStart:trim', 'qualityScore:trim', 'qualityScore:numeric_string_to_number', 'notes:trim',
    ]));
  });
  it('is pure, idempotent and deterministic; hashes differ exactly when something was normalized', () => {
    const input = sp({ supplierId: SUPPLIER.toUpperCase(), priceScore: '70' });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(prep(a.prepared).prepared).toEqual(a.prepared);
    expect(hashRecord(a.prepared)).not.toBe(hashRecord(input));
    expect(hashRecord(prep(sp({})).prepared)).toBe(hashRecord(sp({})));
  });
});

describe('supplier_performance: rejection with stable PREP_* codes, nothing partially prepared', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing supplierId', { supplierId: undefined }, 'PREP_SUPPLIERID_REQUIRED'],
    ['non-uuid supplierId', { supplierId: 'SUP-1' }, 'PREP_SUPPLIERID_INVALID'],
    ['missing periodStart', { periodStart: undefined }, 'PREP_PERIODSTART_REQUIRED'],
    ['missing periodEnd', { periodEnd: undefined }, 'PREP_PERIODEND_REQUIRED'],
    ['rolled-over date', { periodStart: '2026-02-31' }, 'PREP_PERIODSTART_INVALID'],
    ['date with time', { periodEnd: '2026-03-31T00:00:00Z' }, 'PREP_PERIODEND_INVALID'],
    ['reversed period', { periodStart: '2026-04-01', periodEnd: '2026-03-31' }, 'PREP_PERIODEND_BEFORE_PERIODSTART'],
    ['score above 100', { qualityScore: 100.01 }, 'PREP_QUALITYSCORE_OUT_OF_RANGE'],
    ['score below 0', { deliveryScore: -0.01 }, 'PREP_DELIVERYSCORE_OUT_OF_RANGE'],
    ['score four integer digits', { priceScore: '1000' }, 'PREP_PRICESCORE_OUT_OF_RANGE'],
    ['score third decimal (would be rounded by the column)', { serviceScore: '85.123' }, 'PREP_SERVICESCORE_EXCEEDS_SCALE'],
    ['score format', { overallScore: '9e1' }, 'PREP_OVERALLSCORE_INVALID_FORMAT'],
    ['score type', { overallScore: true }, 'PREP_OVERALLSCORE_INVALID'],
    ['score NaN', { qualityScore: Number.NaN }, 'PREP_QUALITYSCORE_INVALID_FORMAT'],
    ['missing score', { priceScore: undefined }, 'PREP_PRICESCORE_REQUIRED'],
    ['null score', { serviceScore: null }, 'PREP_SERVICESCORE_REQUIRED'],
    ['notes type', { notes: 5 }, 'PREP_NOTES_INVALID'],
    ['unsupported evaluatedBy', { evaluatedBy: SUPPLIER }, 'PREP_UNSUPPORTED_FIELD'],
  ];
  for (const [name, data, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const r = prep(sp(data));
      expect(r.status).toBe('REJECTED');
      expect(r.prepared).toBeNull();
      expect(r.actions).toEqual([]);
      expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    });
  }
  it('every score is required and range-checked independently', () => {
    for (const f of SCORES) {
      expect(prep(sp({ [f]: undefined })).issues.map((i) => i.ruleCode)).toContain(`PREP_${f.toUpperCase()}_REQUIRED`);
      expect(prep(sp({ [f]: 101 })).issues.map((i) => i.ruleCode)).toContain(`PREP_${f.toUpperCase()}_OUT_OF_RANGE`);
    }
  });
  it('scope can never be supplied in the record', () => {
    for (const key of ['tenantId', 'workspaceId', 'businessId']) {
      expect(prep(sp({ [key]: 'x' })).issues.map((i) => i.ruleCode), key).toContain('PREP_UNSUPPORTED_FIELD');
    }
  });
  it('rejected values are never echoed in messages', () => {
    const secret = 'SSN-123-45-6789';
    const r = prep(sp({ supplierId: secret, periodStart: secret, qualityScore: secret }));
    expect(JSON.stringify(r.issues)).not.toContain(secret);
  });
  it('is not a duplicate/conflict participant: BO defines no identity rule for a score row', () => {
    const p = prep(sp({})).prepared!;
    const item = { recordIndex: 0, prepared: p, rawHash: 'h', preparedHash: 'h', rawKeyText: null };
    expect(detectPreparedKeyFindings([item, { ...item, recordIndex: 1 }]).issuesByRecord.size).toBe(0);
  });
});
