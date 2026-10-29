import { describe, expect, it } from 'vitest';
import {
  CURRENCY_CODE_PATTERN as DAL_CURRENCY_CODE_PATTERN,
  OperationalRecordPreparer,
  UNIT_COST_MINIMUM,
} from '@infinicus/data-acquisition-runtime';
import { DEFAULT_INTAKE_MAPPERS, CURRENCY_CODE_PATTERN as BO_CURRENCY_CODE_PATTERN } from '../src/intake/defaultMappers.js';
import { UNIT_COST_MINIMUM_STORABLE } from '../src/unitCost.js';

/**
 * R-01A drift guard. The DAL preparation profile mirrors the BO intake contract (the DAL cannot import BO). This test fails if the two diverge:
 * everything the DAL declares prepared MUST pass the BO mapper unchanged, and the shared constants must match.
 */
const preparer = new OperationalRecordPreparer();
const mapperFor = (recordType: string) => DEFAULT_INTAKE_MAPPERS.find((m) => m.recordType === recordType)!;

describe('R-01A DAL preparation profile <-> BO intake contract', () => {
  it('shares the currency pattern and unit-cost floor exactly', () => {
    expect(DAL_CURRENCY_CODE_PATTERN.source).toBe(BO_CURRENCY_CODE_PATTERN.source);
    expect(UNIT_COST_MINIMUM).toBe(UNIT_COST_MINIMUM_STORABLE);
  });

  const skus = ['A', 'sku-1', 'A.b_c-9', '0abc', 'x'.repeat(64), 'x'.repeat(65), '-lead', '.lead', 'has space', 'ünï', '', 'a/b'];
  const costs = [0.0001, 0.00009, 0, -1, 1, 12.3456];

  it('agrees with the BO mapper on every probe: preparer-valid => BO validate() is empty; preparer-rejected => never silently "fixed"', () => {
    const records: unknown[] = [];
    for (const sku of skus) {
      records.push({ recordType: 'inventory_item', data: { sku, name: 'n' } });
      records.push({ recordType: 'warehouse', data: { warehouseCode: sku, name: 'n' } });
      records.push({ recordType: 'inventory_movement', data: { sku, warehouseCode: 'WH', movementType: 'receipt', quantity: 1 } });
    }
    for (const unitCost of costs) {
      for (const unitCostCurrency of ['USD', 'usd', 'US', 'USDD']) {
        records.push({ recordType: 'inventory_movement', data: { sku: 'S', warehouseCode: 'W', movementType: 'issue', quantity: -2, unitCost, unitCostCurrency } });
      }
    }
    records.push({ recordType: 'inventory_movement', data: { inventoryItemId: 'id-1', warehouseId: 'id-2', movementType: 'adjustment', quantity: 3, occurredAt: '2026-03-01T08:30:00+01:00' } });

    let validCount = 0;
    for (const outcome of preparer.prepareBatch(records)) {
      if (outcome.status === 'REJECTED') continue;
      validCount++;
      const prepared = outcome.prepared!;
      expect(mapperFor(prepared.recordType).validate(prepared.data), JSON.stringify(prepared)).toEqual([]);
    }
    expect(validCount).toBeGreaterThan(10);
  });

  it('never accepts what the BO mapper would reject, for raw (un-normalized) boundary inputs the DAL leaves untouched', () => {
    for (const sku of skus) {
      const dal = preparer.prepareRecord({ recordType: 'inventory_item', data: { sku, name: 'n' } }, 0);
      const bo = mapperFor('inventory_item').validate({ sku, name: 'n' });
      if (dal.status === 'VALID') expect(bo).toEqual([]);
    }
  });
});

describe('R-01B-3 purchase_order: DAL preparation profile <-> BO mapper', () => {
  const SUPPLIER = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
  const base = { supplierId: SUPPLIER, poNumber: 'PO-1', currencyCode: 'KWD' };

  it('everything the DAL prepares passes the BO purchase_order mapper unchanged, and the mapper then produces the matching command', () => {
    const probes: Array<Record<string, unknown>> = [
      {}, { totalAmount: 0 }, { totalAmount: '0.0001' }, { totalAmount: '12345678901234.5' }, { totalAmount: ' 10 ' },
      { expectedDate: '2024-02-29' }, { expectedDate: '9999-12-31' }, { notes: '  note ' }, { poNumber: '  po 7/a ' },
      { supplierId: SUPPLIER.toUpperCase() }, { currencyCode: 'USD' }, { currencyCode: 'EUR', totalAmount: 99.5, expectedDate: '2026-01-31', notes: 'x' },
      { currencyCode: 'usd' }, { currencyCode: ' KWD' }, { supplierId: 'nope' }, { totalAmount: -1 }, { totalAmount: '1.23456' }, { expectedDate: '2026-02-31' },
    ];
    let accepted = 0; let rejected = 0;
    const mapper = mapperFor('purchase_order');
    for (const probe of probes) {
      const outcome = preparer.prepareRecord({ recordType: 'purchase_order', data: { ...base, ...probe } }, 0);
      if (outcome.status === 'REJECTED') { rejected++; continue; }
      accepted++;
      const data = outcome.prepared!.data;
      expect(mapper.validate(data), JSON.stringify(data)).toEqual([]);
      const [command] = mapper.map(data, { tenantId: 't', workspaceId: 'w', businessId: 'b', correlationId: 'c', sourceReference: 's' } as never);
      expect(command.type).toBe('create_purchase_order');
      expect((command as { payload: Record<string, unknown> }).payload).toMatchObject({ supplierId: SUPPLIER, currencyCode: data.currencyCode, poNumber: data.poNumber });
    }
    expect(accepted).toBeGreaterThan(10);
    expect(rejected).toBe(6);
  });

  it('shares the currency rule exactly: whatever the BO mapper rejects as a currency, the DAL rejects too', () => {
    const mapper = mapperFor('purchase_order');
    for (const currencyCode of ['KWD', 'kwd', ' KWD', 'KW', 'KWDD', '', 'K1D', 'USD ']) {
      const dal = preparer.prepareRecord({ recordType: 'purchase_order', data: { ...base, currencyCode } }, 0);
      const bo = mapper.validate({ ...base, currencyCode });
      if (bo.length > 0) expect(dal.status, currencyCode).toBe('REJECTED');
      if (dal.status !== 'REJECTED') expect(bo, currencyCode).toEqual([]);
    }
  });
});
