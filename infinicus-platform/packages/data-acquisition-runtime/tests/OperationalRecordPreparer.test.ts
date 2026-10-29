import { describe, it, expect } from 'vitest';
import { OperationalRecordPreparer, mergePreparationIntoValidation } from '../src/preparation/OperationalRecordPreparer.js';
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
