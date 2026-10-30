import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const ASSET = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
const ai = (data: Record<string, unknown>) => ({ recordType: 'asset_inspection', data: { assetId: ASSET, conditionRating: 'good', pass: true, ...data } });
const prep = (record: unknown) => preparer.prepareRecord(record, 0);

describe('asset_inspection: valid records', () => {
  it('a minimal record passes unchanged as VALID and nothing is invented (no type, no findings, no date)', () => {
    const r = prep(ai({}));
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual({ recordType: 'asset_inspection', data: { assetId: ASSET, conditionRating: 'good', pass: true } });
  });
  it('every inspection type and rating is accepted; pass false is kept (not dropped as falsy)', () => {
    for (const inspectionType of ['routine', 'safety', 'regulatory', 'pre_use', 'post_use', 'other']) expect(prep(ai({ inspectionType })).issues, inspectionType).toEqual([]);
    for (const conditionRating of ['excellent', 'good', 'fair', 'poor', 'critical']) expect(prep(ai({ conditionRating })).issues, conditionRating).toEqual([]);
    expect(prep(ai({ pass: false })).prepared!.data.pass).toBe(false);
  });
  it('a full record passes, including calendar boundaries', () => {
    for (const nextInspectionDate of ['2024-02-29', '0001-01-01', '9999-12-31']) {
      const r = prep(ai({ inspectionType: 'safety', findings: 'ok', actionsRequired: 'none', nextInspectionDate }));
      expect(r.issues, nextInspectionDate).toEqual([]);
      expect(r.prepared!.data.nextInspectionDate).toBe(nextInspectionDate);
    }
  });
});

describe('asset_inspection: deterministic normalization', () => {
  it('trims, lower-cases the uuid and enums, and reports every action', () => {
    const r = prep(ai({ assetId: ` ${ASSET.toUpperCase()} `, inspectionType: ' SAFETY ', conditionRating: 'Poor', findings: '  crack ', nextInspectionDate: ' 2026-12-31 ' }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toEqual({ assetId: ASSET, inspectionType: 'safety', conditionRating: 'poor', pass: true, findings: 'crack', nextInspectionDate: '2026-12-31' });
    expect(r.actions.map((a) => `${a.field}:${a.rule}`)).toEqual(expect.arrayContaining([
      'assetId:trim', 'assetId:lowercase_uuid', 'inspectionType:lowercase_enum', 'conditionRating:lowercase_enum', 'findings:trim', 'nextInspectionDate:trim',
    ]));
  });
  it('omits null / blank optionals and records that it did so', () => {
    const r = prep(ai({ findings: '  ', actionsRequired: null, inspectionType: null, nextInspectionDate: null }));
    expect(r.prepared!.data).toEqual({ assetId: ASSET, conditionRating: 'good', pass: true });
    expect(r.actions).toEqual(expect.arrayContaining([{ field: 'findings', rule: 'empty_omitted' }, { field: 'actionsRequired', rule: 'null_omitted' }, { field: 'inspectionType', rule: 'null_omitted' }]));
  });
  it('is pure, idempotent and deterministic; hashes differ exactly when something was normalized', () => {
    const input = ai({ assetId: ASSET.toUpperCase() });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(prep(a.prepared).prepared).toEqual(a.prepared);
    expect(hashRecord(a.prepared)).not.toBe(hashRecord(input));
    const clean = ai({});
    expect(hashRecord(prep(clean).prepared)).toBe(hashRecord(clean));
  });
});

describe('asset_inspection: rejection with stable PREP_* codes, nothing partially prepared', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing assetId', { assetId: undefined }, 'PREP_ASSETID_REQUIRED'],
    ['blank assetId', { assetId: ' ' }, 'PREP_ASSETID_REQUIRED'],
    ['non-uuid assetId', { assetId: 'ASSET-1' }, 'PREP_ASSETID_INVALID'],
    ['braced uuid', { assetId: `{${ASSET}}` }, 'PREP_ASSETID_INVALID'],
    ['non-string assetId', { assetId: 5 }, 'PREP_ASSETID_INVALID'],
    ['missing conditionRating', { conditionRating: undefined }, 'PREP_CONDITIONRATING_REQUIRED'],
    ['unknown conditionRating', { conditionRating: 'ok' }, 'PREP_CONDITIONRATING_INVALID'],
    ['unknown inspectionType', { inspectionType: 'annual' }, 'PREP_INSPECTIONTYPE_INVALID'],
    ['missing pass', { pass: undefined }, 'PREP_PASS_REQUIRED'],
    ['null pass', { pass: null }, 'PREP_PASS_REQUIRED'],
    ['string pass is not guessed', { pass: 'true' }, 'PREP_PASS_INVALID'],
    ['numeric pass is not guessed', { pass: 1 }, 'PREP_PASS_INVALID'],
    ['findings type', { findings: 3 }, 'PREP_FINDINGS_INVALID'],
    ['actionsRequired type', { actionsRequired: {} }, 'PREP_ACTIONSREQUIRED_INVALID'],
    ['date rolled over', { nextInspectionDate: '2026-02-31' }, 'PREP_NEXTINSPECTIONDATE_INVALID'],
    ['date with time', { nextInspectionDate: '2026-03-01T10:00:00Z' }, 'PREP_NEXTINSPECTIONDATE_INVALID'],
    ['unsupported inspectedBy', { inspectedBy: ASSET }, 'PREP_UNSUPPORTED_FIELD'],
    ['unsupported inspectedAt', { inspectedAt: '2026-01-01T00:00:00Z' }, 'PREP_UNSUPPORTED_FIELD'],
    ['unsupported checklistResults', { checklistResults: {} }, 'PREP_UNSUPPORTED_FIELD'],
  ];
  for (const [name, data, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const r = prep(ai(data));
      expect(r.status).toBe('REJECTED');
      expect(r.prepared).toBeNull();
      expect(r.actions).toEqual([]);
      expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    });
  }
  it('scope can never be supplied in the record', () => {
    for (const key of ['tenantId', 'workspaceId', 'businessId']) {
      expect(prep(ai({ [key]: 'x' })).issues.map((i) => i.ruleCode), key).toContain('PREP_UNSUPPORTED_FIELD');
    }
  });
  it('rejected values are never echoed in messages', () => {
    const secret = 'SSN-123-45-6789';
    const r = prep(ai({ assetId: secret, conditionRating: secret, inspectionType: secret, pass: secret }));
    expect(JSON.stringify(r.issues)).not.toContain(secret);
  });
  it('is not a duplicate/conflict participant: BO defines no identity rule for an inspection', () => {
    const p = prep(ai({})).prepared!;
    const item = { recordIndex: 0, prepared: p, rawHash: 'h', preparedHash: 'h', rawKeyText: null };
    expect(detectPreparedKeyFindings([item, { ...item, recordIndex: 1 }]).issuesByRecord.size).toBe(0);
  });
});
