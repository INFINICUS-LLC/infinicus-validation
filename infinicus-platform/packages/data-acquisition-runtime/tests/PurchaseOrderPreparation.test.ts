import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { canonicalUuid, strictCalendarDate } from '../src/preparation/referenceFormats.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const SUPPLIER = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
const po = (data: Record<string, unknown>) => ({ recordType: 'purchase_order', data: { supplierId: SUPPLIER, poNumber: 'PO-1001', currencyCode: 'KWD', ...data } });
const prep = (record: unknown) => preparer.prepareRecord(record, 0);
const codes = (record: unknown) => prep(record).issues.map((i) => i.ruleCode);

describe('purchase_order: valid records', () => {
  it('a minimal record passes unchanged as VALID and nothing is invented (no total, no date, no notes)', () => {
    const r = prep(po({}));
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual({ recordType: 'purchase_order', data: { supplierId: SUPPLIER, poNumber: 'PO-1001', currencyCode: 'KWD' } });
    expect(Object.keys(r.prepared!.data)).not.toContain('totalAmount');
    expect(Object.keys(r.prepared!.data)).not.toContain('expectedDate');
  });
  it('a full record passes, including boundary amounts', () => {
    for (const total of [0, '0', 0.0001, '99999999999999', '12345678901234.5', 1234.5678]) {
      const r = prep(po({ expectedDate: '2026-03-01', totalAmount: total, notes: 'rush order' }));
      expect(r.issues, String(total)).toEqual([]);
      expect(r.prepared!.data.expectedDate).toBe('2026-03-01');
    }
    expect(prep(po({ totalAmount: 0 })).prepared!.data.totalAmount).toBe(0);
  });
});

describe('purchase_order: deterministic normalization', () => {
  it('trims, NFC-normalizes, lower-cases the uuid, converts a decimal string, and reports every action', () => {
    const r = prep(po({ supplierId: ` ${SUPPLIER.toUpperCase()} `, poNumber: '  PO-9 ', totalAmount: ' 1250.50 ', expectedDate: ' 2026-12-31 ', notes: '  hello ' }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toEqual({ supplierId: SUPPLIER, poNumber: 'PO-9', currencyCode: 'KWD', totalAmount: 1250.5, expectedDate: '2026-12-31', notes: 'hello' });
    const rules = r.actions.map((a) => `${a.field}:${a.rule}`);
    expect(rules).toEqual(expect.arrayContaining(['supplierId:trim', 'supplierId:lowercase_uuid', 'poNumber:trim', 'totalAmount:numeric_string_to_number', 'expectedDate:trim', 'notes:trim']));
  });
  it('poNumber keeps its case and inner spacing (no format rule exists in BO, so none is invented)', () => {
    expect(prep(po({ poNumber: 'po 77/a b' })).prepared!.data.poNumber).toBe('po 77/a b');
  });
  it('omits empty / null optionals and records that it did so', () => {
    const r = prep(po({ notes: '   ', totalAmount: null, expectedDate: null }));
    expect(r.prepared!.data).not.toHaveProperty('notes');
    expect(r.prepared!.data).not.toHaveProperty('totalAmount');
    expect(r.actions).toEqual(expect.arrayContaining([{ field: 'notes', rule: 'empty_omitted' }, { field: 'totalAmount', rule: 'null_omitted' }, { field: 'expectedDate', rule: 'null_omitted' }]));
  });
  it('is pure, idempotent and deterministic', () => {
    const input = po({ supplierId: SUPPLIER.toUpperCase(), totalAmount: '10' });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    const again = prep(a.prepared);
    expect(again.status).toBe('VALID');
    expect(again.prepared).toEqual(a.prepared);
  });
});

describe('purchase_order: rejection with stable PREP_* codes', () => {
  it('missing mandatory fields', () => {
    expect(codes({ recordType: 'purchase_order', data: {} }).sort()).toEqual(['PREP_CURRENCYCODE_REQUIRED', 'PREP_PONUMBER_REQUIRED', 'PREP_SUPPLIERID_REQUIRED']);
    expect(codes(po({ poNumber: '   ' }))).toEqual(['PREP_PONUMBER_REQUIRED']);
    expect(codes(po({ currencyCode: undefined }))).toEqual(['PREP_CURRENCYCODE_REQUIRED']);
    expect(codes(po({ currencyCode: null }))).toEqual(['PREP_CURRENCYCODE_REQUIRED']);
  });
  it('a supplierId that is not a UUID (the column is uuid) is refused before it can abort a BO handoff', () => {
    for (const bad of ['abc', 'SUP-1', SUPPLIER.slice(1), SUPPLIER + '0', SUPPLIER.replace(/-/g, ''), `{${SUPPLIER}}`, '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6g', 12345, true]) {
      expect(codes(po({ supplierId: bad })), String(bad)).toEqual(['PREP_SUPPLIERID_INVALID']);
    }
  });
  it('currency is exact: lower case, padding, wrong length and non-strings are refused, never folded or defaulted', () => {
    for (const bad of ['kwd', ' KWD', 'KWD ', 'KW', 'KWDD', 'K1D', 5, true]) {
      expect(codes(po({ currencyCode: bad })), String(bad)).toEqual(['PREP_CURRENCYCODE_INVALID']);
    }
  });
  it('totalAmount obeys numeric(18,4): scale, range, exactness, format, sign', () => {
    expect(codes(po({ totalAmount: -1 }))).toEqual(['PREP_TOTALAMOUNT_NEGATIVE']);
    expect(codes(po({ totalAmount: '-0.0001' }))).toEqual(['PREP_TOTALAMOUNT_NEGATIVE']);
    expect(codes(po({ totalAmount: '1.23456' }))).toEqual(['PREP_TOTALAMOUNT_EXCEEDS_SCALE']);
    expect(codes(po({ totalAmount: '123456789012345' }))).toEqual(['PREP_TOTALAMOUNT_OUT_OF_RANGE']);
    expect(codes(po({ totalAmount: '99999999999999.9999' }))).toEqual(['PREP_TOTALAMOUNT_NOT_EXACT']);
    expect(codes(po({ totalAmount: '1,250.00' }))).toEqual(['PREP_TOTALAMOUNT_INVALID_FORMAT']);
    expect(codes(po({ totalAmount: '1e3' }))).toEqual(['PREP_TOTALAMOUNT_INVALID_FORMAT']);
    expect(codes(po({ totalAmount: true }))).toEqual(['PREP_TOTALAMOUNT_INVALID']);
    expect(codes(po({ totalAmount: Number.NaN }))).toEqual(['PREP_TOTALAMOUNT_INVALID_FORMAT']);
  });
  it('expectedDate must be a real calendar date written YYYY-MM-DD: no rollover, no time, no zone, no locale formats', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-3-1', '03/04/2026', '4 March 2026', '2026-03-01T00:00:00Z', '2026-03-01 10:00', '2100-02-29', '0000-01-01', '2026-03-1', 20260301, true]) {
      expect(codes(po({ expectedDate: bad })), String(bad)).toEqual(['PREP_EXPECTEDDATE_INVALID']);
    }
    for (const good of ['2024-02-29', '2000-02-29', '2026-12-31', '0001-01-01', '9999-12-31']) expect(prep(po({ expectedDate: good })).issues, good).toEqual([]);
  });
  it('unsupported fields, including anything that tries to set status, scope or identity', () => {
    for (const field of ['orderDate', 'poStatus', 'status', 'businessId', 'tenantId', 'workspaceId', 'version', 'id', 'approvedBy', 'currency', 'sourceSystem']) {
      expect(codes(po({ [field]: 'x' })), field).toEqual(['PREP_UNSUPPORTED_FIELD']);
    }
  });
  it('a rejected record is never partially prepared and never leaves actions behind', () => {
    const r = prep(po({ supplierId: 'nope', totalAmount: ' 5 ' }));
    expect(r.status).toBe('REJECTED');
    expect(r.prepared).toBeNull();
    expect(r.actions).toEqual([]);
  });
  it('control characters are refused before anything else (existing F2 rule applies to the new type)', () => {
    const r = prep(po({ notes: 'a\u0000b' }));
    expect(r.issues.map((i) => i.ruleCode)).toEqual(['PREP_CONTROL_CHARACTER']);
    expect(r.rawStorable).toBe(false);
  });
});

describe('reference format helpers', () => {
  it('canonicalUuid accepts exactly 8-4-4-4-12 hex, in either case, and returns lower case', () => {
    expect(canonicalUuid(SUPPLIER.toUpperCase())).toBe(SUPPLIER);
    expect(canonicalUuid('00000000-0000-0000-0000-000000000000')).toBe('00000000-0000-0000-0000-000000000000');
    for (const bad of ['', 'x', SUPPLIER.slice(0, 35), `${SUPPLIER} `, SUPPLIER.replace('-', '_')]) expect(canonicalUuid(bad), bad).toBeNull();
  });
  it('strictCalendarDate uses real leap-year arithmetic', () => {
    expect(strictCalendarDate('2024-02-29')).toBe('2024-02-29');
    expect(strictCalendarDate('2023-02-29')).toBeNull();
    expect(strictCalendarDate('1900-02-29')).toBeNull();
    expect(strictCalendarDate('2000-02-29')).toBe('2000-02-29');
    expect(strictCalendarDate('0004-02-29')).toBe('0004-02-29');
  });
});

describe('prepared-key findings are NOT applied to purchase orders (needs an owner decision)', () => {
  it('identical and conflicting purchase orders produce no findings: BO refuses any repeated poNumber, so the approved item/warehouse severities do not carry over', () => {
    const records = [po({}), po({}), po({ currencyCode: 'USD' })];
    const candidates = preparer.prepareBatch(records).map((o) => ({
      recordIndex: o.recordIndex, prepared: o.prepared!, rawHash: hashRecord(records[o.recordIndex]), preparedHash: hashRecord(o.prepared), rawKeyText: null,
    }));
    const found = detectPreparedKeyFindings(candidates);
    expect(found.groups).toEqual([]);
    expect(found.issuesByRecord.size).toBe(0);
  });
});
