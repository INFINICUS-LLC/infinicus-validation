import type { IntakeMapper, OperationalCommand } from '../types.js';
import {
  optionalFiniteNumber,
  optionalString,
  requireFiniteNumber,
  requireString,
} from './IntakeMapperRegistry.js';

function enumString<T extends string>(
  data: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  errors: string[],
  required = true
): T | undefined {
  const value = data[key];
  if ((value === undefined || value === null) && !required) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push(`${key}_invalid`);
    return undefined;
  }
  return value as T;
}

function dateString(
  data: Record<string, unknown>,
  key: string,
  errors: string[],
  required = true
): string | undefined {
  const value = data[key];
  if ((value === undefined || value === null) && !required) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    errors.push(`${key}_invalid`);
    return undefined;
  }
  return value;
}

function booleanValue(
  data: Record<string, unknown>,
  key: string,
  errors: string[]
): boolean | undefined {
  const value = data[key];
  if (typeof value !== 'boolean') {
    errors.push(`${key}_required`);
    return undefined;
  }
  return value;
}

function score(
  data: Record<string, unknown>,
  key: string,
  errors: string[]
): number | undefined {
  const value = requireFiniteNumber(data, key, errors);
  if (value !== undefined && (value < 0 || value > 100)) errors.push(`${key}_out_of_range`);
  return value;
}

const INVENTORY_TYPES = [
  'receipt','issue','transfer_in','transfer_out','adjustment','return','write_off','cycle_count'
] as const;
const REFERENCE_TYPES = ['purchase_receipt','order_line','transfer','adjustment','manual','other'] as const;
const WORKFORCE_ACTIONS = ['hire','fire','review'] as const;
const INSPECTION_TYPES = ['routine','safety','regulatory','pre_use','post_use','other'] as const;
const CONDITION_RATINGS = ['excellent','good','fair','poor','critical'] as const;
const FACT_TYPES = ['sale','expense','inventory','customer','team'] as const;
const FACT_ACTIONS = ['new','return','churn','hire','fire','review'] as const;

export const inventoryMovementMapper: IntakeMapper = {
  recordType: 'inventory_movement',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    requireString(data, 'inventoryItemId', errors);
    requireString(data, 'warehouseId', errors);
    enumString(data, 'movementType', INVENTORY_TYPES, errors);
    const quantity = requireFiniteNumber(data, 'quantity', errors);
    if (quantity === 0) errors.push('quantity_must_not_be_zero');
    optionalFiniteNumber(data, 'unitCost', errors);
    enumString(data, 'referenceType', REFERENCE_TYPES, errors, false);
    optionalString(data, 'referenceId', errors);
    optionalString(data, 'notes', errors);
    return errors;
  },
  map(data, context) {
    return [{
      type: 'record_inventory_movement',
      context,
      payload: {
        inventoryItemId: data.inventoryItemId as string,
        warehouseId: data.warehouseId as string,
        movementType: data.movementType as typeof INVENTORY_TYPES[number],
        quantity: data.quantity as number,
        unitCost: data.unitCost as number | undefined,
        referenceType: data.referenceType as typeof REFERENCE_TYPES[number] | undefined,
        referenceId: data.referenceId as string | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const purchaseOrderMapper: IntakeMapper = {
  recordType: 'purchase_order',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    requireString(data, 'supplierId', errors);
    requireString(data, 'poNumber', errors);
    dateString(data, 'expectedDate', errors, false);
    optionalString(data, 'currencyCode', errors);
    const total = optionalFiniteNumber(data, 'totalAmount', errors);
    if (total !== undefined && total < 0) errors.push('totalAmount_negative');
    optionalString(data, 'notes', errors);
    return errors;
  },
  map(data, context) {
    return [{
      type: 'create_purchase_order',
      context,
      payload: {
        supplierId: data.supplierId as string,
        poNumber: data.poNumber as string,
        expectedDate: data.expectedDate as string | undefined,
        currencyCode: data.currencyCode as string | undefined,
        totalAmount: data.totalAmount as number | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const supplierPerformanceMapper: IntakeMapper = {
  recordType: 'supplier_performance',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    requireString(data, 'supplierId', errors);
    dateString(data, 'periodStart', errors);
    dateString(data, 'periodEnd', errors);
    score(data, 'qualityScore', errors);
    score(data, 'deliveryScore', errors);
    score(data, 'priceScore', errors);
    score(data, 'serviceScore', errors);
    score(data, 'overallScore', errors);
    optionalString(data, 'notes', errors);
    return errors;
  },
  map(data, context) {
    return [{
      type: 'record_supplier_performance',
      context,
      payload: {
        supplierId: data.supplierId as string,
        periodStart: data.periodStart as string,
        periodEnd: data.periodEnd as string,
        qualityScore: data.qualityScore as number,
        deliveryScore: data.deliveryScore as number,
        priceScore: data.priceScore as number,
        serviceScore: data.serviceScore as number,
        overallScore: data.overallScore as number,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const workforceEventMapper: IntakeMapper = {
  recordType: 'workforce_event',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    optionalString(data, 'memberId', errors);
    enumString(data, 'action', WORKFORCE_ACTIONS, errors, false);
    const hours = optionalFiniteNumber(data, 'hours', errors);
    if (hours !== undefined && hours < 0) errors.push('hours_negative');
    optionalString(data, 'notes', errors);
    if (data.memberId === undefined && data.action === undefined && data.hours === undefined) {
      errors.push('workforce_event_empty');
    }
    return errors;
  },
  map(data, context) {
    return [{
      type: 'record_workforce_event',
      context,
      payload: {
        memberId: data.memberId as string | undefined,
        action: data.action as typeof WORKFORCE_ACTIONS[number] | undefined,
        hours: data.hours as number | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const assetInspectionMapper: IntakeMapper = {
  recordType: 'asset_inspection',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    requireString(data, 'assetId', errors);
    enumString(data, 'inspectionType', INSPECTION_TYPES, errors, false);
    enumString(data, 'conditionRating', CONDITION_RATINGS, errors);
    booleanValue(data, 'pass', errors);
    optionalString(data, 'findings', errors);
    optionalString(data, 'actionsRequired', errors);
    dateString(data, 'nextInspectionDate', errors, false);
    return errors;
  },
  map(data, context) {
    return [{
      type: 'record_asset_inspection',
      context,
      payload: {
        assetId: data.assetId as string,
        inspectionType: data.inspectionType as typeof INSPECTION_TYPES[number] | undefined,
        conditionRating: data.conditionRating as typeof CONDITION_RATINGS[number],
        pass: data.pass as boolean,
        findings: data.findings as string | undefined,
        actionsRequired: data.actionsRequired as string | undefined,
        nextInspectionDate: data.nextInspectionDate as string | undefined,
      },
    }];
  },
};

export const operationalFactMapper: IntakeMapper = {
  recordType: 'operational_fact',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    enumString(data, 'eventType', FACT_TYPES, errors);
    optionalFiniteNumber(data, 'amount', errors);
    optionalFiniteNumber(data, 'quantity', errors);
    optionalString(data, 'category', errors);
    optionalString(data, 'customerId', errors);
    optionalString(data, 'memberId', errors);
    enumString(data, 'action', FACT_ACTIONS, errors, false);
    optionalString(data, 'notes', errors);
    return errors;
  },
  map(data, context): OperationalCommand[] {
    return [{
      type: 'record_operational_fact',
      context,
      payload: {
        eventType: data.eventType as typeof FACT_TYPES[number],
        amount: data.amount as number | undefined,
        quantity: data.quantity as number | undefined,
        category: data.category as string | undefined,
        customerId: data.customerId as string | undefined,
        memberId: data.memberId as string | undefined,
        action: data.action as typeof FACT_ACTIONS[number] | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const DEFAULT_INTAKE_MAPPERS: readonly IntakeMapper[] = Object.freeze([
  inventoryMovementMapper,
  purchaseOrderMapper,
  supplierPerformanceMapper,
  workforceEventMapper,
  assetInspectionMapper,
  operationalFactMapper,
]);

export function registerDefaultMappers<T extends { register(mapper: IntakeMapper): T }>(registry: T): T {
  for (const mapper of DEFAULT_INTAKE_MAPPERS) registry.register(mapper);
  return registry;
}
