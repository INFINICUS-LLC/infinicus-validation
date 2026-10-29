import type { BatchValidationOutcome, RecordValidationIssue } from '../types.js';
import {
  CURRENCY_CODE_PATTERN,
  INVENTORY_MOVEMENT_TYPES,
  MAX_DECIMAL_STRING_LENGTH,
  MAX_INSTANT_STRING_LENGTH,
  MAX_NAME_LENGTH,
  MAX_UNIT_OF_MEASURE_LENGTH,
  MOVEMENT_REFERENCE_TYPES,
  NATURAL_KEY_PATTERN,
  OFFSET_INSTANT_PATTERN,
  PLAIN_DECIMAL_PATTERN,
  PREPARED_RECORD_TYPES,
  UNIT_COST_MINIMUM,
  type PreparedRecordType,
} from './operationalRecordProfile.js';

export type PreparationStatus = 'VALID' | 'AUTO_CORRECTED' | 'REJECTED';

export interface PreparationAction {
  field: string;
  rule: 'trim' | 'unicode_nfc' | 'lowercase_enum' | 'numeric_string_to_number' | 'utc_instant' | 'null_omitted' | 'empty_omitted';
}

export interface PreparedRecord {
  recordType: PreparedRecordType;
  data: Record<string, unknown>;
}

export interface PreparationOutcome {
  recordIndex: number;
  status: PreparationStatus;
  /** The BO-shaped record, or null when the record was rejected. Never partially populated. */
  prepared: PreparedRecord | null;
  actions: PreparationAction[];
  issues: RecordValidationIssue[];
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);

const FIELDS: Record<PreparedRecordType, readonly string[]> = {
  inventory_item: ['sku', 'name', 'unitOfMeasure'],
  warehouse: ['warehouseCode', 'name'],
  inventory_movement: [
    'inventoryItemId', 'sku', 'warehouseId', 'warehouseCode', 'occurredAt', 'movementType', 'quantity',
    'unitCost', 'unitCostCurrency', 'referenceType', 'referenceId', 'notes',
  ],
};

/** Pattern match plus calendar sanity: Date.parse would roll 2026-02-31 over to March, silently changing the value. */
function isRealCalendarInstant(value: string): boolean {
  if (value.length > MAX_INSTANT_STRING_LENGTH || !OFFSET_INSTANT_PATTERN.test(value)) return false;
  const [year, month, day, hour, minute] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10), value.slice(11, 13), value.slice(14, 16)].map(Number);
  const second = /^\d{2}:\d{2}:(\d{2})/.exec(value.slice(11))?.[1];
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 &&
    (second === undefined || Number(second) <= 59) && (!offset || (Number(offset[1]) <= 23 && Number(offset[2]) <= 59))
  );
}

/**
 * Pure and deterministic: the same input always yields the same outcome (no clock, no randomness, no I/O). The input object is never mutated.
 */
export class OperationalRecordPreparer {
  prepareBatch(records: readonly unknown[]): PreparationOutcome[] {
    return records.map((record, index) => this.prepareRecord(record, index));
  }

  prepareRecord(record: unknown, recordIndex: number): PreparationOutcome {
    const issues: RecordValidationIssue[] = [];
    const actions: PreparationAction[] = [];
    const reject = (code: string, fieldPath: string, message: string): void => {
      issues.push({ ruleCode: `PREP_${code.toUpperCase()}`, fieldPath, severity: 'error', issueType: 'preparation', message });
    };
    const finish = (prepared: PreparedRecord | null): PreparationOutcome => {
      const rejected = issues.length > 0 || prepared === null;
      return {
        recordIndex,
        status: rejected ? 'REJECTED' : actions.length > 0 ? 'AUTO_CORRECTED' : 'VALID',
        prepared: rejected ? null : prepared,
        actions: rejected ? [] : actions,
        issues,
      };
    };

    if (!isObject(record)) {
      reject('record_not_object', '$', 'Record must be an object with recordType and data.');
      return finish(null);
    }
    for (const key of Object.keys(record)) {
      if (key !== 'recordType' && key !== 'data') reject('unsupported_field', key, `Unsupported top-level field "${key}".`);
    }
    const recordType = record.recordType;
    if (typeof recordType !== 'string' || !(PREPARED_RECORD_TYPES as readonly string[]).includes(recordType)) {
      reject('unsupported_record_type', 'recordType', 'recordType is missing or not supported by the operational preparation profile.');
      return finish(null);
    }
    if (!isObject(record.data)) {
      reject('data_required', 'data', 'data must be an object.');
      return finish(null);
    }
    const type = recordType as PreparedRecordType;
    const raw = record.data;
    for (const key of Object.keys(raw)) {
      if (!FIELDS[type].includes(key)) reject('unsupported_field', `data.${key}`, `Field "${key}" is not part of the ${type} contract.`);
    }

    const out: Raw = {};
    const fail = (field: string, code: string, message: string): void => reject(`${field}_${code}`, `data.${field}`, message);

    /** Trim + NFC. Returns undefined when absent. `required` fields that are absent/empty are rejected here. */
    const text = (field: string, required: boolean, maxLength?: number): string | undefined => {
      const value = raw[field];
      if (value === undefined) { if (required) fail(field, 'required', `${field} is required.`); return undefined; }
      if (value === null) {
        if (required) fail(field, 'required', `${field} is required.`); else actions.push({ field, rule: 'null_omitted' });
        return undefined;
      }
      if (typeof value !== 'string') { fail(field, 'invalid', `${field} must be a string.`); return undefined; }
      const trimmed = value.trim();
      const normalized = trimmed.normalize('NFC');
      if (trimmed !== value) actions.push({ field, rule: 'trim' });
      if (normalized !== trimmed) actions.push({ field, rule: 'unicode_nfc' });
      if (normalized.length === 0) {
        if (required) fail(field, 'required', `${field} is required.`); else actions.push({ field, rule: 'empty_omitted' });
        return undefined;
      }
      if (maxLength !== undefined && normalized.length > maxLength) { fail(field, 'too_long', `${field} exceeds ${maxLength} characters.`); return undefined; }
      return normalized;
    };
    const naturalKey = (field: string, required: boolean): string | undefined => {
      const value = text(field, required);
      if (value !== undefined && !NATURAL_KEY_PATTERN.test(value)) { fail(field, 'invalid', `${field} must match ${NATURAL_KEY_PATTERN}.`); return undefined; }
      return value;
    };
    const enumeration = <T extends string>(field: string, allowed: readonly T[], required: boolean): T | undefined => {
      const t = text(field, required);
      if (t === undefined) return undefined;
      const lowered = t.toLowerCase();
      if (!allowed.includes(lowered as T)) { fail(field, 'invalid', `${field} is not an allowed value.`); return undefined; }
      if (lowered !== t) actions.push({ field, rule: 'lowercase_enum' });
      return lowered as T;
    };
    const decimal = (field: string, required: boolean): number | undefined => {
      const value = raw[field];
      if (value === undefined || value === null) {
        if (required) fail(field, 'required', `${field} is required.`); else if (value === null) actions.push({ field, rule: 'null_omitted' });
        return undefined;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) { fail(field, 'invalid', `${field} must be a finite number.`); return undefined; }
        return value;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > MAX_DECIMAL_STRING_LENGTH || !PLAIN_DECIMAL_PATTERN.test(trimmed)) { fail(field, 'invalid_format', `${field} must be a plain decimal number.`); return undefined; }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) { fail(field, 'invalid', `${field} is out of range.`); return undefined; }
        if (trimmed !== value) actions.push({ field, rule: 'trim' });
        actions.push({ field, rule: 'numeric_string_to_number' });
        return parsed;
      }
      fail(field, 'invalid', `${field} must be a number.`);
      return undefined;
    };
    const put = (field: string, value: unknown): void => { if (value !== undefined) out[field] = value; };

    if (type === 'inventory_item') {
      put('sku', naturalKey('sku', true));
      put('name', text('name', true, MAX_NAME_LENGTH));
      put('unitOfMeasure', text('unitOfMeasure', false, MAX_UNIT_OF_MEASURE_LENGTH));
    } else if (type === 'warehouse') {
      put('warehouseCode', naturalKey('warehouseCode', true));
      put('name', text('name', true, MAX_NAME_LENGTH));
    } else {
      const hasId = raw.inventoryItemId !== undefined; const hasSku = raw.sku !== undefined;
      if (hasId === hasSku) reject('exactly_one_of_inventoryitemid_and_sku', 'data', 'Exactly one of inventoryItemId and sku is required.');
      else if (hasId) put('inventoryItemId', text('inventoryItemId', true));
      else put('sku', naturalKey('sku', true));
      const hasWid = raw.warehouseId !== undefined; const hasCode = raw.warehouseCode !== undefined;
      if (hasWid === hasCode) reject('exactly_one_of_warehouseid_and_warehousecode', 'data', 'Exactly one of warehouseId and warehouseCode is required.');
      else if (hasWid) put('warehouseId', text('warehouseId', true));
      else put('warehouseCode', naturalKey('warehouseCode', true));

      const occurredAt = text('occurredAt', false);
      if (occurredAt !== undefined) {
        const ms = isRealCalendarInstant(occurredAt) ? Date.parse(occurredAt) : Number.NaN;
        if (Number.isNaN(ms)) fail('occurredAt', 'invalid', 'occurredAt must be an ISO-8601 instant with an explicit offset (Z or ±hh:mm).');
        else {
          const iso = new Date(ms).toISOString();
          if (iso !== occurredAt) actions.push({ field: 'occurredAt', rule: 'utc_instant' });
          out.occurredAt = iso;
        }
      }
      put('movementType', enumeration('movementType', INVENTORY_MOVEMENT_TYPES, true));
      const quantity = decimal('quantity', true);
      if (quantity === 0) fail('quantity', 'must_not_be_zero', 'quantity must not be zero.');
      put('quantity', quantity);
      const unitCost = decimal('unitCost', false);
      if (unitCost !== undefined) {
        if (unitCost <= 0) fail('unitCost', 'not_positive', 'unitCost must be strictly positive.');
        else if (unitCost < UNIT_COST_MINIMUM) fail('unitCost', 'below_minimum_precision', `unitCost must be at least ${UNIT_COST_MINIMUM}.`);
      }
      put('unitCost', unitCost);
      // Currency: exactly as supplied (owner ruling) - not trimmed, not case-folded, never defaulted.
      const rawCurrency = raw.unitCostCurrency;
      let currency: string | undefined;
      if (rawCurrency === undefined) currency = undefined;
      else if (rawCurrency === null) actions.push({ field: 'unitCostCurrency', rule: 'null_omitted' });
      else if (typeof rawCurrency !== 'string' || !CURRENCY_CODE_PATTERN.test(rawCurrency)) fail('unitCostCurrency', 'invalid', 'unitCostCurrency must be exactly three upper-case letters.');
      else currency = rawCurrency;
      put('unitCostCurrency', currency);
      if (unitCost !== undefined && currency === undefined && !issues.some((i) => i.fieldPath === 'data.unitCostCurrency')) {
        fail('unitCostCurrency', 'required_with_unitcost', 'unitCostCurrency is required when unitCost is present.');
      }
      if (unitCost === undefined && currency !== undefined && !issues.some((i) => i.fieldPath === 'data.unitCost')) {
        fail('unitCost', 'required_with_unitcostcurrency', 'unitCost is required when unitCostCurrency is present.');
      }
      put('referenceType', enumeration('referenceType', MOVEMENT_REFERENCE_TYPES, false));
      put('referenceId', text('referenceId', false));
      put('notes', text('notes', false));
    }

    return finish({ recordType: type, data: out });
  }
}

/**
 * Combines the existing structural validation with preparation. A record is valid only when both pass; preparation issues are appended after the
 * structural ones; a structurally invalid record is not prepared (its preparation outcome is ignored so the same defect is not reported twice).
 * Duplicate detection stays the structural validator's (raw canonical keys).
 */
export function mergePreparationIntoValidation(
  structural: BatchValidationOutcome,
  preparation: readonly PreparationOutcome[]
): BatchValidationOutcome {
  const records = structural.records.map((outcome) => {
    if (!outcome.isValid) return outcome;
    const prep = preparation[outcome.recordIndex];
    if (!prep || prep.issues.length === 0) return outcome;
    const issues = [...outcome.issues, ...prep.issues];
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    return { ...outcome, issues, errorCount, warningCount: issues.length - errorCount, isValid: errorCount === 0 };
  });
  return {
    records,
    totalErrorCount: records.reduce((n, r) => n + r.errorCount, 0),
    totalWarningCount: records.reduce((n, r) => n + r.warningCount, 0),
    duplicateRecordIndexes: structural.duplicateRecordIndexes,
    allValid: records.every((r) => r.isValid),
  };
}
