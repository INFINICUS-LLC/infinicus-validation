import type { IntakeMapper, OperationalCommand } from '../types.js';
import { unitCostProblem } from '../unitCost.js';
import { purchaseReceiptProblems } from '../procurement/purchaseReceipt.js';
import { canonicalUuidReference } from '../uuidReference.js';
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
/** ISO 4217-style code. Exact: no trimming, no case folding - a currency is accepted only as it was explicitly supplied. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function currencyCode(data: Record<string, unknown>, key: string, errors: string[], required: boolean): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) {
    if (required) errors.push(`${key}_required`);
    return undefined;
  }
  if (typeof value !== 'string' || !CURRENCY_CODE_PATTERN.test(value)) {
    errors.push(`${key}_invalid`);
    return undefined;
  }
  return value;
}

const FACT_TYPES = ['sale','expense','inventory','customer','team'] as const;
const FACT_ACTIONS = ['new','return','churn','hire','fire','review'] as const;

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function naturalKey(data: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = requireString(data, key, errors);
  if (value !== undefined && !SKU_PATTERN.test(value)) { errors.push(`${key}_invalid`); return undefined; }
  return value;
}
function boundedName(data: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = requireString(data, key, errors);
  if (value !== undefined && value.length > 200) { errors.push(`${key}_too_long`); return undefined; }
  return value;
}

/** AC-2 (D1): `inventory_item` v1 - SKU + name (+ optional unit of measure). Identity is a natural key; BO generates the id. Scope is never read from the record. */
export const inventoryItemMapper: IntakeMapper = {
  recordType: 'inventory_item',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    naturalKey(data, 'sku', errors);
    boundedName(data, 'name', errors);
    const uom = optionalString(data, 'unitOfMeasure', errors);
    if (uom !== undefined && uom.length > 40) errors.push('unitOfMeasure_too_long');
    return errors;
  },
  map(data, context) {
    return [{
      type: 'create_inventory_item',
      context,
      payload: { sku: data.sku as string, name: data.name as string, ...(data.unitOfMeasure != null ? { unitOfMeasure: data.unitOfMeasure as string } : {}) },
    }];
  },
};

/** AC-2 (D1): `warehouse` v1 - warehouse code + name. */
export const warehouseMapper: IntakeMapper = {
  recordType: 'warehouse',
  version: 1,
  validate(data) {
    const errors: string[] = [];
    naturalKey(data, 'warehouseCode', errors);
    boundedName(data, 'name', errors);
    return errors;
  },
  map(data, context) {
    return [{ type: 'create_warehouse', context, payload: { warehouseCode: data.warehouseCode as string, name: data.name as string } }];
  },
};

export const inventoryMovementMapper: IntakeMapper = {
  recordType: 'inventory_movement',
  // v2 (data-capture Block C): a cost must be explicitly currency-tagged; (Block B) a present cost must be strictly positive. Records without a cost are unchanged.
  // v3 (AC-2): the item and warehouse may be addressed by natural key (`sku`, `warehouseCode`) instead of BO identifiers, and the record may state the business
  // instant of the movement (`occurredAt`). A v2-shaped record (identifiers only, no instant) maps exactly as before.
  version: 3,
  validate(data) {
    const errors: string[] = [];
    const hasId = data.inventoryItemId !== undefined; const hasSku = data.sku !== undefined;
    if (hasId === hasSku) errors.push('exactly_one_of_inventoryItemId_and_sku');
    else if (hasId) requireString(data, 'inventoryItemId', errors);
    else naturalKey(data, 'sku', errors);
    const hasWid = data.warehouseId !== undefined; const hasCode = data.warehouseCode !== undefined;
    if (hasWid === hasCode) errors.push('exactly_one_of_warehouseId_and_warehouseCode');
    else if (hasWid) requireString(data, 'warehouseId', errors);
    else naturalKey(data, 'warehouseCode', errors);
    dateString(data, 'occurredAt', errors, false);
    enumString(data, 'movementType', INVENTORY_TYPES, errors);
    const quantity = requireFiniteNumber(data, 'quantity', errors);
    if (quantity === 0) errors.push('quantity_must_not_be_zero');
    const unitCost = optionalFiniteNumber(data, 'unitCost', errors);
    // Data-capture Block B: a cost is optional, but when present it must be strictly positive and storable. Never rounded or coerced.
    if (unitCost !== undefined) {
      const problem = unitCostProblem(unitCost);
      if (problem === 'not_positive') errors.push('unitCost_not_positive');
      else if (problem === 'below_minimum_precision') errors.push('unitCost_below_minimum_precision');
    }
    const unitCostCurrency = currencyCode(data, 'unitCostCurrency', errors, false);
    // Cost and currency travel together. Nothing is ever filled in from a default (USD, tenant, business or purchase order).
    if (unitCost !== undefined && unitCostCurrency === undefined && !errors.includes('unitCostCurrency_invalid')) errors.push('unitCostCurrency_required_with_unitCost');
    if (unitCost === undefined && unitCostCurrency !== undefined && !errors.includes('unitCost_invalid')) errors.push('unitCost_required_with_unitCostCurrency');
    enumString(data, 'referenceType', REFERENCE_TYPES, errors, false);
    // BO-REF-UUID-01: referenceId lands in a typed uuid column, so a malformed value is refused here as a validation reason, not left for the database.
    const referenceId = optionalString(data, 'referenceId', errors);
    if (referenceId !== undefined && canonicalUuidReference(referenceId) === null) errors.push('referenceId_invalid');
    optionalString(data, 'notes', errors);
    return errors;
  },
  map(data, context) {
    const keyed = data.sku !== undefined || data.warehouseCode !== undefined || data.occurredAt !== undefined;
    if (keyed) {
      return [{
        type: 'record_keyed_inventory_movement',
        context,
        payload: {
          ...(data.inventoryItemId !== undefined ? { inventoryItemId: data.inventoryItemId as string } : { inventoryItemSku: data.sku as string }),
          ...(data.warehouseId !== undefined ? { warehouseId: data.warehouseId as string } : { warehouseCode: data.warehouseCode as string }),
          ...(data.occurredAt !== undefined ? { occurredAt: data.occurredAt as string } : {}),
          movementType: data.movementType as typeof INVENTORY_TYPES[number],
          quantity: data.quantity as number,
          unitCost: data.unitCost as number | undefined,
          unitCostCurrency: data.unitCostCurrency as string | undefined,
          referenceType: data.referenceType as typeof REFERENCE_TYPES[number] | undefined,
          referenceId: data.referenceId as string | undefined,
          notes: data.notes as string | undefined,
        },
      }];
    }
    return [{
      type: 'record_inventory_movement',
      context,
      payload: {
        inventoryItemId: data.inventoryItemId as string,
        warehouseId: data.warehouseId as string,
        movementType: data.movementType as typeof INVENTORY_TYPES[number],
        quantity: data.quantity as number,
        unitCost: data.unitCost as number | undefined,
        unitCostCurrency: data.unitCostCurrency as string | undefined,
        referenceType: data.referenceType as typeof REFERENCE_TYPES[number] | undefined,
        referenceId: data.referenceId as string | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

export const purchaseOrderMapper: IntakeMapper = {
  recordType: 'purchase_order',
  // v2 (data-capture Block C): the currency is required and explicit; there is no default.
  version: 2,
  validate(data) {
    const errors: string[] = [];
    requireString(data, 'supplierId', errors);
    requireString(data, 'poNumber', errors);
    dateString(data, 'expectedDate', errors, false);
    currencyCode(data, 'currencyCode', errors, true);
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
        currencyCode: data.currencyCode as string,
        totalAmount: data.totalAmount as number | undefined,
        notes: data.notes as string | undefined,
      },
    }];
  },
};

/**
 * Data-capture Block A: `purchase_receipt` v1. The record's `data` has exactly the shape of the command payload; the rule set is the SAME function the
 * executor applies (purchaseReceiptProblems), so mapper and executor cannot drift. Scope is never read from the record.
 */
export const purchaseReceiptMapper: IntakeMapper = {
  recordType: 'purchase_receipt',
  version: 1,
  validate(data) {
    return purchaseReceiptProblems(data);
  },
  map(data, context) {
    const lines = (data.lines as Record<string, unknown>[]).map((line) => ({
      ...(line.purchaseOrderLineId != null ? { purchaseOrderLineId: line.purchaseOrderLineId as string } : {}),
      inventoryItemId: line.inventoryItemId as string,
      quantity: line.quantity as number,
      ...(line.unitCost != null ? { unitCost: line.unitCost as number } : {}),
      ...(line.unitCostCurrency != null ? { unitCostCurrency: line.unitCostCurrency as string } : {}),
    }));
    return [{
      type: 'record_purchase_receipt',
      context,
      payload: {
        purchaseOrderId: data.purchaseOrderId as string,
        warehouseId: data.warehouseId as string,
        receiptNumber: data.receiptNumber as string,
        receivedAt: data.receivedAt as string,
        ...(data.notes != null ? { notes: data.notes as string } : {}),
        lines,
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
  inventoryItemMapper,
  warehouseMapper,
  inventoryMovementMapper,
  purchaseOrderMapper,
  purchaseReceiptMapper,
  supplierPerformanceMapper,
  workforceEventMapper,
  assetInspectionMapper,
  operationalFactMapper,
]);

export function registerDefaultMappers<T extends { register(mapper: IntakeMapper): T }>(registry: T): T {
  for (const mapper of DEFAULT_INTAKE_MAPPERS) registry.register(mapper);
  return registry;
}
