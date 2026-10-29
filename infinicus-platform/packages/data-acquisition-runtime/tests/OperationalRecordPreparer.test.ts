import { describe, it, expect } from 'vitest';
import { OperationalRecordPreparer, mergePreparationIntoValidation } from '../src/preparation/OperationalRecordPreparer.js';
import { exactDecimal } from '../src/preparation/exactDecimal.js';
import { ManualRecordValidator } from '../src/validation/ManualRecordValidator.js';

const preparer = new OperationalRecordPreparer();
const prep = (record: unknown) => preparer.prepareRecord(record, 0);
const codes = (record: unknown) => prep(record).issues.map((i) => i.ruleCode);

const movement = (data: Record<string, unknown>) => ({
  recordType: 'inventory_movement',
  data: { sku: 'SKU-1', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 5, ...data },
});

describe('OperationalRecordPreparer: valid manual records', () => {
  it('passes a clean inventory_item through unchanged as VALID', () => {
    const r = prep({ recordType: 'inventory_item', data: { sku: 'SKU-1', name: 'Widget', unitOfMeasure: 'each' } });
    expect(r.status).toBe('VALID');
    expect(r.prepared).toEqual({ recordType: 'inventory_item', data: { sku: 'SKU-1', name: 'Widget', unitOfMeasure: 'each' } });
    expect(r.actions).toEqual([]);
  });
  it('passes a clean warehouse and a clean keyed movement', () => {
    expect(prep({ recordType: 'warehouse', data: { warehouseCode: 'WH-1', name: 'Main' } }).status).toBe('VALID');
    const m = prep(movement({ unitCost: 2.5, unitCostCurrency: 'USD', occurredAt: '2026-01-05T10:00:00.000Z' }));
    expect(m.status).toBe('VALID');
    expect(m.prepared!.data).toMatchObject({ unitCost: 2.5, unitCostCurrency: 'USD' });
  });
});

describe('OperationalRecordPreparer: rejection with explicit reasons', () => {
  it('rejects non-objects, unknown types, missing/non-object data', () => {
    expect(codes('x')).toEqual(['PREP_RECORD_NOT_OBJECT']);
    expect(codes({ recordType: 'nope', data: {} })).toEqual(['PREP_UNSUPPORTED_RECORD_TYPE']);
    expect(codes({ recordType: 'Inventory_Item', data: {} })).toEqual(['PREP_UNSUPPORTED_RECORD_TYPE']);
    expect(codes({ recordType: 'warehouse' })).toEqual(['PREP_DATA_REQUIRED']);
  });
  it('rejects missing mandatory fields', () => {
    expect(codes({ recordType: 'inventory_item', data: { name: 'x' } })).toContain('PREP_SKU_REQUIRED');
    expect(codes({ recordType: 'warehouse', data: { warehouseCode: 'W' } })).toContain('PREP_NAME_REQUIRED');
    expect(codes({ recordType: 'inventory_item', data: { sku: 'A', name: '   ' } })).toContain('PREP_NAME_REQUIRED');
    expect(codes(movement({ movementType: undefined }))).toContain('PREP_MOVEMENTTYPE_REQUIRED');
    expect(codes(movement({ quantity: undefined }))).toContain('PREP_QUANTITY_REQUIRED');
  });
  it('rejects invalid types and unsupported formats', () => {
    expect(codes({ recordType: 'inventory_item', data: { sku: 5, name: 'x' } })).toContain('PREP_SKU_INVALID');
    expect(codes({ recordType: 'inventory_item', data: { sku: 'bad sku!', name: 'x' } })).toContain('PREP_SKU_INVALID');
    expect(codes(movement({ quantity: '1,200' }))).toContain('PREP_QUANTITY_INVALID_FORMAT');
    expect(codes(movement({ quantity: '1e3' }))).toContain('PREP_QUANTITY_INVALID_FORMAT');
    expect(codes(movement({ quantity: true }))).toContain('PREP_QUANTITY_INVALID');
    expect(codes(movement({ quantity: 0 }))).toContain('PREP_QUANTITY_MUST_NOT_BE_ZERO');
    expect(codes(movement({ movementType: 'sold' }))).toContain('PREP_MOVEMENTTYPE_INVALID');
    expect(codes(movement({ occurredAt: '2026-01-05' }))).toContain('PREP_OCCURREDAT_INVALID');
    expect(codes(movement({ occurredAt: '2026-01-05T10:00:00' }))).toContain('PREP_OCCURREDAT_INVALID');
    expect(codes(movement({ occurredAt: '2026-02-31T10:00:00Z' }))).toContain('PREP_OCCURREDAT_INVALID');
  });
  it('rejects unsupported fields, including any attempt to carry scope', () => {
    expect(codes({ recordType: 'warehouse', data: { warehouseCode: 'W', name: 'n', businessId: 'x' } })).toContain('PREP_UNSUPPORTED_FIELD');
    expect(codes({ recordType: 'warehouse', extra: 1, data: { warehouseCode: 'W', name: 'n' } })).toContain('PREP_UNSUPPORTED_FIELD');
  });
  it('enforces exactly-one-of item/warehouse addressing', () => {
    expect(codes(movement({ inventoryItemId: 'abc' }))).toContain('PREP_EXACTLY_ONE_OF_INVENTORYITEMID_AND_SKU');
    expect(codes(movement({ warehouseCode: undefined }))).toContain('PREP_EXACTLY_ONE_OF_WAREHOUSEID_AND_WAREHOUSECODE');
  });
  it('enforces the cost/currency rulings: exact currency, positive cost, travel together, never defaulted', () => {
    expect(codes(movement({ unitCost: 2, unitCostCurrency: 'usd' }))).toContain('PREP_UNITCOSTCURRENCY_INVALID');
    expect(codes(movement({ unitCost: 2, unitCostCurrency: ' USD' }))).toContain('PREP_UNITCOSTCURRENCY_INVALID');
    expect(codes(movement({ unitCost: 2 }))).toContain('PREP_UNITCOSTCURRENCY_REQUIRED_WITH_UNITCOST');
    expect(codes(movement({ unitCostCurrency: 'USD' }))).toContain('PREP_UNITCOST_REQUIRED_WITH_UNITCOSTCURRENCY');
    expect(codes(movement({ unitCost: 0, unitCostCurrency: 'USD' }))).toContain('PREP_UNITCOST_NOT_POSITIVE');
    expect(codes(movement({ unitCost: -1, unitCostCurrency: 'USD' }))).toContain('PREP_UNITCOST_NOT_POSITIVE');
    expect(codes(movement({ unitCost: 0.00001, unitCostCurrency: 'USD' }))).toContain('PREP_UNITCOST_BELOW_MINIMUM_PRECISION');
  });
  it('never returns a partially prepared record for a rejected one', () => {
    const r = prep(movement({ quantity: '1,2', notes: ' keep ' }));
    expect(r.status).toBe('REJECTED');
    expect(r.prepared).toBeNull();
    expect(r.actions).toEqual([]);
  });
  it('bounds instant strings before pattern matching', () => {
    expect(codes(movement({ occurredAt: '2026-01-05T10:00:00Z' + ' '.repeat(40) + 'x' }))).toContain('PREP_OCCURREDAT_INVALID');
  });
  it('rejects over-long names', () => {
    expect(codes({ recordType: 'warehouse', data: { warehouseCode: 'W', name: 'n'.repeat(201) } })).toContain('PREP_NAME_TOO_LONG');
  });
});

describe('OperationalRecordPreparer: deterministic normalization', () => {
  it('trims, lower-cases enums, converts decimal strings and restates instants in UTC, reporting every action', () => {
    const r = prep(
      movement({
        sku: '  SKU-9 ', movementType: ' RECEIPT ', quantity: ' 12.50 ', unitCost: '3.2', unitCostCurrency: 'EUR',
        occurredAt: '2026-01-05T12:00:00+02:00', notes: '  hello ', referenceType: 'Manual',
      })
    );
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).toEqual({
      sku: 'SKU-9', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 12.5, unitCost: 3.2, unitCostCurrency: 'EUR',
      occurredAt: '2026-01-05T10:00:00.000Z', notes: 'hello', referenceType: 'manual',
    });
    const rules = r.actions.map((a) => `${a.field}:${a.rule}`);
    expect(rules).toEqual(expect.arrayContaining([
      'sku:trim', 'movementType:trim', 'movementType:lowercase_enum', 'quantity:trim', 'quantity:numeric_string_to_number',
      'unitCost:numeric_string_to_number', 'occurredAt:utc_instant', 'notes:trim', 'referenceType:lowercase_enum',
    ]));
  });
  it('omits null/empty optionals instead of inventing values, and records that it did so', () => {
    const r = prep(movement({ notes: '   ', referenceId: null }));
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data).not.toHaveProperty('notes');
    expect(r.prepared!.data).not.toHaveProperty('referenceId');
    expect(r.actions).toEqual(expect.arrayContaining([{ field: 'notes', rule: 'empty_omitted' }, { field: 'referenceId', rule: 'null_omitted' }]));
  });
  it('never fabricates: an absent optional stays absent', () => {
    const r = prep(movement({}));
    expect(Object.keys(r.prepared!.data).sort()).toEqual(['movementType', 'quantity', 'sku', 'warehouseCode']);
  });
  it('is idempotent and pure: same input -> same output, input untouched, re-preparing the output is VALID', () => {
    const input = movement({ sku: ' A ', quantity: '3' });
    const snapshot = JSON.stringify(input);
    const a = prep(input); const b = prep(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    const again = prep(a.prepared);
    expect(again.status).toBe('VALID');
    expect(again.prepared).toEqual(a.prepared);
  });
  it('applies Unicode NFC', () => {
    const r = prep({ recordType: 'inventory_item', data: { sku: 'A', name: 'Café' } });
    expect((r.prepared!.data as { name: string }).name).toBe('Café');
    expect(r.actions).toContainEqual({ field: 'name', rule: 'unicode_nfc' });
  });
});

describe('mergePreparationIntoValidation', () => {
  it('invalidates a structurally valid but unpreparable record and does not double-report structural failures', () => {
    const records = [movement({}), { recordType: 'warehouse', data: { warehouseCode: 'W' } }, {}];
    const structural = new ManualRecordValidator().validateBatch(records);
    const merged = mergePreparationIntoValidation(structural, preparer.prepareBatch(records));
    expect(merged.records.map((r) => r.isValid)).toEqual([true, false, false]);
    expect(merged.records[1].issues.map((i) => i.ruleCode)).toEqual(['PREP_NAME_REQUIRED']);
    expect(merged.records[2].issues.every((i) => !i.ruleCode.startsWith('PREP_'))).toBe(true);
    expect(merged.allValid).toBe(false);
    expect(merged.totalErrorCount).toBe(merged.records.reduce((n, r) => n + r.errorCount, 0));
  });
});

// ── R-01A-R2 F1: exact decimals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('F1: decimal strings are accepted only when exactly representable within numeric(18,4)', () => {
  const qty = (quantity: unknown) => prep(movement({ quantity }));
  const cost = (unitCost: unknown) => prep(movement({ unitCost, unitCostCurrency: 'USD' }));

  it.each([
    ['12345678901234', 12345678901234],
    ['99999999999999', 99999999999999],
    ['12345678901234.5', 12345678901234.5],
    ['123456789012.3456', 123456789012.3456],
    ['1234567890.1234', 1234567890.1234],
    ['0.0001', 0.0001],
    ['0.00010', 0.0001],
    ['  7  ', 7],
    ['+5', 5],
    ['-0.50', -0.5],
    ['000123.4500', 123.45],
    ['0.1', 0.1],
  ])('accepts %s as exactly %s', (input, expected) => {
    const r = qty(input);
    expect(r.status).toBe('AUTO_CORRECTED');
    expect(r.prepared!.data.quantity).toBe(expected);
    expect(String(r.prepared!.data.quantity)).toBe(String(expected));
  });

  it.each([
    ['9007199254740993', 'PREP_QUANTITY_OUT_OF_RANGE'],
    ['12345678901234567890', 'PREP_QUANTITY_OUT_OF_RANGE'],
    ['123456789012345', 'PREP_QUANTITY_OUT_OF_RANGE'],
    ['0.12345', 'PREP_QUANTITY_EXCEEDS_SCALE'],
    ['1.23456', 'PREP_QUANTITY_EXCEEDS_SCALE'],
    ['99999999999999.9999', 'PREP_QUANTITY_NOT_EXACT'],
    ['12345678901234.5678', 'PREP_QUANTITY_NOT_EXACT'],
    ['1234567890123.4567', 'PREP_QUANTITY_NOT_EXACT'],
    ['1e3', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['.5', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['5.', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['1,200', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['0x10', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['1_000', 'PREP_QUANTITY_INVALID_FORMAT'],
    ['', 'PREP_QUANTITY_INVALID_FORMAT'],
  ])('rejects %s with %s and yields no prepared record', (input, code) => {
    const r = qty(input);
    expect(r.issues.map((i) => i.ruleCode)).toContain(code);
    expect(r.status).toBe('REJECTED');
    expect(r.prepared).toBeNull();
  });

  it('applies the same contract to native JSON numbers', () => {
    expect(codes(movement({ quantity: 1e21 }))).toContain('PREP_QUANTITY_OUT_OF_RANGE');
    expect(codes(movement({ quantity: 123456789012345 }))).toContain('PREP_QUANTITY_OUT_OF_RANGE');
    expect(codes(movement({ quantity: 1e-7 }))).toContain('PREP_QUANTITY_EXCEEDS_SCALE');
    expect(codes(movement({ quantity: Number.NaN }))).toContain('PREP_QUANTITY_INVALID_FORMAT');
    expect(prep(movement({ quantity: 12.3456 })).status).toBe('VALID');
  });

  it('keeps the unit-cost rules: strictly positive, storable floor reported as such, scale and exactness enforced', () => {
    expect(cost('2.5').prepared!.data).toMatchObject({ unitCost: 2.5, unitCostCurrency: 'USD' });
    expect(cost('0.0001').status).toBe('AUTO_CORRECTED');
    expect(cost('0.00009').issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_BELOW_MINIMUM_PRECISION']);
    expect(cost(0.00001).issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_BELOW_MINIMUM_PRECISION']);
    expect(cost('2.123456').issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_EXCEEDS_SCALE']);
    expect(cost(2.123456).issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_EXCEEDS_SCALE']);
    expect(cost('0').issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_NOT_POSITIVE']);
    expect(cost('-1').issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_NOT_POSITIVE']);
    expect(cost('99999999999999.9999').issues.map((i) => i.ruleCode)).toEqual(['PREP_UNITCOST_NOT_EXACT']);
  });

  it('negative zero is zero: rejected as a zero quantity, never stored as -0', () => {
    expect(codes(movement({ quantity: '-0' }))).toEqual(['PREP_QUANTITY_MUST_NOT_BE_ZERO']);
  });

  it('property: an accepted decimal is exactly its own shortest rendering; every other in-contract decimal is rejected as not_exact, never rounded', () => {
    let seed = 12345;
    const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
    const digits = (n: number) => Array.from({ length: n }, () => String(next(10))).join('');
    let accepted = 0; let notExact = 0;
    for (let i = 0; i < 6000; i++) {
      // Canonical shape (no leading/trailing zeros) so the expected text is the input itself; biased toward full-width values.
      const intPart = `${1 + next(9)}${digits(next(14))}`;
      const fracLen = next(5);
      const fracPart = fracLen === 0 ? '' : `${digits(fracLen - 1)}${1 + next(9)}`;
      const text = fracPart ? `${intPart}.${fracPart}` : intPart;
      const r = exactDecimal(text, { precision: 18, scale: 4 });
      if (r.ok) {
        accepted++;
        expect(r.canonical).toBe(text);
        expect(String(r.value)).toBe(text);
      } else {
        notExact++;
        expect(r.problem).toBe('not_exact');
        expect(String(Number(text))).not.toBe(text);
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(notExact).toBeGreaterThan(100);
  });
});

// ── R-01A-R2 F2: control characters ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('F2: prohibited characters are rejected as a controlled per-record outcome', () => {
  const asRecord = (data: Record<string, unknown>) => ({ recordType: 'inventory_item', data: { sku: 'A', name: 'n', ...data } });

  it.each([
    ['NUL in a value', asRecord({ name: 'a\u0000b' })],
    ['C0 control (BEL)', asRecord({ name: 'a\u0007b' })],
    ['unit separator', asRecord({ unitOfMeasure: 'x\u001Fy' })],
    ['DEL', asRecord({ name: 'a\u007Fb' })],
    ['C1 control', asRecord({ name: 'a\u0085b' })],
    ['unpaired high surrogate', asRecord({ name: 'a\uD800b' })],
    ['unpaired low surrogate', asRecord({ name: 'a\uDC00b' })],
    ['NUL in a key', { recordType: 'inventory_item', data: { sku: 'A', name: 'n', ['x\u0000y']: 1 } }],
    ['NUL in a nested unsupported field', asRecord({ extra: { deep: ['ok', 'a\u0000b'] } })],
    ['NUL in recordType', { recordType: 'inventory_item\u0000', data: { sku: 'A', name: 'n' } }],
    ['NUL in a top-level key', { recordType: 'warehouse', data: {}, ['k\u0000']: 1 }],
  ])('%s -> single PREP_CONTROL_CHARACTER, raw not storable, nothing echoed', (_label, record) => {
    const r = prep(record);
    expect(r.status).toBe('REJECTED');
    expect(r.prepared).toBeNull();
    expect(r.rawStorable).toBe(false);
    expect(r.issues.map((i) => i.ruleCode)).toEqual(['PREP_CONTROL_CHARACTER']);
    const persisted = JSON.stringify(r.issues);
    expect(persisted).not.toContain('\\u0000');
    expect(persisted).not.toContain('\u0000');
  });

  it('rejects a non-object containing a NUL as well (a bare string record)', () => {
    expect(prep('a\u0000b').issues.map((i) => i.ruleCode)).toEqual(['PREP_CONTROL_CHARACTER']);
  });

  it('keeps legitimate international text, emoji and permitted whitespace; NFC still applies', () => {
    const name = '東京倉庫 – مستودع – Ünïcödé – 👩‍👩‍👧 – ক্ষ';
    const r = prep(asRecord({ name, unitOfMeasure: 'kg' }));
    expect(r.status).toBe('VALID');
    expect((r.prepared!.data as { name: string }).name).toBe(name);
    expect(r.rawStorable).toBe(true);
    const notes = prep(movement({ notes: 'line one\nline two\r\n\tindented' }));
    expect(notes.status).toBe('VALID');
    const nfc = prep(asRecord({ name: 'Cafe\u0301' }));
    expect((nfc.prepared!.data as { name: string }).name).toBe('Caf\u00e9');
  });

  it('does not restrict zero-width joiners in free text (contract has no such restriction); identifier fields stay ASCII-only', () => {
    expect(prep(asRecord({ name: 'a\u200Db\u200Cc' })).status).toBe('VALID');
    expect(prep({ recordType: 'inventory_item', data: { sku: 'A\u200B', name: 'n' } }).issues.map((i) => i.ruleCode)).toContain('PREP_SKU_INVALID');
  });

  it('clips echoed unsupported field names', () => {
    const r = prep({ recordType: 'warehouse', data: { warehouseCode: 'W', name: 'n', ['k'.repeat(500)]: 1 } });
    expect(r.issues[0].fieldPath!.length).toBeLessThan(100);
    expect(r.issues[0].message.length).toBeLessThan(200);
  });
});
