/**
 * BO-PUB-DEV-01 -> BI-08 readiness (a CONTRACT-SHAPE test, not an integration): can the PROPOSED inventory movement evidence record (BO-PUB-DEV-01, not active) be mapped
 * onto the merged BI-08 load validation? The BI package must not depend on the BO package, so the record below is a LITERAL SAMPLE in the proposed shape (test data, not a
 * business record), and the mapping function lives in this test only. Nothing here is production code and nothing is ingested.
 */
import { describe, expect, it } from 'vitest';
import { prepareWarehouseRows, SOURCE_RECORD_ID_KEY, SOURCE_INDEX_KEY, type TransformedRecord, type WarehouseDatasetContract } from '../src/index.js';

const sample = (n: number) => ({
  tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', businessId: '33333333-3333-4333-8333-333333333333',
  movementId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, inventoryItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouseId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movementType: 'receipt', quantity: '10.5', referenceType: 'manual', referenceId: null, unitCost: '2.25', unitCostCurrency: 'USD', occurredAt: `2026-01-1${n}T08:30:00.123456Z`,
  correlationId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
});
/** The proposed mapping: the evidence record's own identity and position become the BI source identity; the remaining properties are the record's fields. */
const toTransformed = (records: Array<ReturnType<typeof sample>>): TransformedRecord[] => records.map((r, i) => ({ sourceRecordId: r.movementId, sourceIndex: i, fields: { ...r } }));
const contract: WarehouseDatasetContract = {
  datasetContractId: 'proposed-inventory-movements', datasetType: 'fact', loadMode: 'append', primaryKeyFields: ['movementId'], partitionFields: ['movementType'],
  fields: [
    { name: 'tenantId', dataType: 'string', required: true }, { name: 'workspaceId', dataType: 'string', required: true }, { name: 'businessId', dataType: 'string', required: true },
    { name: 'movementId', dataType: 'string', required: true }, { name: 'inventoryItemId', dataType: 'string', required: true }, { name: 'warehouseId', dataType: 'string', required: true },
    { name: 'movementType', dataType: 'string', required: true, allowedValues: ['receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment', 'return', 'write_off', 'cycle_count'] },
    { name: 'quantity', dataType: 'string', required: true }, { name: 'referenceType', dataType: 'string', required: false }, { name: 'referenceId', dataType: 'string', required: false },
    { name: 'unitCost', dataType: 'string', required: false }, { name: 'unitCostCurrency', dataType: 'string', required: false },
    { name: 'occurredAt', dataType: 'datetime', required: true }, { name: 'correlationId', dataType: 'string', required: true },
  ],
};

describe('BO-PUB-DEV-01 -> BI-08 readiness (proposed evidence record onto the merged load validation)', () => {
  it('every property of the proposed record maps onto a BI-08 field, and the load validates: identity, order and the microsecond timestamp survive', () => {
    const r = prepareWarehouseRows(contract, toTransformed([sample(1), sample(2), sample(3)]));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.prepared.rows.map((x) => x.rowNumber)).toEqual([1, 2, 3]);
    expect(r.prepared.rows[0]!.data).toMatchObject({ movementId: sample(1).movementId, quantity: '10.5', unitCost: '2.25', occurredAt: '2026-01-11T08:30:00.123456Z', referenceId: null });
    expect(r.prepared.rows[0]!.data[SOURCE_RECORD_ID_KEY]).toBe(sample(1).movementId); expect(r.prepared.rows[1]!.data[SOURCE_INDEX_KEY]).toBe(1);
  });
  it('a record property the BI-08 contract does not declare is refused (the contract and the evidence schema cannot silently drift apart)', () => {
    const drifted = toTransformed([{ ...sample(1), notes: 'x' } as never]);
    const r = prepareWarehouseRows(contract, drifted);
    expect(r).toMatchObject({ ok: false, code: 'RECORDS_REJECTED' }); if (!r.ok) expect(r.issues).toEqual([{ code: 'FIELD_UNMAPPED', recordIndex: 0, field: 'notes' }]);
  });
  it('READINESS GAP, recorded as a test: BI-08 has no exact-decimal field type, so quantity and unitCost can only be declared as text (not range-checked) until a decimal type is approved', () => {
    const asNumber = prepareWarehouseRows({ ...contract, fields: contract.fields.map((f) => (f.name === 'quantity' ? { ...f, dataType: 'number' as const } : f)) }, toTransformed([sample(1)]));
    expect(asNumber).toMatchObject({ ok: false, code: 'RECORDS_REJECTED' }); // a decimal string is not a JSON number: BI-08 refuses it rather than coercing it
  });
});
