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

describe('R-01B-4 operational_fact: DAL preparation profile <-> BO mapper', () => {
  const mapper = mapperFor('operational_fact');
  const base = { eventType: 'sale' };

  it('the DAL enums equal the BO mapper enums exactly (every value the BO accepts is accepted, and nothing else)', () => {
    for (const eventType of ['sale', 'expense', 'inventory', 'customer', 'team', 'refund', 'Sale', '']) {
      const dal = preparer.prepareRecord({ recordType: 'operational_fact', data: { eventType } }, 0);
      const bo = mapper.validate({ eventType });
      expect(dal.status === 'REJECTED', eventType).toBe(bo.length > 0 && eventType !== 'Sale'); // 'Sale' is normalized by the DAL to a value BO accepts
    }
    for (const action of ['new', 'return', 'churn', 'hire', 'fire', 'review', 'quit', 'NEW', '']) {
      const dal = preparer.prepareRecord({ recordType: 'operational_fact', data: { ...base, action } }, 0);
      const boOnPrepared = dal.prepared ? mapper.validate(dal.prepared.data) : null;
      if (boOnPrepared) expect(boOnPrepared, action).toEqual([]);
    }
    // the exact set: probe each BO value through the DAL and each non-BO value too
    const boAccepts = (data: Record<string, unknown>) => mapper.validate(data).length === 0;
    for (const action of ['new', 'return', 'churn', 'hire', 'fire', 'review', 'quit']) {
      const dal = preparer.prepareRecord({ recordType: 'operational_fact', data: { ...base, action } }, 0).status !== 'REJECTED';
      expect(dal, action).toBe(boAccepts({ ...base, action }));
    }
  });

  it('everything the DAL prepares passes the BO mapper unchanged, and the mapper produces the matching command', () => {
    const probes: Array<Record<string, unknown>> = [
      {}, { amount: 0 }, { amount: '0.0001' }, { amount: '-12.5' }, { amount: ' 10 ' }, { quantity: '3' }, { quantity: -2 }, { amount: 99.5, quantity: 1.25 },
      { category: ' retail ' }, { customerId: 'C-1' }, { memberId: ' m ' }, { notes: '  note ' }, { action: 'HIRE' }, { eventType: ' TEAM ' },
      { amount: '1.23456' }, { amount: 'x' }, { eventType: 'refund' }, { action: 'quit' }, { customerId: 5 }, { occurredAt: '2026-01-01T00:00:00Z' },
    ];
    let accepted = 0; let rejected = 0;
    for (const probe of probes) {
      const outcome = preparer.prepareRecord({ recordType: 'operational_fact', data: { ...base, ...probe } }, 0);
      if (outcome.status === 'REJECTED') { rejected++; continue; }
      accepted++;
      const data = outcome.prepared!.data;
      expect(mapper.validate(data), JSON.stringify(data)).toEqual([]);
      const [command] = mapper.map(data, { tenantId: 't', workspaceId: 'w', businessId: 'b', correlationId: 'c', sourceReference: 's' } as never);
      expect(command.type).toBe('record_operational_fact');
      expect((command as { payload: Record<string, unknown> }).payload).toMatchObject({ eventType: data.eventType, amount: data.amount, quantity: data.quantity, notes: data.notes });
    }
    expect(accepted).toBe(14);
    expect(rejected).toBe(6);
  });

  it('what BO rejects the DAL never silently fixes into acceptance with a different meaning: non-string text and non-number amounts stay rejected', () => {
    for (const data of [{ customerId: 1 }, { memberId: true }, { category: {} }, { notes: [] }, { amount: true }, { quantity: {} }]) {
      expect(mapper.validate({ ...base, ...data }).length, JSON.stringify(data)).toBeGreaterThan(0);
      expect(preparer.prepareRecord({ recordType: 'operational_fact', data: { ...base, ...data } }, 0).status, JSON.stringify(data)).toBe('REJECTED');
    }
  });
});

describe('R-01B-5 workforce_event: DAL preparation profile <-> BO mapper', () => {
  const mapper = mapperFor('workforce_event');
  const rec = (data: Record<string, unknown>) => ({ recordType: 'workforce_event', data });

  it('the action set is identical: DAL accepts an action exactly when the BO mapper does', () => {
    for (const action of ['hire', 'fire', 'review', 'churn', 'new', 'return', 'promote']) {
      const dal = preparer.prepareRecord(rec({ memberId: 'm', action }), 0).status !== 'REJECTED';
      expect(dal, action).toBe(mapper.validate({ memberId: 'm', action }).length === 0);
    }
  });

  it('everything the DAL prepares passes the BO mapper unchanged, and the mapper produces the matching command', () => {
    const probes: Array<Record<string, unknown>> = [
      { memberId: 'm' }, { action: 'hire' }, { hours: 0 }, { hours: '0.0001' }, { hours: ' 8 ' }, { hours: 7.25, action: 'review' },
      { memberId: ' x ', action: ' FIRE ', hours: '12', notes: ' n ' }, { memberId: 'not-a-uuid/é' }, { action: 'review', notes: 'n' },
      { notes: 'only' }, {}, { memberId: null, hours: null }, { hours: -1 }, { hours: '1.23456' }, { action: 'churn' }, { memberId: 4 }, { tenantId: 't', memberId: 'm' },
    ];
    let accepted = 0; let rejected = 0;
    for (const probe of probes) {
      const outcome = preparer.prepareRecord(rec(probe), 0);
      if (outcome.status === 'REJECTED') { rejected++; continue; }
      accepted++;
      const data = outcome.prepared!.data;
      expect(mapper.validate(data), JSON.stringify(data)).toEqual([]);
      const [command] = mapper.map(data, { tenantId: 't', workspaceId: 'w', businessId: 'b', correlationId: 'c', sourceReference: 's' } as never);
      expect(command.type).toBe('record_workforce_event');
      expect((command as { payload: Record<string, unknown> }).payload).toMatchObject({ memberId: data.memberId, action: data.action, hours: data.hours, notes: data.notes });
    }
    expect(accepted).toBe(9);
    expect(rejected).toBe(8);
  });

  it('what BO rejects the DAL rejects: the empty event, negative hours, non-string ids and non-number hours', () => {
    for (const data of [{}, { notes: 'x' }, { hours: -1 }, { memberId: 1 }, { hours: true }, { memberId: 'm', notes: [] }]) {
      expect(mapper.validate(data).length, JSON.stringify(data)).toBeGreaterThan(0);
      expect(preparer.prepareRecord(rec(data), 0).status, JSON.stringify(data)).toBe('REJECTED');
    }
  });
});

describe('R-01B-8 purchase_receipt: DAL preparation profile <-> BO mapper', () => {
  const mapper = mapperFor('purchase_receipt');
  const PO = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
  const WH = '4a2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e60';
  const ITEM = '5b2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e61';
  const POLINE = '7d2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e63';
  const rec = (data: Record<string, unknown>) => ({
    recordType: 'purchase_receipt',
    data: { purchaseOrderId: PO, warehouseId: WH, receiptNumber: 'GRN-1', receivedAt: '2026-10-01T09:30:00.250Z', lines: [{ inventoryItemId: ITEM, quantity: 10 }], ...data },
  });
  const line = (data: Record<string, unknown>) => ({ inventoryItemId: ITEM, quantity: 10, ...data });

  it('everything the DAL prepares passes the BO mapper unchanged, and the mapper produces the matching command', () => {
    const probes: Array<Record<string, unknown>> = [
      {}, { notes: ' n ' }, { receiptNumber: ' GRN-2 ' }, { receivedAt: '2026-10-01T11:30:00+02:00' }, { receivedAt: '2026-10-01T09:30Z' },
      { lines: [line({ quantity: '1.5', unitCost: '2.50', unitCostCurrency: 'USD' })] },
      { lines: [line({ quantity: '0.0001', unitCost: '0.0001', unitCostCurrency: 'KWD' }), line({ quantity: '99999999999999' })] },
      { lines: [line({ unitCost: null, unitCostCurrency: null })] },
      { purchaseOrderId: PO.toUpperCase() }, { warehouseId: 'WH' }, { receivedAt: '2026-10-01' }, { receivedAt: '2026-10-01T09:30:00.123456Z' }, { lines: [] },
      { lines: [line({ quantity: 0 })] }, { lines: [line({ quantity: '1.00001' })] }, { lines: [line({ unitCost: 1 })] }, { lines: [line({ inventoryItemId: ITEM.toUpperCase() })] },
      { receiptNumber: 'x'.repeat(101) }, { tenantId: 't' },
    ];
    let accepted = 0; let rejected = 0;
    for (const probe of probes) {
      const outcome = preparer.prepareRecord(rec(probe), 0);
      if (outcome.status === 'REJECTED') { rejected++; continue; }
      accepted++;
      const data = outcome.prepared!.data;
      expect(mapper.validate(data), JSON.stringify(data)).toEqual([]);
      const [command] = mapper.map(data, { tenantId: 't', workspaceId: 'w', businessId: 'b', correlationId: 'c', sourceReference: 's' } as never);
      expect(command.type).toBe('record_purchase_receipt');
      const payload = (command as { payload: { purchaseOrderId: string; receiptNumber: string; receivedAt: string; lines: Array<Record<string, unknown>> } }).payload;
      expect(payload).toMatchObject({ purchaseOrderId: PO, warehouseId: WH, receiptNumber: data.receiptNumber, receivedAt: data.receivedAt });
      expect(payload.lines).toHaveLength((data.lines as unknown[]).length);
    }
    expect(accepted).toBe(8);
    expect(rejected).toBe(11);
  });

  it('the one deliberate difference: BO accepts the optional order-line link on a receipt line, the DAL does not (frozen Block D guard), so the record is quarantined, never altered', () => {
    const withLink = rec({ lines: [line({ purchaseOrderLineId: POLINE })] });
    expect(mapper.validate(withLink.data)).toEqual([]);
    const outcome = preparer.prepareRecord(withLink, 0);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.issues.map((i) => i.ruleCode)).toContain('PREP_UNSUPPORTED_FIELD');
  });

  it('owner ruling: the BO mapper and the DAL agree on identifiers - both reject every non-lower-case form, and the DAL never folds one into acceptance', () => {
    for (const value of [PO.toUpperCase(), `${PO.slice(0, 8).toUpperCase()}${PO.slice(8)}`, `{${PO}}`, PO.replace(/-/g, ''), ` ${PO.toUpperCase()}`]) {
      expect(mapper.validate(rec({ purchaseOrderId: value }).data).length, value).toBeGreaterThan(0);
      expect(preparer.prepareRecord(rec({ purchaseOrderId: value }), 0).status, value).toBe('REJECTED');
      expect(mapper.validate(rec({ lines: [line({ inventoryItemId: value })] }).data).length, value).toBeGreaterThan(0);
      expect(preparer.prepareRecord(rec({ lines: [line({ inventoryItemId: value })] }), 0).status, value).toBe('REJECTED');
    }
  });

  it('what BO rejects the DAL rejects: required fields, line bounds, positivity, scale, cost/currency pairing and unsupported fields', () => {
    const bad: Array<Record<string, unknown>> = [
      { purchaseOrderId: undefined }, { warehouseId: 5 }, { receiptNumber: '  ' }, { receivedAt: undefined }, { notes: 'x'.repeat(2001) }, { lines: undefined },
      { lines: Array.from({ length: 501 }, () => line({})) }, { lines: [line({ quantity: -1 })] }, { lines: [line({ quantity: '1.00001' })] },
      { lines: [line({ unitCost: '0.00001', unitCostCurrency: 'USD' })] }, { lines: [line({ unitCost: 1, unitCostCurrency: 'usd' })] },
      { lines: [line({ unitCostCurrency: 'USD' })] }, { lines: [line({ extra: 1 })] }, { extra: 1 },
    ];
    for (const data of bad) {
      expect(mapper.validate(rec(data).data).length, JSON.stringify(data).slice(0, 80)).toBeGreaterThan(0);
      expect(preparer.prepareRecord(rec(data), 0).status, JSON.stringify(data).slice(0, 80)).toBe('REJECTED');
    }
  });
});
