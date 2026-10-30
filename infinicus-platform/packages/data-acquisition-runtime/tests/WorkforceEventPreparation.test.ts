import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const wf = (data: Record<string, unknown>) => ({ recordType: 'workforce_event', data });
const prep = (record: unknown) => preparer.prepareRecord(record, 0);

describe('workforce_event: valid records', () => {
  it('each of memberId, action, hours is sufficient on its own, and nothing is invented', () => {
    expect(prep(wf({ memberId: 'm-1' })).prepared).toEqual({ recordType: 'workforce_event', data: { memberId: 'm-1' } });
    expect(prep(wf({ action: 'hire' })).prepared!.data).toEqual({ action: 'hire' });
    expect(prep(wf({ hours: 8 })).prepared!.data).toEqual({ hours: 8 });
    for (const r of [wf({ memberId: 'm-1' }), wf({ action: 'review' }), wf({ hours: 0 })]) expect(prep(r).status).toBe('VALID');
  });
  it('every action is accepted; hours accept zero and numeric(18,4) boundaries without loss', () => {
    for (const action of ['hire', 'fire', 'review']) expect(prep(wf({ action })).issues, action).toEqual([]);
    for (const v of [0, '0', 0.25, '7.5', '0.0001', 1234.5678, '12345678901234.5', '99999999999999']) {
      const r = prep(wf({ hours: v }));
      expect(r.issues, String(v)).toEqual([]);
      expect(r.prepared!.data.hours).toBe(Number(v));
    }
    expect(Object.is(prep(wf({ hours: '-0' })).prepared!.data.hours, 0)).toBe(true);
  });
  it('memberId is free text, never uuid-checked or case-folded; notes alone is allowed alongside another field', () => {
    expect(prep(wf({ memberId: ' EMP/é-7 ', notes: 'x' })).prepared!.data).toEqual({ memberId: 'EMP/é-7', notes: 'x' });
    expect(prep(wf({ memberId: '3F2B8C1E-9D4A-4E6B-8C7D-1A2B3C4D5E6F' })).prepared!.data.memberId).toBe('3F2B8C1E-9D4A-4E6B-8C7D-1A2B3C4D5E6F');
  });
});

describe('workforce_event: deterministic normalization', () => {
  it('trims, lower-cases the action, converts a decimal string, and reports every action', () => {
    const r = prep(wf({ memberId: '  m-2 ', action: ' REVIEW ', hours: ' 7.50 ', notes: '  n ' }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toEqual({ memberId: 'm-2', action: 'review', hours: 7.5, notes: 'n' });
    expect(r.actions.map((a) => `${a.field}:${a.rule}`)).toEqual(expect.arrayContaining([
      'memberId:trim', 'action:trim', 'action:lowercase_enum', 'hours:trim', 'hours:numeric_string_to_number', 'notes:trim',
    ]));
  });
  it('omits null / blank optionals and records that it did so', () => {
    const r = prep(wf({ memberId: 'm', notes: '  ', action: null }));
    expect(r.prepared!.data).toEqual({ memberId: 'm' });
    expect(r.actions).toEqual(expect.arrayContaining([{ field: 'notes', rule: 'empty_omitted' }, { field: 'action', rule: 'null_omitted' }]));
  });
  it('is pure, idempotent and deterministic; hashes differ exactly when something was normalized', () => {
    const input = wf({ action: 'HIRE', hours: '8' });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(prep(a.prepared).prepared).toEqual(a.prepared);
    expect(hashRecord(a.prepared)).not.toBe(hashRecord(input));
    const clean = wf({ action: 'hire', hours: 8 });
    expect(hashRecord(prep(clean).prepared)).toBe(hashRecord(clean));
  });
});

describe('workforce_event: rejection with stable PREP_* codes, nothing partially prepared', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['empty data', {}, 'PREP_WORKFORCE_EVENT_EMPTY'],
    ['notes only', { notes: 'x' }, 'PREP_WORKFORCE_EVENT_EMPTY'],
    ['only null / blank values', { memberId: null, action: '  ', hours: null }, 'PREP_WORKFORCE_EVENT_EMPTY'],
    ['unknown action', { action: 'promote' }, 'PREP_ACTION_INVALID'],
    ['action the table allows but BO does not', { action: 'churn' }, 'PREP_ACTION_INVALID'],
    ['non-string action', { action: 3 }, 'PREP_ACTION_INVALID'],
    ['negative hours', { hours: -1 }, 'PREP_HOURS_NEGATIVE'],
    ['negative hours string', { hours: '-0.5' }, 'PREP_HOURS_NEGATIVE'],
    ['hours scale', { hours: '1.23456' }, 'PREP_HOURS_EXCEEDS_SCALE'],
    ['hours range', { hours: '100000000000000' }, 'PREP_HOURS_OUT_OF_RANGE'],
    ['hours format', { hours: '1e3' }, 'PREP_HOURS_INVALID_FORMAT'],
    ['hours not exact', { hours: '99999999999999.9999' }, 'PREP_HOURS_NOT_EXACT'],
    ['hours type', { hours: true }, 'PREP_HOURS_INVALID'],
    ['hours NaN', { hours: Number.NaN }, 'PREP_HOURS_INVALID_FORMAT'],
    ['memberId type', { memberId: 7 }, 'PREP_MEMBERID_INVALID'],
    ['notes type', { memberId: 'm', notes: false }, 'PREP_NOTES_INVALID'],
    ['unsupported field', { memberId: 'm', occurredAt: '2026-01-01T00:00:00Z' }, 'PREP_UNSUPPORTED_FIELD'],
  ];
  for (const [name, data, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const r = prep(wf(data));
      expect(r.status).toBe('REJECTED');
      expect(r.prepared).toBeNull();
      expect(r.actions).toEqual([]);
      expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    });
  }
  it('scope can never be supplied in the record', () => {
    for (const key of ['tenantId', 'workspaceId', 'businessId']) {
      expect(prep(wf({ memberId: 'm', [key]: 'x' })).issues.map((i) => i.ruleCode), key).toContain('PREP_UNSUPPORTED_FIELD');
    }
  });
  it('sensitive values are never echoed in messages', () => {
    const secret = 'SSN-123-45-6789';
    const r = prep(wf({ memberId: secret, hours: secret, action: secret }));
    expect(JSON.stringify(r.issues)).not.toContain(secret);
  });
  it('is not a duplicate/conflict participant: BO defines no identity rule for a workforce event', () => {
    const p = prep(wf({ memberId: 'm' })).prepared!;
    const item = { recordIndex: 0, prepared: p, rawHash: 'h', preparedHash: 'h', rawKeyText: null };
    expect(detectPreparedKeyFindings([item, { ...item, recordIndex: 1 }]).issuesByRecord.size).toBe(0);
  });
});
