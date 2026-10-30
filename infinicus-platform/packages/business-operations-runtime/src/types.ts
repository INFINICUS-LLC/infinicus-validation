export type OperationalRecordType =
  | 'inventory_item'
  | 'warehouse'
  | 'inventory_movement'
  | 'purchase_order'
  | 'purchase_receipt'
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
    /** Explicit ISO 4217-style code of `unitCost`; present exactly when `unitCost` is present. Never defaulted. */
    unitCostCurrency?: string;
    referenceType?: 'purchase_receipt' | 'order_line' | 'transfer' | 'adjustment' | 'manual' | 'other';
    /** Stored in a typed uuid column: a canonical UUID (either letter case on input, stored lower-case) or absent. Anything else is refused before any SQL (BO-REF-UUID-01). */
    referenceId?: string;
    notes?: string;
  };
}

/**
 * AC-2 (owner ruling D1): master-data identity enters Business Operations through the published-record intake, never by direct SQL. BO creates the canonical
 * row; the record supplies only natural keys and descriptive attributes. Scope (tenant, workspace, business) always comes from the command context.
 */
export interface CreateInventoryItemCommand {
  type: 'create_inventory_item';
  context: OperationalCommandContext;
  payload: { sku: string; name: string; unitOfMeasure?: string };
}

export interface CreateWarehouseCommand {
  type: 'create_warehouse';
  context: OperationalCommandContext;
  payload: { warehouseCode: string; name: string };
}

/**
 * AC-2: an inventory movement addressed by NATURAL KEY (item SKU, warehouse code), because a data source cannot know BO's generated identifiers. The executor
 * resolves the keys inside the business scope (fail closed when absent) and then uses the same single movement writer as `record_inventory_movement`.
 * `occurredAt` is the business instant of the movement (demand history); it can never be in the future (database clock).
 */
export interface RecordKeyedInventoryMovementCommand {
  type: 'record_keyed_inventory_movement';
  context: OperationalCommandContext;
  payload: Omit<RecordInventoryMovementCommand['payload'], 'inventoryItemId' | 'warehouseId'> & {
    inventoryItemId?: string;
    inventoryItemSku?: string;
    warehouseId?: string;
    warehouseCode?: string;
    occurredAt?: string;
  };
}

export interface CreatePurchaseOrderCommand {
  type: 'create_purchase_order';
  context: OperationalCommandContext;
  payload: {
    supplierId: string;
    poNumber: string;
    expectedDate?: string;
    /** Explicit ISO 4217-style code. Required: there is no default currency. */
    currencyCode: string;
    totalAmount?: number;
    notes?: string;
  };
}

/**
 * Data-capture Block A: a purchase receipt. BO records the receipt header, its lines and the `receipt` inventory movement of each line in ONE transaction
 * (the movement ledger stays the one source for stock and cost). Scope (tenant, workspace, business) comes only from the command context.
 */
export interface RecordPurchaseReceiptCommand {
  type: 'record_purchase_receipt';
  context: OperationalCommandContext;
  payload: {
    purchaseOrderId: string;
    warehouseId: string;
    /** The business receipt number: unique per business, and the identity of the receipt for replay. */
    receiptNumber: string;
    /** RFC 3339 with an explicit offset: the instant the goods were received. */
    receivedAt: string;
    notes?: string;
    lines: {
      /** Optional: purchase-order lines have no write path yet (their item linkage is Block D). Validated against the receipt's purchase order when given. */
      purchaseOrderLineId?: string;
      inventoryItemId: string;
      /** Strictly positive, at most 4 decimal places. */
      quantity: number;
      unitCost?: number;
      /** Explicit ISO 4217-style code of `unitCost`; present exactly when `unitCost` is present. Never defaulted. */
      unitCostCurrency?: string;
    }[];
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

/**
 * Data-capture Block E: the BO-owned command that deliberately configures a balance's reorder policy (state UNSET -> CONFIGURED).
 * Deliberately NOT part of `OperationalCommand`: intake mappers cannot produce it and the intake path cannot run it. */
export type ReorderPolicyConfigurationSource = 'BO_COMMAND' | 'AUTHORIZED_ACTION_PACKAGE';

export interface ConfigureInventoryReorderPolicyCommand {
  type: 'configure_inventory_reorder_policy';
  context: OperationalCommandContext;
  payload: {
    inventoryItemId: string;
    warehouseId: string;
    reorderPoint: number;
    reorderQuantity: number;
    /** Who requested the configuration. Defaults to BO_COMMAND; the authorized-package path (P0-6c) sets AUTHORIZED_ACTION_PACKAGE. */
    configurationSource?: ReorderPolicyConfigurationSource;
    /**
     * Compare-and-set (P0-6c): when present, the update applies only if the locked balance still holds exactly these values; otherwise it
     * is refused with {@link ReorderBaselineChangedError} and nothing changes. Used by the authorized-action path so it never overwrites a
     * newer state; absent for a plain BO configuration.
     */
    expectedBaseline?: { reorderPoint: number; reorderQuantity: number };
    /**
     * AC-2 (owner ruling D2): when 'UNSET', the command is the FIRST configuration only - refused (ReorderPolicyAlreadyConfiguredError) when the balance is
     * already CONFIGURED, checked under the row lock. Changing a configured policy stays with the authorized-package path.
     */
    requireState?: 'UNSET';
  };
}

export type OperationalCommand =
  | CreateInventoryItemCommand
  | CreateWarehouseCommand
  | RecordKeyedInventoryMovementCommand
  | RecordInventoryMovementCommand
  | CreatePurchaseOrderCommand
  | RecordPurchaseReceiptCommand
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
