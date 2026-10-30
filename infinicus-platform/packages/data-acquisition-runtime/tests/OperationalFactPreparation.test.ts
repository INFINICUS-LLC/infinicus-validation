import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const fact = (data: Record<string, unknown>) => ({ recordType: 'operational_fact', data: { eventType: 'sale', ...data } });
const prep = (record: unknown) => preparer.prepareRecord(record, 0);
const codes = (record: unknown) => prep(record).issues.map((i) => i.ruleCode);

describe('operational_fact: valid records', () => {
  it('a minimal record passes unchanged as VALID and nothing is invented', () => {
    const r = prep(fact({}));
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual({ recordType: 'operational_fact', data: { eventType: 'sale' } });
  });
  it('every event type and action is accepted', () => {
    for (const eventType of ['sale', 'expense', 'inventory', 'customer', 'team']) expect(prep(fact({ eventType })).issues, eventType).toEqual([]);
    for (const action of ['new', 'return', 'churn', 'hire', 'fire', 'review']) expect(prep(fact({ action })).issues, action).toEqual([]);
  });
  it('amount and quantity accept zero, negatives and the numeric(18,4) boundaries without loss', () => {
    for (const v of [0, '0', -1, '-12.5', 0.0001, '-0.0001', 1234.5678, '12345678901234.5', '99999999999999']) {
      const r = prep(fact({ amount: v, quantity: v }));
      expect(r.issues, String(v)).toEqual([]);
      expect(r.prepared!.data.amount).toBe(Number(v));
    }
    expect(Object.is(prep(fact({ amount: '-0' })).prepared!.data.amount, 0)).toBe(true); // canonical zero, never -0
  });
  it('customerId / memberId / category are free text: uuid-shaped or not, stored as given (trimmed)', () => {
    const r = prep(fact({ customerId: 'CUST/é 1', memberId: ' 3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6F ', category: 'x' }));
    expect(r.prepared!.data).toMatchObject({ customerId: 'CUST/é 1', memberId: '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6F', category: 'x' }); // case preserved, not lower-cased
  });
});

describe('operational_fact: deterministic normalization', () => {
  it('trims, lower-cases enums, converts decimal strings and reports every action', () => {
    const r = prep(fact({ eventType: ' EXPENSE ', amount: ' 10.50 ', quantity: '2', action: 'Return', notes: '  n ' }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toEqual({ eventType: 'expense', amount: 10.5, quantity: 2, action: 'return', notes: 'n' });
    expect(r.actions.map((a) => `${a.field}:${a.rule}`)).toEqual(expect.arrayContaining([
      'eventType:trim', 'eventType:lowercase_enum', 'amount:trim', 'amount:numeric_string_to_number', 'quantity:numeric_string_to_number', 'action:lowercase_enum', 'notes:trim',
    ]));
  });
  it('omits empty / null optionals and records that it did so', () => {
    const r = prep(fact({ notes: '  ', amount: null, category: null }));
    expect(r.prepared!.data).toEqual({ eventType: 'sale' });
    expect(r.actions).toEqual(expect.arrayContaining([{ field: 'notes', rule: 'empty_omitted' }, { field: 'amount', rule: 'null_omitted' }, { field: 'category', rule: 'null_omitted' }]));
  });
  it('is pure, idempotent and deterministic', () => {
    const input = fact({ eventType: 'SALE', amount: '10' });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    const again = prep(a.prepared);
    expect(again.status).toBe('VALID');
    expect(again.prepared).toEqual(a.prepared);
  });
  it('raw and prepared hashes differ exactly when something was normalized (provenance input)', () => {
    const raw = fact({ amount: '10' });
    expect(hashRecord(prep(raw).prepared)).not.toBe(hashRecord(raw));
    const clean = fact({ amount: 10 });
    expect(hashRecord(prep(clean).prepared)).toBe(hashRecord(clean));
  });
});

describe('operational_fact: rejection with stable PREP_* codes', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing eventType', { eventType: undefined }, 'PREP_EVENTTYPE_REQUIRED'],
    ['blank eventType', { eventType: '  ' }, 'PREP_EVENTTYPE_REQUIRED'],
    ['unknown eventType', { eventType: 'refund' }, 'PREP_EVENTTYPE_INVALID'],
    ['non-string eventType', { eventType: 5 }, 'PREP_EVENTTYPE_INVALID'],
    ['unknown action', { action: 'quit' }, 'PREP_ACTION_INVALID'],
    ['amount scale', { amount: '1.23456' }, 'PREP_AMOUNT_EXCEEDS_SCALE'],
    ['amount range', { amount: '100000000000000' }, 'PREP_AMOUNT_OUT_OF_RANGE'],
    ['amount format', { amount: '1e3' }, 'PREP_AMOUNT_INVALID_FORMAT'],
    ['amount not exact', { amount: '99999999999999.9999' }, 'PREP_AMOUNT_NOT_EXACT'],
    ['amount type', { amount: true }, 'PREP_AMOUNT_INVALID'],
    ['amount NaN', { amount: Number.NaN }, 'PREP_AMOUNT_INVALID_FORMAT'],
    ['quantity format', { quantity: 'abc' }, 'PREP_QUANTITY_INVALID_FORMAT'],
    ['customerId type', { customerId: 7 }, 'PREP_CUSTOMERID_INVALID'],
    ['memberId type', { memberId: {} }, 'PREP_MEMBERID_INVALID'],
    ['category type', { category: [] }, 'PREP_CATEGORY_INVALID'],
    ['notes type', { notes: false }, 'PREP_NOTES_INVALID'],
    ['occurredAt is not in the BO contract', { occurredAt: '2026-01-01T00:00:00Z' }, 'PREP_UNSUPPORTED_FIELD'],
    ['unknown field', { tenantId: 'x' }, 'PREP_UNSUPPORTED_FIELD'],
  ];
  for (const [name, data, code] of cases) {
    it(`${name} -> ${code}, nothing partially prepared`, () => {
      const r = prep({ recordType: 'operational_fact', data: { eventType: 'sale', ...data } });
      expect(r.status).toBe('REJECTED');
      expect(r.prepared).toBeNull();
      expect(r.actions).toEqual([]);
      expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    });
  }
  it('tenant, workspace and business scope can never be supplied in the record', () => {
    for (const key of ['tenantId', 'workspaceId', 'businessId']) expect(codes(fact({ [key]: 'x' })), key).toContain('PREP_UNSUPPORTED_FIELD');
  });
  it('is not a duplicate/conflict participant: the key-finding detector ignores facts', () => {
    const p = prep(fact({ amount: 1 })).prepared!;
    const item = { recordIndex: 0, prepared: p, rawHash: 'h', preparedHash: 'h', rawKeyText: null };
    const findings = detectPreparedKeyFindings([item, { ...item, recordIndex: 1 }]);
    expect(findings.issuesByRecord.size).toBe(0);
  });
});
