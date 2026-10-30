import type { BatchValidationOutcome, RecordValidationIssue } from '../types.js';
import {
  CURRENCY_CODE_PATTERN,
  INVENTORY_MOVEMENT_TYPES,
  MAX_INSTANT_STRING_LENGTH,
  MAX_NAME_LENGTH,
  MAX_UNIT_OF_MEASURE_LENGTH,
  MOVEMENT_QUANTITY_CONTRACT,
  MOVEMENT_REFERENCE_TYPES,
  MOVEMENT_UNIT_COST_CONTRACT,
  PURCHASE_ORDER_TOTAL_CONTRACT,
  SUPPLIER_SCORE_CONTRACT,
  SUPPLIER_SCORE_FIELDS,
  SUPPLIER_SCORE_MAXIMUM,
  SUPPLIER_SCORE_MINIMUM,
  NATURAL_KEY_PATTERN,
  OPERATIONAL_FACT_ACTIONS,
  OPERATIONAL_FACT_AMOUNT_CONTRACT,
  OPERATIONAL_FACT_EVENT_TYPES,
  OPERATIONAL_FACT_QUANTITY_CONTRACT,
  OFFSET_INSTANT_PATTERN,
  PREPARED_RECORD_TYPES,
  UNIT_COST_MINIMUM,
  type PreparedRecordType,
} from './operationalRecordProfile.js';
import { exactDecimal, type DecimalContract, type DecimalProblem } from './exactDecimal.js';
import { findProhibitedCharacter } from './textSafety.js';
import { canonicalUuid, strictCalendarDate } from './referenceFormats.js';

export type PreparationStatus = 'VALID' | 'AUTO_CORRECTED' | 'REJECTED';

export interface PreparationAction {
  field: string;
  rule: 'trim' | 'unicode_nfc' | 'lowercase_enum' | 'lowercase_uuid' | 'numeric_string_to_number' | 'utc_instant' | 'null_omitted' | 'empty_omitted';
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
  /**
   * False when the raw record contains characters PostgreSQL jsonb cannot store (NUL, unpaired surrogates). Such a record is always REJECTED and the
   * caller must persist a placeholder (see unstorableRawPlaceholder) instead of the raw value.
   */
  rawStorable: boolean;
}

/** What is persisted in place of a raw record that cannot be stored: the fact, the reason and the hash of the original. Never its content. */
export function unstorableRawPlaceholder(sha256: string): Record<string, unknown> {
  return { unstorable: true, reason: 'PREP_CONTROL_CHARACTER', sha256 };
}

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}...` : text);

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);

const FIELDS: Record<PreparedRecordType, readonly string[]> = {
  inventory_item: ['sku', 'name', 'unitOfMeasure'],
  warehouse: ['warehouseCode', 'name'],
  inventory_movement: [
    'inventoryItemId', 'sku', 'warehouseId', 'warehouseCode', 'occurredAt', 'movementType', 'quantity',
    'unitCost', 'unitCostCurrency', 'referenceType', 'referenceId', 'notes',
  ],
  purchase_order: ['supplierId', 'poNumber', 'expectedDate', 'currencyCode', 'totalAmount', 'notes'],
  supplier_performance: ['supplierId', 'periodStart', 'periodEnd', 'qualityScore', 'deliveryScore', 'priceScore', 'serviceScore', 'overallScore', 'notes'],
  operational_fact: ['eventType', 'amount', 'quantity', 'category', 'customerId', 'memberId', 'action', 'notes'],
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
    let rawStorable = true;
    const finish = (prepared: PreparedRecord | null): PreparationOutcome => {
      const rejected = issues.length > 0 || prepared === null;
      return {
        recordIndex,
        status: rejected ? 'REJECTED' : actions.length > 0 ? 'AUTO_CORRECTED' : 'VALID',
        prepared: rejected ? null : prepared,
        actions: rejected ? [] : actions,
        issues,
        rawStorable,
      };
    };

    // F2: nothing else is examined (or echoed) until the record is known to be free of characters the payload store cannot hold.
    const prohibited = findProhibitedCharacter(record);
    if (prohibited) {
      rawStorable = false;
      reject('control_character', prohibited.path, `Record contains a prohibited character (${prohibited.kind}); it cannot be stored or prepared.`);
      return finish(null);
    }

    if (!isObject(record)) {
      reject('record_not_object', '$', 'Record must be an object with recordType and data.');
      return finish(null);
    }
    for (const key of Object.keys(record)) {
      if (key !== 'recordType' && key !== 'data') reject('unsupported_field', clip(key), `Unsupported top-level field "${clip(key)}".`);
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
      if (!FIELDS[type].includes(key)) reject('unsupported_field', `data.${clip(key)}`, `Field "${clip(key)}" is not part of the ${type} contract.`);
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
    const DECIMAL_MESSAGES: Record<DecimalProblem, (field: string, c: DecimalContract) => [string, string]> = {
      invalid_format: (f) => ['invalid_format', `${f} must be a plain decimal number.`],
      exceeds_scale: (f, c) => ['exceeds_scale', `${f} allows at most ${c.scale} decimal places; the value would have to be rounded.`],
      out_of_range: (f, c) => ['out_of_range', `${f} allows at most ${c.precision - c.scale} integer digits.`],
      not_exact: (f) => ['not_exact', `${f} cannot be represented exactly as a number.`],
    };
    /** F1: a decimal is accepted only if the resulting number is exactly the supplied decimal within the field's column contract. */
    const decimal = (field: string, required: boolean, contract: DecimalContract, floor?: number): number | undefined => {
      const value = raw[field];
      if (value === undefined || value === null) {
        if (required) fail(field, 'required', `${field} is required.`); else if (value === null) actions.push({ field, rule: 'null_omitted' });
        return undefined;
      }
      if (typeof value !== 'number' && typeof value !== 'string') { fail(field, 'invalid', `${field} must be a number.`); return undefined; }
      const supplied = typeof value === 'string' ? value.trim() : value;
      const result = exactDecimal(supplied, contract);
      if (!result.ok) {
        // A positive value below the field's storable floor is reported as that, not as a scale problem (it necessarily has too many decimals).
        const approx = Number(supplied);
        if (result.problem === 'exceeds_scale' && floor !== undefined && approx > 0 && approx < floor) {
          fail(field, 'below_minimum_precision', `${field} must be at least ${floor}.`);
        } else {
          const [code, message] = DECIMAL_MESSAGES[result.problem](field, contract);
          fail(field, code, message);
        }
        return undefined;
      }
      if (typeof value === 'string') {
        if (supplied !== value) actions.push({ field, rule: 'trim' });
        actions.push({ field, rule: 'numeric_string_to_number' });
      }
      return result.value;
    };
    /** A reference to a typed uuid column: format only (lower-cased canonical form); existence in the business is Business Operations' decision. */
    const uuidReference = (field: string, required: boolean): string | undefined => {
      const value = text(field, required);
      if (value === undefined) return undefined;
      const canonical = canonicalUuid(value);
      if (canonical === null) { fail(field, 'invalid', `${field} must be a UUID.`); return undefined; }
      if (canonical !== value) actions.push({ field, rule: 'lowercase_uuid' });
      return canonical;
    };
    /** A calendar date for a date column: exactly YYYY-MM-DD, never rolled over, no time or zone invented. */
    const dateOnly = (field: string, required: boolean): string | undefined => {
      const value = text(field, required);
      if (value === undefined) return undefined;
      if (strictCalendarDate(value) === null) { fail(field, 'invalid', `${field} must be a calendar date written as YYYY-MM-DD.`); return undefined; }
      return value;
    };
    /** Currency exactly as supplied (owner ruling): not trimmed, not case-folded, never defaulted. */
    const exactCurrency = (field: string, required: boolean): string | undefined => {
      const value = raw[field];
      if (value === undefined || value === null) {
        if (required) fail(field, 'required', `${field} is required.`); else if (value === null) actions.push({ field, rule: 'null_omitted' });
        return undefined;
      }
      if (typeof value !== 'string' || !CURRENCY_CODE_PATTERN.test(value)) { fail(field, 'invalid', `${field} must be exactly three upper-case letters.`); return undefined; }
      return value;
    };
    const put = (field: string, value: unknown): void => { if (value !== undefined) out[field] = value; };

    if (type === 'inventory_item') {
      put('sku', naturalKey('sku', true));
      put('name', text('name', true, MAX_NAME_LENGTH));
      put('unitOfMeasure', text('unitOfMeasure', false, MAX_UNIT_OF_MEASURE_LENGTH));
    } else if (type === 'warehouse') {
      put('warehouseCode', naturalKey('warehouseCode', true));
      put('name', text('name', true, MAX_NAME_LENGTH));
    } else if (type === 'inventory_movement') {
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
      const quantity = decimal('quantity', true, MOVEMENT_QUANTITY_CONTRACT);
      if (quantity === 0) fail('quantity', 'must_not_be_zero', 'quantity must not be zero.');
      put('quantity', quantity);
      const unitCost = decimal('unitCost', false, MOVEMENT_UNIT_COST_CONTRACT, UNIT_COST_MINIMUM);
      if (unitCost !== undefined) {
        if (unitCost <= 0) fail('unitCost', 'not_positive', 'unitCost must be strictly positive.');
      }
      put('unitCost', unitCost);
      const currency = exactCurrency('unitCostCurrency', false);
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
    } else if (type === 'supplier_performance') {
      // Field rules mirror the BO mapper and the supplier_performance_scores columns. supplierId is a uuid column (format only; that the supplier exists in
      // the business is BO's decision). Periods are date columns. The five scores are required numbers in 0..100 stored as numeric(5,2); BO would round a
      // third decimal silently, so the DAL refuses it. sps_period_check (period_end >= period_start) is enforced by the table and would abort the whole
      // atomic handoff with a raw database error, so the DAL refuses a reversed period too. evaluatedBy is not part of the BO contract. BO defines no
      // identity rule for a score row (no unique constraint), so no duplicate or conflict is reported.
      put('supplierId', uuidReference('supplierId', true));
      const periodStart = dateOnly('periodStart', true);
      const periodEnd = dateOnly('periodEnd', true);
      put('periodStart', periodStart);
      put('periodEnd', periodEnd);
      if (periodStart !== undefined && periodEnd !== undefined && periodEnd < periodStart) {
        fail('periodEnd', 'before_periodstart', 'periodEnd must not be earlier than periodStart.');
      }
      for (const field of SUPPLIER_SCORE_FIELDS) {
        const value = decimal(field, true, SUPPLIER_SCORE_CONTRACT);
        if (value !== undefined && (value < SUPPLIER_SCORE_MINIMUM || value > SUPPLIER_SCORE_MAXIMUM)) {
          fail(field, 'out_of_range', `${field} must be between ${SUPPLIER_SCORE_MINIMUM} and ${SUPPLIER_SCORE_MAXIMUM}.`);
        } else put(field, value);
      }
      put('notes', text('notes', false));
    } else if (type === 'operational_fact') {
      // Field rules mirror the BO mapper and the business_events columns. customerId / memberId / category are TEXT columns in BO (not uuid), so they
      // get trim / NFC / non-empty only. BO defines no identity rule for a fact (no natural key), so no duplicate or conflict is reported.
      // occurredAt is not part of the BO contract (the database stamps it) and is therefore an unsupported field.
      put('eventType', enumeration('eventType', OPERATIONAL_FACT_EVENT_TYPES, true));
      put('amount', decimal('amount', false, OPERATIONAL_FACT_AMOUNT_CONTRACT));
      put('quantity', decimal('quantity', false, OPERATIONAL_FACT_QUANTITY_CONTRACT));
      put('category', text('category', false));
      put('customerId', text('customerId', false));
      put('memberId', text('memberId', false));
      put('action', enumeration('action', OPERATIONAL_FACT_ACTIONS, false));
      put('notes', text('notes', false));
    } else {
      // purchase_order. Field rules mirror the BO mapper and the purchase_orders columns; the DAL adds only column-type format checks.
      // poNumber has no format rule in BO (free text, unique per business), so none is invented here beyond trim / NFC / non-empty.
      put('supplierId', uuidReference('supplierId', true));
      put('poNumber', text('poNumber', true));
      put('expectedDate', dateOnly('expectedDate', false));
      put('currencyCode', exactCurrency('currencyCode', true));
      const total = decimal('totalAmount', false, PURCHASE_ORDER_TOTAL_CONTRACT);
      if (total !== undefined && total < 0) fail('totalAmount', 'negative', 'totalAmount must not be negative.');
      put('totalAmount', total);
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
