export type OperationalRecordType =
  | 'inventory_movement'
  | 'purchase_order'
  | 'supplier_performance'
  | 'workforce_event'
  | 'asset_inspection'
  | 'operational_fact';

export interface OperationalSourceRecord {
  recordType: string;
  data: Record<string, unknown>;
  sourceRecordId?: string;
}

export interface OperationalCommandContext {
  tenantId: string;
  workspaceId: string;
  businessId: string;
  correlationId: string;
  causationId?: string;
  sourceReference: string;
  provenanceReference?: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: string;
}

export interface RecordInventoryMovementCommand {
  type: 'record_inventory_movement';
  context: OperationalCommandContext;
  payload: {
    inventoryItemId: string;
    warehouseId: string;
    movementType: 'receipt' | 'issue' | 'transfer_in' | 'transfer_out' | 'adjustment' | 'return' | 'write_off' | 'cycle_count';
    quantity: number;
    unitCost?: number;
    referenceType?: 'purchase_receipt' | 'order_line' | 'transfer' | 'adjustment' | 'manual' | 'other';
    referenceId?: string;
    notes?: string;
  };
}

export interface CreatePurchaseOrderCommand {
  type: 'create_purchase_order';
  context: OperationalCommandContext;
  payload: {
    supplierId: string;
    poNumber: string;
    expectedDate?: string;
    currencyCode?: string;
    totalAmount?: number;
    notes?: string;
  };
}

export interface RecordSupplierPerformanceCommand {
  type: 'record_supplier_performance';
  context: OperationalCommandContext;
  payload: {
    supplierId: string;
    periodStart: string;
    periodEnd: string;
    qualityScore: number;
    deliveryScore: number;
    priceScore: number;
    serviceScore: number;
    overallScore: number;
    notes?: string;
  };
}

export interface RecordWorkforceEventCommand {
  type: 'record_workforce_event';
  context: OperationalCommandContext;
  payload: {
    memberId?: string;
    action?: 'hire' | 'fire' | 'review';
    hours?: number;
    notes?: string;
  };
}

export interface RecordAssetInspectionCommand {
  type: 'record_asset_inspection';
  context: OperationalCommandContext;
  payload: {
    assetId: string;
    inspectionType?: 'routine' | 'safety' | 'regulatory' | 'pre_use' | 'post_use' | 'other';
    conditionRating: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
    pass: boolean;
    findings?: string;
    actionsRequired?: string;
    nextInspectionDate?: string;
  };
}

export interface RecordOperationalFactCommand {
  type: 'record_operational_fact';
  context: OperationalCommandContext;
  payload: {
    eventType: 'sale' | 'expense' | 'inventory' | 'customer' | 'team';
    amount?: number;
    quantity?: number;
    category?: string;
    customerId?: string;
    memberId?: string;
    action?: 'new' | 'return' | 'churn' | 'hire' | 'fire' | 'review';
    notes?: string;
  };
}

export type OperationalCommand =
  | RecordInventoryMovementCommand
  | CreatePurchaseOrderCommand
  | RecordSupplierPerformanceCommand
  | RecordWorkforceEventCommand
  | RecordAssetInspectionCommand
  | RecordOperationalFactCommand;

export interface IntakeMappingContext extends OperationalCommandContext {
  recordIndex: number;
}

export interface IntakeMapper {
  readonly recordType: OperationalRecordType;
  readonly version: number;
  validate(data: Record<string, unknown>): readonly string[];
  map(data: Record<string, unknown>, context: IntakeMappingContext): OperationalCommand[];
}
