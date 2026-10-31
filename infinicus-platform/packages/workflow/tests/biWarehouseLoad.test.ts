/**
 * BI-08-DEV-01: pure warehouse load validation and mapping. Contracts and records here are TEST DATA written for the tests; they are not business records and no
 * production path uses them.
 */
import { describe, expect, it } from 'vitest';
import {
  prepareWarehouseRows, validateWarehouseDatasetContract, warehouseContractHash, WAREHOUSE_LOAD_LIMITS, SOURCE_INDEX_KEY, SOURCE_RECORD_ID_KEY,
  type TransformedRecord, type WarehouseDatasetContract, type LoadPreparation,
} from '../src/index.js';

const contract = (over: Partial<WarehouseDatasetContract> = {}): WarehouseDatasetContract => ({
  datasetContractId: 'contract-1', datasetType: 'fact', loadMode: 'append', primaryKeyFields: ['orderId'], partitionFields: ['region'],
  fields: [
    { name: 'orderId', dataType: 'string', required: true },
    { name: 'region', dataType: 'string', required: true, allowedValues: ['north', 'south'] },
    { name: 'amount', dataType: 'currency', required: true, minimum: 0, maximum: 1_000_000 },
    { name: 'units', dataType: 'integer', required: false, minimum: 0 },
    { name: 'paid', dataType: 'boolean', required: false },
    { name: 'day', dataType: 'date', required: true },
    { name: 'at', dataType: 'datetime', required: false },
  ], ...over,
});
const rec = (i: number, fields: Record<string, unknown> = {}): TransformedRecord => ({
  sourceRecordId: `src-${i}`, sourceIndex: i * 10,
  fields: { orderId: `o-${i}`, region: i % 2 ? 'north' : 'south', amount: 10.5 * i, day: '2026-01-15', ...fields },
});
const recs = (n: number) => Array.from({ length: n }, (_, i) => rec(i + 1));
const issues = (r: LoadPreparation) => (r.ok ? [] : r.issues.map((i) => `${i.code}:${i.recordIndex}:${i.field}`));

describe('BI-08 warehouse load - mapping', () => {
  it('maps records to rows 1..n in source order, keeps every value as given and carries the source identity and position inside each row', () => {
    const r = prepareWarehouseRows(contract(), recs(3));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.prepared.rows.map((x) => x.rowNumber)).toEqual([1, 2, 3]);
    expect(r.prepared.rows[1]!.data).toEqual({ orderId: 'o-2', region: 'south', amount: 21, day: '2026-01-15', [SOURCE_RECORD_ID_KEY]: 'src-2', [SOURCE_INDEX_KEY]: 20 });
    expect(r.prepared.recordCount).toBe(3);
    expect(r.prepared.partitions).toEqual([{ partitionKey: 'north', recordCount: 2 }, { partitionKey: 'south', recordCount: 1 }]);
  });

  it('does not invent values: an absent optional field stays absent, a null stays null, nothing is defaulted, coerced or rounded', () => {
    const r = prepareWarehouseRows(contract(), [rec(1, { units: null, paid: undefined })]);
    expect(r.ok).toBe(true); if (!r.ok) return;
    const data = r.prepared.rows[0]!.data;
    expect(data.units).toBeNull();
    expect('at' in data).toBe(false);
    expect(data.amount).toBe(10.5);
  });

  it('does not modify its inputs', () => {
    const c = contract(); const rs = recs(2); const before = JSON.stringify([c, rs]);
    prepareWarehouseRows(c, rs);
    expect(JSON.stringify([c, rs])).toBe(before);
  });

  it('is deterministic: the same input gives byte-identical rows and fingerprint, whatever the key order of the fields or the contract', () => {
    const a = prepareWarehouseRows(contract(), recs(4));
    const reorderedFields = { ...contract(), fields: [...contract().fields].reverse() };
    const reorderedRecords = recs(4).map((r) => ({ ...r, fields: Object.fromEntries(Object.entries(r.fields).reverse()) }));
    const b = prepareWarehouseRows(reorderedFields, reorderedRecords);
    expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return;
    expect(b.prepared.rowsFingerprint).toBe(a.prepared.rowsFingerprint);
    expect(b.prepared.contractHash).toBe(a.prepared.contractHash);
    expect(a.prepared.rowsFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different value, a different order or a different contract gives a different fingerprint', () => {
    const base = prepareWarehouseRows(contract(), recs(3)); if (!base.ok) throw new Error('x');
    const changed = prepareWarehouseRows(contract(), [rec(1), rec(2), rec(3, { amount: 99 })]);
    const swapped = prepareWarehouseRows(contract(), [rec(1), rec(3), rec(2)].map((r, i) => ({ ...r, sourceIndex: i }))); // different order and indexes
    const other = prepareWarehouseRows(contract({ datasetContractId: 'contract-2' }), recs(3));
    for (const r of [changed, swapped]) { expect(r.ok).toBe(true); if (r.ok) expect(r.prepared.rowsFingerprint).not.toBe(base.prepared.rowsFingerprint); }
    expect(other.ok && other.prepared.contractHash).not.toBe(base.prepared.contractHash);
  });
});

describe('BI-08 warehouse load - fail closed: one bad record refuses the whole load', () => {
  it.each([
    ['a missing required field', rec(1, { amount: undefined }), 'FIELD_REQUIRED:0:amount'],
    ['an empty required string', rec(1, { orderId: '' }), 'FIELD_REQUIRED:0:orderId'],
    ['a null required field', rec(1, { day: null }), 'FIELD_REQUIRED:0:day'],
    ['a string where a number is required (no coercion)', rec(1, { amount: '10.5' }), 'FIELD_TYPE:0:amount'],
    ['a float where an integer is required', rec(1, { units: 1.5 }), 'FIELD_TYPE:0:units'],
    ['an unsafe integer', rec(1, { units: 2 ** 53 }), 'FIELD_TYPE:0:units'],
    ['a non-finite number', rec(1, { amount: Number.POSITIVE_INFINITY }), 'VALUE_UNSUPPORTED:0:amount'],
    ['NaN', rec(1, { amount: Number.NaN }), 'VALUE_UNSUPPORTED:0:amount'],
    ['a nested value', rec(1, { units: { n: 1 } }), 'VALUE_UNSUPPORTED:0:units'],
    ['an array value', rec(1, { units: [1] }), 'VALUE_UNSUPPORTED:0:units'],
    ['a value below the minimum', rec(1, { amount: -1 }), 'FIELD_RANGE:0:amount'],
    ['a value above the maximum', rec(1, { amount: 1_000_001 }), 'FIELD_RANGE:0:amount'],
    ['a value that is not allowed', rec(1, { region: 'east' }), 'FIELD_NOT_ALLOWED:0:region'],
    ['an impossible calendar date', rec(1, { day: '2026-02-30' }), 'FIELD_TYPE:0:day'],
    ['a date in a locale format', rec(1, { day: '01/15/2026' }), 'FIELD_TYPE:0:day'],
    ['a datetime without a zone', rec(1, { at: '2026-01-15T10:00:00' }), 'FIELD_TYPE:0:at'],
    ['an hour of 24', rec(1, { at: '2026-01-15T24:00:00Z' }), 'FIELD_TYPE:0:at'],
    ['an unmapped field', rec(1, { surprise: 1 }), 'FIELD_UNMAPPED:0:surprise'],
    ['a field using the reserved identity key', rec(1, { [SOURCE_RECORD_ID_KEY]: 'forged' }), 'FIELD_UNMAPPED:0:null'],
    ['a string over the length bound', rec(1, { orderId: 'x'.repeat(WAREHOUSE_LOAD_LIMITS.maxStringLength + 1) }), 'FIELD_TYPE:0:orderId'],
  ])('%s', (_label, record, expected) => {
    const r = prepareWarehouseRows(contract(), [record, rec(2)]);
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.code).toBe('RECORDS_REJECTED');
    expect(issues(r)).toContain(expected);
    expect(JSON.stringify(r)).not.toContain('rows');
  });

  it('reports positions and field names, never a value', () => {
    const r = prepareWarehouseRows(contract(), [rec(1, { region: 'SECRET-REGION-VALUE', amount: 'SECRET-AMOUNT' })]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });

  it('refuses a duplicate grain key (composite keys cannot collide through a separator) and a duplicate source record id', () => {
    const c = contract({ primaryKeyFields: ['orderId', 'region'] });
    const dup = prepareWarehouseRows(c, [rec(1, { orderId: 'a', region: 'north' }), rec(2, { orderId: 'a', region: 'north' })]);
    expect(issues(dup)).toEqual(['GRAIN_DUPLICATE:1:null']);
    // "a|b" + "c" and "a" + "b|c" are different keys
    const ok = prepareWarehouseRows(contract({ primaryKeyFields: ['orderId', 'region'], fields: contract().fields.map((f) => (f.name === 'region' ? { name: 'region', dataType: 'string' as const, required: true } : f)) }),
      [rec(1, { orderId: 'a|b', region: 'c' }), rec(2, { orderId: 'a', region: 'b|c' })]);
    expect(ok.ok).toBe(true);
    const sameId = prepareWarehouseRows(contract(), [rec(1), { ...rec(2), sourceRecordId: 'src-1' }]);
    expect(issues(sameId)).toContain('SOURCE_RECORD_ID_DUPLICATE:1:null');
  });

  it('preserves source ordering: indexes must strictly increase in the order offered', () => {
    expect(issues(prepareWarehouseRows(contract(), [rec(2), rec(1)]))).toContain('SOURCE_ORDER_VIOLATION:1:null');
    expect(issues(prepareWarehouseRows(contract(), [rec(1), { ...rec(2), sourceIndex: 10 }]))).toContain('SOURCE_ORDER_VIOLATION:1:null');
    expect(issues(prepareWarehouseRows(contract(), [{ ...rec(1), sourceIndex: -1 }]))).toContain('SOURCE_ORDER_VIOLATION:0:null');
    expect(issues(prepareWarehouseRows(contract(), [{ ...rec(1), sourceIndex: 1.5 }]))).toContain('SOURCE_ORDER_VIOLATION:0:null');
  });

  it('refuses malformed records: wrong shape, extra properties, missing identity', () => {
    const bad: unknown[] = [null, 'x', [], { fields: {} }, { ...rec(1), extra: 1 }, { ...rec(1), fields: [] }, { ...rec(1), fields: null }];
    for (const b of bad) { const r = prepareWarehouseRows(contract(), [b as TransformedRecord]); expect(r.ok, JSON.stringify(b)).toBe(false); if (!r.ok) expect(issues(r)).toContain('RECORD_SHAPE:0:null'); }
    expect(issues(prepareWarehouseRows(contract(), [{ ...rec(1), sourceRecordId: '' }]))).toContain('SOURCE_RECORD_ID_INVALID:0:null');
    expect(issues(prepareWarehouseRows(contract(), [{ ...rec(1), sourceRecordId: ' padded ' }]))).toContain('SOURCE_RECORD_ID_INVALID:0:null');
    expect(issues(prepareWarehouseRows(contract(), [{ ...rec(1), sourceRecordId: 5 as unknown as string }]))).toContain('SOURCE_RECORD_ID_INVALID:0:null');
  });

  it('refuses no records, too many records, and a records argument that is not an array', () => {
    expect(prepareWarehouseRows(contract(), [])).toMatchObject({ ok: false, code: 'NO_RECORDS' });
    expect(prepareWarehouseRows(contract(), undefined as unknown as TransformedRecord[])).toMatchObject({ ok: false, code: 'NO_RECORDS' });
    expect(prepareWarehouseRows(contract(), new Array(WAREHOUSE_LOAD_LIMITS.maxRecords + 1) as TransformedRecord[])).toMatchObject({ ok: false, code: 'TOO_MANY_RECORDS' });
  });

  it('the limits are the frozen ones: 100000 records per dataset (the BI-10 engine reads no more), a bounded report', () => {
    expect(WAREHOUSE_LOAD_LIMITS).toMatchObject({ maxRecords: 100_000, maxIssuesReported: 100 });
  });

  it('caps the issues it reports but counts all of them', () => {
    const many = Array.from({ length: 150 }, (_, i) => rec(i + 1, { region: 'east' }));
    const r = prepareWarehouseRows(contract(), many);
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.issueCount).toBe(150); expect(r.issues).toHaveLength(WAREHOUSE_LOAD_LIMITS.maxIssuesReported);
  });
});

describe('BI-08 warehouse load - the dataset contract', () => {
  const invalid: Array<[string, unknown]> = [
    ['not an object', null], ['no contract id', contract({ datasetContractId: '' })], ['unknown dataset type', contract({ datasetType: 'cube' as never })],
    ['no fields', contract({ fields: [] })], ['duplicate field', contract({ fields: [...contract().fields, contract().fields[0]!] })],
    ['reserved field name', contract({ fields: [...contract().fields, { name: '__source_index', dataType: 'string', required: false }] })],
    ['bad field name', contract({ fields: [...contract().fields, { name: 'a b', dataType: 'string', required: false }] })],
    ['unknown data type', contract({ fields: [{ name: 'orderId', dataType: 'blob' as never, required: true }] })],
    ['no primary key (grain cannot be enforced)', contract({ primaryKeyFields: [] })],
    ['undeclared primary key field', contract({ primaryKeyFields: ['nope'] })],
    ['optional primary key field', contract({ primaryKeyFields: ['units'] })],
    ['undeclared partition field', contract({ partitionFields: ['nope'] })],
    ['range on a string', contract({ fields: [{ name: 'orderId', dataType: 'string', required: true, minimum: 1 }] })],
    ['minimum above maximum', contract({ fields: [{ name: 'orderId', dataType: 'integer', required: true, minimum: 5, maximum: 1 }] })],
    ['allowed value of the wrong type', contract({ fields: [{ name: 'orderId', dataType: 'integer', required: true, allowedValues: ['x'] }] })],
    ['unknown load mode', contract({ loadMode: 'merge' })],
  ];
  it.each(invalid)('refuses a contract that is %s, before looking at any record', (_l, c) => {
    expect(prepareWarehouseRows(c as WarehouseDatasetContract, recs(1))).toMatchObject({ ok: false, code: 'CONTRACT_INVALID' });
  });
  it('refuses replace and upsert as unsupported: a sealed version is immutable', () => {
    for (const mode of ['replace', 'upsert']) expect(prepareWarehouseRows(contract({ loadMode: mode }), recs(1))).toMatchObject({ ok: false, code: 'LOAD_MODE_UNSUPPORTED' });
    expect(validateWarehouseDatasetContract(contract({ loadMode: 'upsert' }))).toBe('LOAD_MODE_UNSUPPORTED');
  });
  it('refuses a contract that asks for a BI-04 rule that is not implemented (pattern, referential, timeliness) or any unknown property: it must never look enforced when it is not', () => {
    for (const extra of [{ pattern: '^o-' }, { referential: 'orders' }, { maximumAgeMinutes: 5 }, { default: 'x' }]) {
      const c = contract({ fields: contract().fields.map((f) => (f.name === 'orderId' ? ({ ...f, ...extra } as never) : f)) });
      expect(prepareWarehouseRows(c, recs(1)), JSON.stringify(extra)).toMatchObject({ ok: false, code: 'CONTRACT_INVALID' });
    }
    expect(prepareWarehouseRows({ ...contract(), qualityRules: [] } as never, recs(1))).toMatchObject({ ok: false, code: 'CONTRACT_INVALID' });
    expect(warehouseContractHash(contract())).toMatch(/^[0-9a-f]{64}$/);
  });
});
