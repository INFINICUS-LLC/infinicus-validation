import { describe, expect, it } from 'vitest';
import { OperationalRecordPreparer } from '../src/preparation/OperationalRecordPreparer.js';
import { detectPreparedKeyFindings } from '../src/preparation/preparedKeyFindings.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';

const preparer = new OperationalRecordPreparer();
const PO = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
const WH = '4a2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e60';
const ITEM = '5b2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e61';
const ITEM2 = '6c2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e62';
const POLINE = '7d2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e63';
const line = (data: Record<string, unknown> = {}) => ({ inventoryItemId: ITEM, quantity: 10, ...data });
const pr = (data: Record<string, unknown> = {}) => ({
  recordType: 'purchase_receipt',
  data: { purchaseOrderId: PO, warehouseId: WH, receiptNumber: 'GRN-1', receivedAt: '2026-10-01T09:30:00.250Z', lines: [line()], ...data },
});
const prep = (record: unknown) => preparer.prepareRecord(record, 0);
const codes = (record: unknown) => prep(record).issues.map((i) => i.ruleCode);

describe('purchase_receipt: valid records', () => {
  it('a minimal receipt passes unchanged as VALID and nothing is invented (no notes, no cost, no order line)', () => {
    const r = prep(pr());
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual(pr());
    expect(r.prepared!.data).not.toHaveProperty('notes');
    expect(r.prepared!.data.lines).toEqual([{ inventoryItemId: ITEM, quantity: 10 }]);
  });
  it('a full receipt with several lines, order-line links and costs passes', () => {
    const lines = [
      line({ purchaseOrderLineId: POLINE, quantity: '10.5', unitCost: 2.5, unitCostCurrency: 'USD' }),
      line({ inventoryItemId: ITEM2, quantity: 0.0001, unitCost: '0.0001', unitCostCurrency: 'EUR' }),
    ];
    const r = prep(pr({ notes: 'dock 3', lines }));
    expect(r.issues).toEqual([]);
    expect(r.prepared!.data.lines).toEqual([
      { purchaseOrderLineId: POLINE, inventoryItemId: ITEM, quantity: 10.5, unitCost: 2.5, unitCostCurrency: 'USD' },
      { inventoryItemId: ITEM2, quantity: 0.0001, unitCost: 0.0001, unitCostCurrency: 'EUR' },
    ]);
  });
  it('quantity and cost boundaries (largest numeric(18,4) values that are exact doubles) pass without loss', () => {
    for (const v of ['0.0001', '99999999999999', '12345678901234.5', 1234.5678]) {
      const r = prep(pr({ lines: [line({ quantity: v, unitCost: v, unitCostCurrency: 'KWD' })] }));
      expect(r.issues, String(v)).toEqual([]);
      expect((r.prepared!.data.lines as Array<Record<string, unknown>>)[0].quantity).toBe(Number(v));
    }
  });
  it('the largest allowed number of lines passes; one more is rejected before any line is examined', () => {
    expect(prep(pr({ lines: Array.from({ length: 500 }, () => line()) })).issues).toEqual([]);
    expect(codes(pr({ lines: Array.from({ length: 501 }, () => line()) }))).toEqual(['PREP_LINES_TOO_MANY']);
  });
});

describe('purchase_receipt: owner ruling - lower-case UUIDs only, never widened or case-folded', () => {
  it('rejects an upper-case, mixed-case, braced or unhyphenated UUID in every identifier field', () => {
    const bad = [PO.toUpperCase(), `${PO.slice(0, 8).toUpperCase()}${PO.slice(8)}`, `{${PO}}`, PO.replace(/-/g, ''), `${PO}0`];
    for (const value of bad) {
      expect(codes(pr({ purchaseOrderId: value })), value).toContain('PREP_PURCHASEORDERID_INVALID');
      expect(codes(pr({ warehouseId: value })), value).toContain('PREP_WAREHOUSEID_INVALID');
      expect(codes(pr({ lines: [line({ inventoryItemId: value })] })), value).toContain('PREP_LINE_INVENTORYITEMID_INVALID');
      expect(codes(pr({ lines: [line({ purchaseOrderLineId: value })] })), value).toContain('PREP_LINE_PURCHASEORDERLINEID_INVALID');
    }
  });
  it('never emits a lower_case_uuid action: a valid identifier is passed through, surrounding whitespace is the only change', () => {
    const r = prep(pr({ purchaseOrderId: ` ${PO} ` }));
    expect(r.prepared!.data.purchaseOrderId).toBe(PO);
    expect(r.actions.map((a) => a.rule)).not.toContain('lowercase_uuid');
    expect(r.actions).toContainEqual({ field: 'purchaseOrderId', rule: 'trim' });
  });
});

describe('purchase_receipt: deterministic normalization', () => {
  it('trims, converts decimal strings, normalizes the instant to UTC and reports every action with line-indexed fields', () => {
    const r = prep(pr({
      receiptNumber: '  GRN-9 ', receivedAt: '2026-10-01T11:30:00.25+02:00', notes: ' n ',
      lines: [line({ quantity: ' 4.25 ' }), line({ inventoryItemId: ITEM2, unitCost: '2.50', unitCostCurrency: 'USD' })],
    }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toMatchObject({ receiptNumber: 'GRN-9', receivedAt: '2026-10-01T09:30:00.250Z', notes: 'n' });
    expect(r.actions.map((a) => `${a.field}:${a.rule}`)).toEqual(expect.arrayContaining([
      'receiptNumber:trim', 'receivedAt:utc_instant', 'notes:trim', 'lines[0].quantity:trim', 'lines[0].quantity:numeric_string_to_number',
      'lines[1].unitCost:numeric_string_to_number',
    ]));
  });
  it('omits null / blank optionals and records that it did so', () => {
    const r = prep(pr({ notes: '  ', lines: [line({ purchaseOrderLineId: null, unitCost: null, unitCostCurrency: null })] }));
    expect(r.prepared!.data).not.toHaveProperty('notes');
    expect(r.prepared!.data.lines).toEqual([{ inventoryItemId: ITEM, quantity: 10 }]);
    expect(r.actions).toEqual(expect.arrayContaining([
      { field: 'notes', rule: 'empty_omitted' }, { field: 'lines[0].purchaseOrderLineId', rule: 'null_omitted' }, { field: 'lines[0].unitCost', rule: 'null_omitted' },
    ]));
  });
  it('is pure, idempotent and deterministic; hashes differ exactly when something was normalized', () => {
    const input = pr({ receivedAt: '2026-10-01T11:30:00+02:00', lines: [line({ quantity: '3' })] });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(prep(a.prepared).prepared).toEqual(a.prepared);
    expect(hashRecord(a.prepared)).not.toBe(hashRecord(input));
    expect(hashRecord(prep(pr()).prepared)).toBe(hashRecord(pr()));
  });
});

describe('purchase_receipt: rejection with stable PREP_* codes, nothing partially prepared', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing purchaseOrderId', { purchaseOrderId: undefined }, 'PREP_PURCHASEORDERID_REQUIRED'],
    ['non-string warehouseId', { warehouseId: 5 }, 'PREP_WAREHOUSEID_INVALID'],
    ['missing receiptNumber', { receiptNumber: undefined }, 'PREP_RECEIPTNUMBER_REQUIRED'],
    ['blank receiptNumber', { receiptNumber: '   ' }, 'PREP_RECEIPTNUMBER_REQUIRED'],
    ['receiptNumber too long', { receiptNumber: 'x'.repeat(101) }, 'PREP_RECEIPTNUMBER_TOO_LONG'],
    ['missing receivedAt', { receivedAt: undefined }, 'PREP_RECEIVEDAT_REQUIRED'],
    ['receivedAt without offset', { receivedAt: '2026-10-01T09:30:00' }, 'PREP_RECEIVEDAT_INVALID'],
    ['receivedAt date only', { receivedAt: '2026-10-01' }, 'PREP_RECEIVEDAT_INVALID'],
    ['receivedAt rolled-over calendar', { receivedAt: '2026-02-31T00:00:00Z' }, 'PREP_RECEIVEDAT_INVALID'],
    ['receivedAt microseconds (cannot be normalized without loss)', { receivedAt: '2026-10-01T09:30:00.123456Z' }, 'PREP_RECEIVEDAT_INVALID'],
    ['notes too long', { notes: 'x'.repeat(2001) }, 'PREP_NOTES_TOO_LONG'],
    ['notes type', { notes: 3 }, 'PREP_NOTES_INVALID'],
    ['no lines', { lines: [] }, 'PREP_LINES_REQUIRED'],
    ['lines not an array', { lines: {} }, 'PREP_LINES_REQUIRED'],
    ['missing lines', { lines: undefined }, 'PREP_LINES_REQUIRED'],
    ['line not an object', { lines: [5] }, 'PREP_LINE_NOT_OBJECT'],
    ['missing inventoryItemId', { lines: [{ quantity: 1 }] }, 'PREP_LINE_INVENTORYITEMID_REQUIRED'],
    ['missing quantity', { lines: [{ inventoryItemId: ITEM }] }, 'PREP_LINE_QUANTITY_REQUIRED'],
    ['zero quantity', { lines: [line({ quantity: 0 })] }, 'PREP_LINE_QUANTITY_NOT_POSITIVE'],
    ['negative quantity', { lines: [line({ quantity: '-1' })] }, 'PREP_LINE_QUANTITY_NOT_POSITIVE'],
    ['quantity scale (would be rounded)', { lines: [line({ quantity: '1.00001' })] }, 'PREP_LINE_QUANTITY_EXCEEDS_SCALE'],
    ['quantity range', { lines: [line({ quantity: '100000000000000' })] }, 'PREP_LINE_QUANTITY_OUT_OF_RANGE'],
    ['quantity not exact', { lines: [line({ quantity: '99999999999999.9999' })] }, 'PREP_LINE_QUANTITY_NOT_EXACT'],
    ['quantity format', { lines: [line({ quantity: '1e2' })] }, 'PREP_LINE_QUANTITY_INVALID_FORMAT'],
    ['quantity type', { lines: [line({ quantity: true })] }, 'PREP_LINE_QUANTITY_INVALID'],
    ['zero unitCost', { lines: [line({ unitCost: 0, unitCostCurrency: 'USD' })] }, 'PREP_LINE_UNITCOST_NOT_POSITIVE'],
    ['unitCost below the storable floor', { lines: [line({ unitCost: '0.00001', unitCostCurrency: 'USD' })] }, 'PREP_LINE_UNITCOST_BELOW_MINIMUM_PRECISION'],
    ['unitCost without currency', { lines: [line({ unitCost: 1 })] }, 'PREP_LINE_UNITCOSTCURRENCY_REQUIRED_WITH_UNITCOST'],
    ['currency without unitCost', { lines: [line({ unitCostCurrency: 'USD' })] }, 'PREP_LINE_UNITCOST_REQUIRED_WITH_UNITCOSTCURRENCY'],
    ['lower-case currency is not folded', { lines: [line({ unitCost: 1, unitCostCurrency: 'usd' })] }, 'PREP_LINE_UNITCOSTCURRENCY_INVALID'],
    ['padded currency is not trimmed', { lines: [line({ unitCost: 1, unitCostCurrency: ' USD' })] }, 'PREP_LINE_UNITCOSTCURRENCY_INVALID'],
    ['unsupported line field', { lines: [line({ lineNumber: 1 })] }, 'PREP_UNSUPPORTED_FIELD'],
    ['unsupported record field', { receivedBy: PO }, 'PREP_UNSUPPORTED_FIELD'],
  ];
  for (const [name, data, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const r = prep(pr(data));
      expect(r.status).toBe('REJECTED');
      expect(r.prepared).toBeNull();
      expect(r.actions).toEqual([]);
      expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    });
  }
  it('reports the failing line by index in the field path, with a code that does not change with the index', () => {
    const r = prep(pr({ lines: [line(), line({ quantity: 0 }), line({ quantity: -1 })] }));
    expect(r.issues.map((i) => [i.ruleCode, i.fieldPath])).toEqual([
      ['PREP_LINE_QUANTITY_NOT_POSITIVE', 'data.lines[1].quantity'], ['PREP_LINE_QUANTITY_NOT_POSITIVE', 'data.lines[2].quantity'],
    ]);
  });
  it('scope can never be supplied in the record or in a line', () => {
    for (const key of ['tenantId', 'workspaceId', 'businessId']) {
      expect(codes(pr({ [key]: 'x' })), key).toContain('PREP_UNSUPPORTED_FIELD');
      expect(codes(pr({ lines: [line({ [key]: 'x' })] })), key).toContain('PREP_UNSUPPORTED_FIELD');
    }
  });
  it('rejected values are never echoed in messages', () => {
    const secret = 'SSN-123-45-6789';
    const r = prep(pr({ purchaseOrderId: secret, receivedAt: secret, lines: [line({ inventoryItemId: secret, quantity: secret })] }));
    expect(JSON.stringify(r.issues)).not.toContain(secret);
  });
  it('is not a duplicate/conflict participant here: the receipt-number identity rule stays with BO', () => {
    const p = prep(pr()).prepared!;
    const item = { recordIndex: 0, prepared: p, rawHash: 'h', preparedHash: 'h', rawKeyText: null };
    expect(detectPreparedKeyFindings([item, { ...item, recordIndex: 1 }]).issuesByRecord.size).toBe(0);
  });
});
