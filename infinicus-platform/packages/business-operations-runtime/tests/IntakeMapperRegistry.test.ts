import { describe, expect, it } from 'vitest';
import { IntakeMapperRegistry } from '../src/intake/IntakeMapperRegistry.js';
import {
  inventoryMovementMapper,
  purchaseOrderMapper,
  registerDefaultMappers,
} from '../src/intake/defaultMappers.js';
import {
  OperationalMappingError,
  UnsupportedOperationalRecordTypeError,
} from '../src/errors.js';

const context = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  businessId: 'business-1',
  correlationId: '11111111-1111-4111-8111-111111111111',
  sourceReference: 'submission-1#0',
  provenanceReference: 'prov-1',
  idempotencyKey: 'idem-1',
  actorId: 'user-1',
  occurredAt: '2026-10-03T00:00:00.000Z',
  recordIndex: 0,
};

describe('IntakeMapperRegistry', () => {
  it('registers the six frozen BUILD-32 record types', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    expect(registry.supportedRecordTypes()).toEqual([
      'asset_inspection',
      'inventory_movement',
      'operational_fact',
      'purchase_order',
      'supplier_performance',
      'workforce_event',
    ]);
  });

  it('rejects duplicate mapper registration', () => {
    const registry = new IntakeMapperRegistry().register(inventoryMovementMapper);
    expect(() => registry.register(inventoryMovementMapper)).toThrow(OperationalMappingError);
  });

  it('fails closed for unknown record types', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    expect(() =>
      registry.mapRecord({ recordType: 'mystery', data: {} }, context)
    ).toThrow(UnsupportedOperationalRecordTypeError);
  });

  it('maps a valid inventory movement deterministically', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    const first = registry.mapRecord({
      recordType: 'inventory_movement',
      data: {
        inventoryItemId: 'item-1',
        warehouseId: 'warehouse-1',
        movementType: 'receipt',
        quantity: 5,
        unitCost: 2.5,
        unitCostCurrency: 'EUR',
      },
    }, context);
    const second = registry.mapRecord({
      recordType: 'inventory_movement',
      data: {
        inventoryItemId: 'item-1',
        warehouseId: 'warehouse-1',
        movementType: 'receipt',
        quantity: 5,
        unitCost: 2.5,
        unitCostCurrency: 'EUR',
      },
    }, context);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      type: 'record_inventory_movement',
      payload: {
        inventoryItemId: 'item-1',
        warehouseId: 'warehouse-1',
        movementType: 'receipt',
        quantity: 5,
        unitCost: 2.5,
        unitCostCurrency: 'EUR',
      },
    });
  });

  it('rejects zero-quantity inventory movements', () => {
    const registry = new IntakeMapperRegistry().register(inventoryMovementMapper);
    expect(() =>
      registry.mapRecord({
        recordType: 'inventory_movement',
        data: {
          inventoryItemId: 'item-1',
          warehouseId: 'warehouse-1',
          movementType: 'receipt',
          quantity: 0,
        },
      }, context)
    ).toThrow(/quantity_must_not_be_zero/);
  });

  it('rejects malformed purchase orders before persistence', () => {
    const registry = new IntakeMapperRegistry().register(purchaseOrderMapper);
    expect(() =>
      registry.mapRecord({
        recordType: 'purchase_order',
        data: { supplierId: '', totalAmount: -4 },
      }, context)
    ).toThrow(/supplierId_required|poNumber_required|totalAmount_negative/);
  });
});

describe('explicit currency on cost-bearing records (data-capture Block C)', () => {
  const base = { inventoryItemId: 'item-1', warehouseId: 'warehouse-1', movementType: 'receipt', quantity: 5 };
  const map = (data: Record<string, unknown>) => registerDefaultMappers(new IntakeMapperRegistry()).mapRecord({ recordType: 'inventory_movement', data }, context);
  const po = { supplierId: 's-1', poNumber: 'PO-1' };
  const mapPo = (data: Record<string, unknown>) => registerDefaultMappers(new IntakeMapperRegistry()).mapRecord({ recordType: 'purchase_order', data }, context);

  it('carries the supplied currency unchanged into the command (no default, no case folding)', () => {
    expect(map({ ...base, unitCost: 2.5, unitCostCurrency: 'JPY' })[0]).toMatchObject({ payload: { unitCost: 2.5, unitCostCurrency: 'JPY' } });
    expect(map({ ...base, unitCost: 2.5, unitCostCurrency: 'EUR' })[0]).toMatchObject({ payload: { unitCostCurrency: 'EUR' } });
  });

  it('refuses a cost without a currency and never substitutes USD or any default', () => {
    expect(() => map({ ...base, unitCost: 2.5 })).toThrow(/unitCostCurrency_required_with_unitCost/);
    expect(() => map({ ...base, unitCost: 2.5, unitCostCurrency: null })).toThrow(/unitCostCurrency_required_with_unitCost/);
  });

  it('refuses a currency without a cost', () => {
    expect(() => map({ ...base, unitCostCurrency: 'USD' })).toThrow(/unitCost_required_with_unitCostCurrency/);
  });

  it('refuses a malformed currency instead of normalising it', () => {
    for (const bad of ['usd', 'US', 'USDX', ' USD', 'U$D', '', 123]) {
      expect(() => map({ ...base, unitCost: 2.5, unitCostCurrency: bad }), String(bad)).toThrow(/unitCostCurrency_invalid/);
    }
  });

  it('a movement with no cost and no currency is unchanged', () => {
    const [command] = map(base);
    expect(command).toMatchObject({ type: 'record_inventory_movement', payload: { quantity: 5 } });
    expect((command as { payload: Record<string, unknown> }).payload.unitCostCurrency).toBeUndefined();
    expect((command as { payload: Record<string, unknown> }).payload.unitCost).toBeUndefined();
  });

  it('the mapper contract versions record the change', () => {
    expect(inventoryMovementMapper.version).toBe(2);
    expect(purchaseOrderMapper.version).toBe(2);
  });

  it('a purchase order must state its currency; a missing one is no longer USD', () => {
    expect(() => mapPo(po)).toThrow(/currencyCode_required/);
    expect(() => mapPo({ ...po, currencyCode: null })).toThrow(/currencyCode_required/);
    expect(() => mapPo({ ...po, currencyCode: 'usd' })).toThrow(/currencyCode_invalid/);
    expect(mapPo({ ...po, currencyCode: 'GBP' })[0]).toMatchObject({ type: 'create_purchase_order', payload: { currencyCode: 'GBP' } });
  });
});

describe('a present unit cost must be positive (data-capture Block B)', () => {
  const base = { inventoryItemId: 'item-1', warehouseId: 'warehouse-1', movementType: 'receipt', quantity: 5 };
  const map = (data: Record<string, unknown>) => registerDefaultMappers(new IntakeMapperRegistry()).mapRecord({ recordType: 'inventory_movement', data }, context);

  it('accepts positive finite costs with a currency, unchanged (no rounding, no coercion)', () => {
    for (const cost of [0.0001, 0.5, 2.5, 123456.7891]) {
      expect(map({ ...base, unitCost: cost, unitCostCurrency: 'EUR' })[0]).toMatchObject({ payload: { unitCost: cost, unitCostCurrency: 'EUR' } });
    }
  });

  it('refuses zero and negative costs with an explicit reason', () => {
    for (const cost of [0, -0, -1, -0.0001, -1000]) {
      expect(() => map({ ...base, unitCost: cost, unitCostCurrency: 'USD' }), String(cost)).toThrow(/unitCost_not_positive/);
    }
  });

  it('refuses a positive cost too small to store instead of rounding it to zero', () => {
    for (const cost of [0.00001, 0.00009, 1e-9]) {
      expect(() => map({ ...base, unitCost: cost, unitCostCurrency: 'USD' }), String(cost)).toThrow(/unitCost_below_minimum_precision/);
    }
  });

  it('refuses NaN, Infinity, strings and other non-numbers (not coerced)', () => {
    for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2.5', '0', true, {}, []]) {
      expect(() => map({ ...base, unitCost: cost, unitCostCurrency: 'USD' }), String(cost)).toThrow(/unitCost_invalid/);
    }
  });

  it('the Block C currency pairing still holds with a valid cost, and a missing cost stays allowed', () => {
    expect(() => map({ ...base, unitCost: 2.5 })).toThrow(/unitCostCurrency_required_with_unitCost/);
    expect(() => map({ ...base, unitCostCurrency: 'USD' })).toThrow(/unitCost_required_with_unitCostCurrency/);
    expect(map(base)[0]).toMatchObject({ type: 'record_inventory_movement' });
    expect(map({ ...base, unitCost: null, unitCostCurrency: null })[0]).toMatchObject({ type: 'record_inventory_movement' });
  });
});
