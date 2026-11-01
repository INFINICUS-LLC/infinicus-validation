/**
 * BI-08 warehouse load validation and mapping (BI-08-DEV-01). Pure and deterministic: no clock, no randomness, no database, no I/O.
 *
 * Frozen sources: INFINICUS-BI-08 (`WAREHOUSE-MODEL.md`: dataset type, grain, primary key, partition fields, load mode; `INTEGRATION-CONTRACT.md`: BI-07 -> BI-08 transformed
 * records with a dataset contract id), INFINICUS-BI-04 (required, type, range and allowed-value rules; error-level failures are quarantined) and the grain and partition
 * logic of the frozen BI-08 engine. Input is the contract BI-08 receives (a dataset contract plus transformed records, each with its source identity and order); output is
 * the exact row format `BiWarehouseRowRepository.appendRows` accepts, with the source identity carried inside every row.
 *
 * Fail closed. A warehouse version is sealed against the record count Business Operations declared, so a record cannot be quarantined and the version still seal: ANY
 * rejected record refuses the whole load, nothing partial is ever produced. Nothing is invented: a value is never defaulted, coerced, rounded, filled in or dropped.
 * Pattern, referential and timeliness rules of BI-04 are NOT implemented here (see docs/bi-08-warehouse-load-validation.md) and a contract cannot ask for them.
 */
import { createHash } from 'node:crypto';

export const WAREHOUSE_LOAD_LIMITS = Object.freeze({
  /** The BI-10 frozen engine reads at most this many rows per dataset; a larger load could never be calculated, so it is refused whole. */
  maxRecords: 100_000,
  maxFields: 200,
  maxIssuesReported: 100,
  maxStringLength: 10_000,
  maxIdentifierLength: 200,
});

export const FIELD_DATA_TYPES = ['string', 'integer', 'number', 'currency', 'percentage', 'boolean', 'date', 'datetime'] as const;
export type FieldDataType = (typeof FIELD_DATA_TYPES)[number];
export const DATASET_TYPES = ['fact', 'dimension', 'aggregate', 'snapshot'] as const;
export type DatasetType = (typeof DATASET_TYPES)[number];
const NUMERIC: readonly FieldDataType[] = ['integer', 'number', 'currency', 'percentage'];

export interface WarehouseFieldDefinition {
  name: string;
  dataType: FieldDataType;
  required: boolean;
  minimum?: number;
  maximum?: number;
  allowedValues?: Array<string | number | boolean>;
}
/** The dataset definition the frozen BI-08 requires (name and version belong to the dataset registry; the contract id binds the records to their definition). */
export interface WarehouseDatasetContract {
  datasetContractId: string;
  datasetType: DatasetType;
  primaryKeyFields: string[];
  partitionFields: string[];
  /** Only `append` is supported: a sealed version is immutable, so replace and upsert have no meaning here and are refused. */
  loadMode: string;
  fields: WarehouseFieldDefinition[];
}
/** A BI-07 transformed record with its source identity. `sourceIndex` is the position in the source and must strictly increase in the order offered. */
export interface TransformedRecord { sourceRecordId: string; sourceIndex: number; fields: Record<string, unknown> }

export type LoadIssueCode =
  | 'RECORD_SHAPE' | 'SOURCE_RECORD_ID_INVALID' | 'SOURCE_RECORD_ID_DUPLICATE' | 'SOURCE_ORDER_VIOLATION'
  | 'FIELD_UNMAPPED' | 'FIELD_REQUIRED' | 'FIELD_TYPE' | 'FIELD_RANGE' | 'FIELD_NOT_ALLOWED' | 'VALUE_UNSUPPORTED' | 'GRAIN_DUPLICATE';
/** Never carries a value: a position, a field name and a code. */
export interface LoadIssue { code: LoadIssueCode; recordIndex: number; field: string | null }

export interface PreparedRow { rowNumber: number; data: Record<string, unknown> }
export interface PreparedWarehouseRows {
  contractHash: string;
  recordCount: number;
  /** SHA-256 of the canonical prepared rows, in row order. Deterministic; the database computes its own authoritative fingerprints and seal when the rows are stored. */
  rowsFingerprint: string;
  rows: PreparedRow[];
  partitions: Array<{ partitionKey: string; recordCount: number }>;
}
export type LoadPreparationCode = 'CONTRACT_INVALID' | 'LOAD_MODE_UNSUPPORTED' | 'NO_RECORDS' | 'TOO_MANY_RECORDS' | 'RECORDS_REJECTED';
export type LoadPreparation =
  | { ok: true; prepared: PreparedWarehouseRows }
  | { ok: false; code: LoadPreparationCode; issueCount: number; issues: LoadIssue[] };

/** Row-data keys BI adds; a record may not carry them, a metric field may not use them. */
export const SOURCE_RECORD_ID_KEY = '__source_record_id';
export const SOURCE_INDEX_KEY = '__source_index';

const CONTRACT_KEYS = ['datasetContractId', 'datasetType', 'primaryKeyFields', 'partitionFields', 'loadMode', 'fields'];
const FIELD_KEYS = ['name', 'dataType', 'required', 'minimum', 'maximum', 'allowedValues'];
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9}|)(Z|[+-]\d{2}:\d{2})$/;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};
const isIdentifier = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= WAREHOUSE_LOAD_LIMITS.maxIdentifierLength && v.trim() === v;

/** True only for a real calendar date: 2026-02-30 is not one, and the text is never handed to a locale- or engine-dependent parser. */
function validCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}
function validDate(text: string): boolean { const m = DATE.exec(text); return !!m && validCalendarDate(+m[1]!, +m[2]!, +m[3]!); }
function validDateTime(text: string): boolean {
  const m = DATETIME.exec(text);
  return !!m && validCalendarDate(+m[1]!, +m[2]!, +m[3]!) && +m[4]! <= 23 && +m[5]! <= 59 && +m[6]! <= 59;
}

/** The contract is validated before any record is looked at. Returns a code, or null when it is acceptable. */
export function validateContract(contract: unknown): 'CONTRACT_INVALID' | 'LOAD_MODE_UNSUPPORTED' | null {
  if (!isPlainObject(contract)) return 'CONTRACT_INVALID';
  const c = contract as Partial<WarehouseDatasetContract>;
  // Unknown properties are refused, never ignored: a contract that asks for a rule this module does not implement (pattern, referential, timeliness) must not appear to be enforced.
  if (Object.keys(contract).some((k) => !CONTRACT_KEYS.includes(k))) return 'CONTRACT_INVALID';
  if (!isIdentifier(c.datasetContractId)) return 'CONTRACT_INVALID';
  if (!(DATASET_TYPES as readonly string[]).includes(c.datasetType as string)) return 'CONTRACT_INVALID';
  if (!Array.isArray(c.fields) || c.fields.length < 1 || c.fields.length > WAREHOUSE_LOAD_LIMITS.maxFields) return 'CONTRACT_INVALID';
  const declared = new Map<string, WarehouseFieldDefinition>();
  for (const f of c.fields) {
    if (!isPlainObject(f) || typeof f.name !== 'string' || !NAME.test(f.name) || declared.has(f.name)) return 'CONTRACT_INVALID';
    if (!(FIELD_DATA_TYPES as readonly string[]).includes(f.dataType as string) || typeof f.required !== 'boolean') return 'CONTRACT_INVALID';
    if (Object.keys(f).some((k) => !FIELD_KEYS.includes(k))) return 'CONTRACT_INVALID';
    const def = f as unknown as WarehouseFieldDefinition;
    const numeric = NUMERIC.includes(def.dataType);
    for (const bound of ['minimum', 'maximum'] as const) {
      if (def[bound] === undefined) continue;
      if (!numeric || typeof def[bound] !== 'number' || !Number.isFinite(def[bound])) return 'CONTRACT_INVALID';
    }
    if (def.minimum !== undefined && def.maximum !== undefined && def.minimum > def.maximum) return 'CONTRACT_INVALID';
    if (def.allowedValues !== undefined) {
      if (!Array.isArray(def.allowedValues) || def.allowedValues.length < 1 || def.allowedValues.length > 1000) return 'CONTRACT_INVALID';
      if (!def.allowedValues.every((v) => typeValid(def.dataType, v) && (typeof v !== 'number' || Number.isFinite(v)))) return 'CONTRACT_INVALID';
    }
    declared.set(def.name, def);
  }
  const fieldList = (v: unknown, mustBeRequired: boolean, nonEmpty: boolean): boolean => {
    if (!Array.isArray(v) || (nonEmpty && v.length < 1) || new Set(v).size !== v.length) return false;
    return v.every((n) => typeof n === 'string' && declared.has(n) && (!mustBeRequired || declared.get(n)!.required));
  };
  // The grain is what makes a record unique: its fields must be declared, and must always be present.
  if (!fieldList(c.primaryKeyFields, true, true)) return 'CONTRACT_INVALID';
  if (!fieldList(c.partitionFields, false, false)) return 'CONTRACT_INVALID';
  if (c.loadMode !== 'append') return typeof c.loadMode === 'string' && ['replace', 'upsert'].includes(c.loadMode) ? 'LOAD_MODE_UNSUPPORTED' : 'CONTRACT_INVALID';
  return null;
}

function typeValid(type: FieldDataType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string' && value.length <= WAREHOUSE_LOAD_LIMITS.maxStringLength;
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': case 'currency': case 'percentage': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date': return typeof value === 'string' && validDate(value);
    case 'datetime': return typeof value === 'string' && validDateTime(value);
  }
}

/** Hash of the contract's canonical form (field order is irrelevant), so a load names the exact definition it was validated against. */
export function contractHash(contract: WarehouseDatasetContract): string {
  const canonical = {
    datasetContractId: contract.datasetContractId, datasetType: contract.datasetType, loadMode: contract.loadMode,
    primaryKeyFields: [...contract.primaryKeyFields], partitionFields: [...contract.partitionFields],
    fields: [...contract.fields].sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => ({
      name: f.name, dataType: f.dataType, required: f.required, minimum: f.minimum ?? null, maximum: f.maximum ?? null, allowedValues: f.allowedValues ?? null,
    })),
  };
  return sha256('bi08-contract:' + canonicalJson(canonical));
}

/** Validates the records against the contract and maps them to warehouse rows. All-or-nothing. */
export function prepareWarehouseRows(contract: WarehouseDatasetContract, records: readonly TransformedRecord[]): LoadPreparation {
  const bad = validateContract(contract);
  if (bad) return { ok: false, code: bad, issueCount: 0, issues: [] };
  if (!Array.isArray(records) || records.length === 0) return { ok: false, code: 'NO_RECORDS', issueCount: 0, issues: [] };
  if (records.length > WAREHOUSE_LOAD_LIMITS.maxRecords) return { ok: false, code: 'TOO_MANY_RECORDS', issueCount: 0, issues: [] };

  const fields = new Map(contract.fields.map((f) => [f.name, f]));
  const issues: LoadIssue[] = []; let issueCount = 0;
  const flag = (code: LoadIssueCode, recordIndex: number, field: string | null): void => { issueCount += 1; if (issues.length < WAREHOUSE_LOAD_LIMITS.maxIssuesReported) issues.push({ code, recordIndex, field }); };

  const seenIds = new Set<string>(); const seenGrain = new Set<string>(); const partitions = new Map<string, number>();
  const rows: PreparedRow[] = []; let lastIndex = -1;

  records.forEach((record, i) => {
    if (!isPlainObject(record) || Object.keys(record).sort().join(',') !== 'fields,sourceIndex,sourceRecordId' || !isPlainObject(record.fields)) { flag('RECORD_SHAPE', i, null); return; }
    const rec = record as unknown as TransformedRecord;
    let ok = true;
    if (!isIdentifier(rec.sourceRecordId)) { flag('SOURCE_RECORD_ID_INVALID', i, null); ok = false; }
    else if (seenIds.has(rec.sourceRecordId)) { flag('SOURCE_RECORD_ID_DUPLICATE', i, null); ok = false; }
    else seenIds.add(rec.sourceRecordId);
    if (!Number.isSafeInteger(rec.sourceIndex) || rec.sourceIndex < 0 || rec.sourceIndex <= lastIndex) { flag('SOURCE_ORDER_VIOLATION', i, null); ok = false; }
    else lastIndex = rec.sourceIndex;

    const data = rec.fields;
    for (const key of Object.keys(data)) if (!fields.has(key)) { flag('FIELD_UNMAPPED', i, NAME.test(key) ? key : null); ok = false; }
    for (const def of contract.fields) {
      const present = Object.prototype.hasOwnProperty.call(data, def.name);
      const value = present ? data[def.name] : undefined;
      if (value === undefined || value === null || value === '') { if (def.required) { flag('FIELD_REQUIRED', i, def.name); ok = false; } continue; }
      if (typeof value === 'object' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) { flag('VALUE_UNSUPPORTED', i, def.name); ok = false; continue; }
      if (!typeValid(def.dataType, value)) { flag('FIELD_TYPE', i, def.name); ok = false; continue; }
      if (typeof value === 'number' && ((def.minimum !== undefined && value < def.minimum) || (def.maximum !== undefined && value > def.maximum))) { flag('FIELD_RANGE', i, def.name); ok = false; }
      if (def.allowedValues !== undefined && !def.allowedValues.includes(value as string | number | boolean)) { flag('FIELD_NOT_ALLOWED', i, def.name); ok = false; }
    }
    if (!ok) return;

    // Grain: the key is a JSON array of the key values, so no separator can make two different keys collide.
    const grainKey = JSON.stringify(contract.primaryKeyFields.map((f) => data[f]));
    if (seenGrain.has(grainKey)) { flag('GRAIN_DUPLICATE', i, null); return; }
    seenGrain.add(grainKey);
    const partition = contract.partitionFields.length === 0 ? '__unpartitioned__' : contract.partitionFields.map((f) => String(data[f] ?? 'unknown')).join('|');
    partitions.set(partition, (partitions.get(partition) ?? 0) + 1);

    rows.push({ rowNumber: i + 1, data: { ...data, [SOURCE_RECORD_ID_KEY]: rec.sourceRecordId, [SOURCE_INDEX_KEY]: rec.sourceIndex } });
  });

  if (issueCount > 0) return { ok: false, code: 'RECORDS_REJECTED', issueCount, issues };
  return {
    ok: true,
    prepared: {
      contractHash: contractHash(contract), recordCount: rows.length, rowsFingerprint: sha256('bi08-rows:' + canonicalJson(rows)), rows,
      partitions: [...partitions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([partitionKey, recordCount]) => ({ partitionKey, recordCount })),
    },
  };
}
