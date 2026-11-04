/**
 * BI-08-DEV-02: the BI-08 exact-decimal field type. A `decimal` value is canonical decimal TEXT (the BO numeric(18,4) grammar); a JSON number is never accepted for it and a decimal
 * string is never accepted for `number`; bounds are compared exactly. Test data only.
 */
import { describe, expect, it } from 'vitest';
import { prepareWarehouseRows, validateWarehouseDatasetContract, isCanonicalDecimalText, type TransformedRecord, type WarehouseDatasetContract } from '../src/index.js';

const contract = (over: Record<string, unknown> = {}): WarehouseDatasetContract => ({
  datasetContractId: 'decimal-contract', datasetType: 'fact', loadMode: 'append', primaryKeyFields: ['id'], partitionFields: [],
  fields: [{ name: 'id', dataType: 'string', required: true }, { name: 'qty', dataType: 'decimal', required: true, ...over }],
}) as WarehouseDatasetContract;
const rec = (qty: unknown): TransformedRecord[] => [{ sourceRecordId: 's1', sourceIndex: 0, fields: { id: 'a', qty } }];
const outcome = (c: WarehouseDatasetContract, qty: unknown) => { const r = prepareWarehouseRows(c, rec(qty)); return r.ok ? 'OK' : r.issues.map((i) => i.code).join(',') || r.code; };

describe('decimal text grammar', () => {
  it.each(['0', '1', '-1', '10.5', '-0.0001', '0.0001', '99999999999999.9999', '-99999999999999.9999', '123456789012.3456'])('accepts %s', (t) => { expect(isCanonicalDecimalText(t)).toBe(true); expect(outcome(contract(), t)).toBe('OK'); });
  it.each(['', '-0', '+1', '01', '1.', '.5', '1.50', '1.00', '1e3', '1E3', ' 1', '1 ', '1,5', '0x10', 'NaN', 'Infinity', '123456789012345', '1.23456', '--1', '1.2.3', '١٢'])('refuses %j as non-canonical decimal text', (t) => {
    expect(isCanonicalDecimalText(t)).toBe(false); expect(outcome(contract(), t)).toMatch(/FIELD_TYPE|FIELD_REQUIRED/);
  });
  it('refuses every JSON number for a decimal field - no float is ever substituted - and refuses decimal text for a number field', () => {
    for (const n of [1, 10.5, 0, -1, 1e21, 0.1 + 0.2]) expect(outcome(contract(), n), String(n)).toBe('FIELD_TYPE');
    const asNumber = { ...contract(), fields: [{ name: 'id', dataType: 'string', required: true }, { name: 'qty', dataType: 'number', required: true }] } as WarehouseDatasetContract;
    expect(outcome(asNumber, '10.5')).toBe('FIELD_TYPE'); expect(outcome(asNumber, 10.5)).toBe('OK');
  });
  it('does not modify, round or reformat the value: the prepared row carries the same text', () => {
    const r = prepareWarehouseRows(contract(), rec('99999999999999.9999')); expect(r.ok && r.prepared.rows[0]!.data.qty).toBe('99999999999999.9999');
  });
});

describe('exact bounds', () => {
  it('compares minimum and maximum exactly (0.1+0.2 style traps cannot pass), inclusive at both ends', () => {
    const c = contract({ minimum: '0.0001', maximum: '10.3' });
    expect(outcome(c, '0.0001')).toBe('OK'); expect(outcome(c, '10.3')).toBe('OK'); expect(outcome(c, '5')).toBe('OK');
    expect(outcome(c, '0')).toBe('FIELD_RANGE'); expect(outcome(c, '0.00009')).toMatch(/FIELD_TYPE/); expect(outcome(c, '10.3001')).toBe('FIELD_RANGE'); expect(outcome(c, '-1')).toBe('FIELD_RANGE');
  });
  it('a negative minimum and a wide magnitude compare correctly', () => {
    const c = contract({ minimum: '-99999999999999.9999', maximum: '99999999999999.9999' });
    expect(outcome(c, '-99999999999999.9999')).toBe('OK'); expect(outcome(c, '99999999999999.9999')).toBe('OK');
  });
  it.each([
    ['a numeric bound on a decimal field', { minimum: 1 }], ['a non-canonical bound', { minimum: '1.50' }], ['a bound with an exponent', { maximum: '1e3' }], ['minimum above maximum', { minimum: '5', maximum: '4.9999' }],
  ])('refuses a contract with %s', (_l, over) => { expect(validateWarehouseDatasetContract(contract(over))).toBe('CONTRACT_INVALID'); });
  it('refuses a decimal bound on a numeric field and a numeric bound on a text field (types stay separate)', () => {
    const c = { ...contract(), fields: [{ name: 'id', dataType: 'string', required: true }, { name: 'n', dataType: 'number', required: true, minimum: '1' }] } as unknown as WarehouseDatasetContract;
    expect(validateWarehouseDatasetContract(c)).toBe('CONTRACT_INVALID');
  });
  it('allowed values of a decimal field must themselves be canonical decimal text', () => {
    expect(validateWarehouseDatasetContract(contract({ allowedValues: ['1', '2.5'] }))).toBeNull(); expect(validateWarehouseDatasetContract(contract({ allowedValues: [1] }))).toBe('CONTRACT_INVALID');
    expect(outcome(contract({ allowedValues: ['1', '2.5'] }), '2.5')).toBe('OK'); expect(outcome(contract({ allowedValues: ['1', '2.5'] }), '3')).toBe('FIELD_NOT_ALLOWED');
  });
});
