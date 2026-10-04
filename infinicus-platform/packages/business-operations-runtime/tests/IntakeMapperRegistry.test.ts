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
