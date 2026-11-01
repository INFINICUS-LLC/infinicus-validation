/**
 * BO-PUB-DEV-01: deterministic record-level publication EVIDENCE for one Business Operations domain, the inventory movement ledger. Pure: no clock, no randomness, no
 * database, no I/O. Everything below is a PROPOSED contract (`status: PROPOSED_NOT_ACTIVE`, version `0.1.0-proposed`): it is executable and tested, but it is NOT an
 * approved, externally binding publication contract, nothing activates it, and the names in it (contract, schema version, field names) become binding only when the
 * owner approves them (see docs/bo-record-publication-evidence.md).
 *
 * What is NOT proposed here but reused: the field definitions. Every record field and rule below is the one Business Operations already enforces at its own command
 * boundary and in `business_operations.inventory_movements` (migrations 0027 and 0183): the eight movement types, the six reference types, canonical UUIDs, quantities and
 * costs as `numeric(18,4)`, a cost strictly positive and no smaller than 0.0001, an explicit ISO 4217-style currency present exactly when a cost is.
 *
 * Deliberately NOT published: `notes` (free text), `performed_by` (a person), `created_at` (storage time). A record that carries them is refused, never silently dropped.
 * Values are never defaulted, rounded or coerced; quantities and costs travel as canonical decimal TEXT so no floating-point value ever represents money.
 */
import { createHash } from 'node:crypto';

export const INVENTORY_MOVEMENT_EVIDENCE = Object.freeze({
  contract: 'bo.inventory_movements.record_evidence',
  contractVersion: '0.1.0-proposed',
  status: 'PROPOSED_NOT_ACTIVE',
  recordSchemaVersion: 'bo.inventory_movement.record.v0.1-proposed',
  domain: 'inventory_movements',
  canonicalization: 'bo-canonical-json-v1',
  digestAlgorithm: 'sha256',
  ordering: 'occurredAt asc, movementId asc',
  /** The BI-10 frozen engine reads at most this many rows per dataset; larger evidence is refused whole, never truncated. */
  maxRecords: 100_000,
  maxIssuesReported: 100,
});

export const MOVEMENT_TYPES = ['receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment', 'return', 'write_off', 'cycle_count'] as const;
export const REFERENCE_TYPES = ['purchase_receipt', 'order_line', 'transfer', 'adjustment', 'manual', 'other'] as const;
/** Properties that are known to be sensitive or non-published: named so the refusal is explicit, but the check is a closed allow-list (anything else is refused too). */
export const SENSITIVE_RECORD_PROPERTIES = ['notes', 'performedBy', 'performed_by', 'createdAt', 'created_at'] as const;

export interface InventoryMovementRecord {
  tenantId: string; workspaceId: string; businessId: string;
  movementId: string; inventoryItemId: string; warehouseId: string;
  movementType: (typeof MOVEMENT_TYPES)[number];
  /** Canonical decimal text (no exponent, no trailing zeros, at most 4 decimals). */
  quantity: string;
  referenceType: (typeof REFERENCE_TYPES)[number] | null;
  referenceId: string | null;
  unitCost: string | null; unitCostCurrency: string | null;
  /** UTC, exactly `YYYY-MM-DDTHH:MM:SS.ffffffZ` (the ledger's microsecond precision). */
  occurredAt: string;
  correlationId: string;
}
export const RECORD_PROPERTIES: readonly (keyof InventoryMovementRecord)[] = [
  'tenantId', 'workspaceId', 'businessId', 'movementId', 'inventoryItemId', 'warehouseId', 'movementType', 'quantity', 'referenceType', 'referenceId',
  'unitCost', 'unitCostCurrency', 'occurredAt', 'correlationId',
];

/** The raw values of one ledger row exactly as SQL returns them as text. */
export interface RawInventoryMovementRow {
  id: string; tenant_id: string; workspace_id: string; business_id: string; inventory_item_id: string; warehouse_id: string;
  movement_type: string; quantity: string; reference_type: string | null; reference_id: string | null;
  unit_cost: string | null; unit_cost_currency: string | null; occurred_at: string; correlation_id: string;
}

export interface EvidenceScope { tenantId: string; workspaceId: string; businessId: string }
export interface EvidencePeriod { periodStart: string; periodEnd: string }
export interface InventoryMovementEvidence {
  contract: { name: string; version: string; status: string };
  recordSchemaVersion: string;
  scope: EvidenceScope;
  source: { domain: string; periodStart: string; periodEnd: string; boPublicationPackageId: string | null };
  ordering: string;
  recordCount: number;
  records: InventoryMovementRecord[];
  digest: { algorithm: string; canonicalization: string; value: string };
  /** Derived from the digest: names exactly this evidence. */
  evidenceId: string;
  /** Not part of the digest, so a replay of the same evidence has the same digest whatever the request that asked for it. */
  provenance: { correlationId: string; owner: string };
}

export type EvidenceIssueCode =
  | 'RECORD_SHAPE' | 'RECORD_FIELD_NOT_ALLOWED' | 'RECORD_FIELD_SENSITIVE' | 'RECORD_FIELD_INVALID' | 'RECORD_FOREIGN_SCOPE' | 'RECORD_OUT_OF_PERIOD'
  | 'RECORD_COST_CURRENCY_UNPROVEN' | 'RECORD_DUPLICATE' | 'RECORD_ORDER_VIOLATION';
/** A position, a property name and a code. Never a value. */
export interface EvidenceIssue { code: EvidenceIssueCode; recordIndex: number; field: string | null }
export type EvidenceFailureCode =
  | 'ARTIFACT_INVALID' | 'CONTRACT_UNSUPPORTED' | 'SCHEMA_VERSION_UNSUPPORTED' | 'SCOPE_INVALID' | 'PERIOD_INVALID' | 'TOO_MANY_RECORDS' | 'RECORDS_REJECTED'
  | 'RECORD_COUNT_MISMATCH' | 'DIGEST_MISMATCH' | 'EVIDENCE_ID_MISMATCH' | 'EXPECTATION_MISMATCH';
export type EvidenceResult<T> = { ok: true; value: T } | { ok: false; code: EvidenceFailureCode; issueCount: number; issues: EvidenceIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WHOLE = /^-?(0|[1-9]\d{0,13})$/;
const FRACTION = /^\d{0,3}[1-9]$/;
/** Canonical decimal text: no exponent, no leading zeros, no trailing fractional zeros, no negative zero, at most 14 integer and 4 fractional digits. */
const isCanonicalDecimal = (t: unknown): t is string => {
  if (typeof t !== 'string') return false;
  const [whole, fraction, extra] = t.split('.');
  return extra === undefined && WHOLE.test(whole!) && (fraction === undefined || FRACTION.test(fraction)) && t !== '-0';
};
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const PERIOD_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const CURRENCY = /^[A-Z]{3}$/;
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

function validCalendar(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
export function validTimestamp(text: unknown): boolean { const m = typeof text === 'string' ? TIMESTAMP.exec(text) : null; return !!m && validCalendar(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!); }
export function validPeriodInstant(text: unknown): boolean { const m = typeof text === 'string' ? PERIOD_INSTANT.exec(text) : null; return !!m && validCalendar(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!); }
/** A period instant (millisecond precision) at the ledger's microsecond precision, so the two compare as text. */
export const toMicroseconds = (instant: string): string => instant.replace(/Z$/, '000Z');

/** Canonical decimal text from the text PostgreSQL returns for numeric(18,4): `12.5000` -> `12.5`, `-0.0000` -> `0`. Returns null for anything else. */
export function canonicalDecimal(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const [rawWhole, rawFraction, extra] = text.replace(/^-/, '').split('.');
  if (extra !== undefined || !/^\d{1,14}$/.test(rawWhole!) || (rawFraction !== undefined && !/^\d{1,4}$/.test(rawFraction))) return null;
  let whole = rawWhole!;
  const fraction = (rawFraction ?? '').replace(/0+$/, '');
  whole = whole.replace(/^0+(?=\d)/, '');
  const negative = text.startsWith('-') && (whole !== '0' || fraction !== '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Maps one ledger row (as SQL text) to a record. Pure formatting: it never defaults, rounds or invents a value. Returns null when a decimal is not a numeric(18,4) text. */
export function serializeInventoryMovement(row: RawInventoryMovementRow): InventoryMovementRecord | null {
  const quantity = canonicalDecimal(row.quantity);
  const unitCost = row.unit_cost === null ? null : canonicalDecimal(row.unit_cost);
  if (quantity === null || (row.unit_cost !== null && unitCost === null)) return null;
  return {
    tenantId: row.tenant_id, workspaceId: row.workspace_id, businessId: row.business_id, movementId: row.id, inventoryItemId: row.inventory_item_id, warehouseId: row.warehouse_id,
    movementType: row.movement_type as InventoryMovementRecord['movementType'], quantity, referenceType: row.reference_type as InventoryMovementRecord['referenceType'], referenceId: row.reference_id,
    unitCost, unitCostCurrency: row.unit_cost_currency, occurredAt: row.occurred_at, correlationId: row.correlation_id,
  };
}

/** Checks one record against the field definitions. Pushes value-free issues. */
function checkRecord(r: unknown, i: number, scope: EvidenceScope, period: EvidencePeriod | null, flag: (code: EvidenceIssueCode, i: number, field: string | null) => void): void {
  if (!isPlainObject(r)) { flag('RECORD_SHAPE', i, null); return; }
  for (const key of Object.keys(r)) {
    if ((RECORD_PROPERTIES as readonly string[]).includes(key)) continue;
    if ((SENSITIVE_RECORD_PROPERTIES as readonly string[]).includes(key)) flag('RECORD_FIELD_SENSITIVE', i, key);
    else flag('RECORD_FIELD_NOT_ALLOWED', i, /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) ? key : null);
  }
  const bad = (field: keyof InventoryMovementRecord): void => flag('RECORD_FIELD_INVALID', i, field);
  for (const key of RECORD_PROPERTIES) if (!Object.prototype.hasOwnProperty.call(r, key)) bad(key);
  const v = r as Partial<Record<keyof InventoryMovementRecord, unknown>>;
  for (const key of ['tenantId', 'workspaceId', 'businessId', 'movementId', 'inventoryItemId', 'warehouseId', 'correlationId'] as const) if (Object.prototype.hasOwnProperty.call(r, key) && !(typeof v[key] === 'string' && UUID.test(v[key] as string))) bad(key);
  if (v.tenantId !== scope.tenantId || v.workspaceId !== scope.workspaceId || v.businessId !== scope.businessId) flag('RECORD_FOREIGN_SCOPE', i, null);
  if (!(MOVEMENT_TYPES as readonly unknown[]).includes(v.movementType)) bad('movementType');
  if (!isCanonicalDecimal(v.quantity)) bad('quantity');
  if (!(v.referenceType === null || (REFERENCE_TYPES as readonly unknown[]).includes(v.referenceType))) bad('referenceType');
  if (!(v.referenceId === null || (typeof v.referenceId === 'string' && UUID.test(v.referenceId)))) bad('referenceId');
  const costOk = v.unitCost === null || (isCanonicalDecimal(v.unitCost) && v.unitCost.charAt(0) !== '-' && Number(v.unitCost) >= 0.0001);
  if (!costOk) bad('unitCost');
  if (!(v.unitCostCurrency === null || (typeof v.unitCostCurrency === 'string' && CURRENCY.test(v.unitCostCurrency)))) bad('unitCostCurrency');
  // The approved rule is "present exactly when a cost is". A historical row with a cost and no currency is currency-UNPROVEN: it is refused, never given a currency.
  if (costOk && v.unitCost !== null && v.unitCostCurrency === null) flag('RECORD_COST_CURRENCY_UNPROVEN', i, 'unitCostCurrency');
  if (v.unitCost === null && v.unitCostCurrency !== null && v.unitCostCurrency !== undefined) bad('unitCostCurrency');
  if (!validTimestamp(v.occurredAt)) bad('occurredAt');
  else if (period && ((v.occurredAt as string) < toMicroseconds(period.periodStart) || (v.occurredAt as string) >= toMicroseconds(period.periodEnd))) flag('RECORD_OUT_OF_PERIOD', i, 'occurredAt');
}

/** Orders the records deterministically: occurredAt, then movementId. */
export const sortRecords = (records: readonly InventoryMovementRecord[]): InventoryMovementRecord[] =>
  [...records].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.movementId < b.movementId ? -1 : a.movementId > b.movementId ? 1 : 0));

function digestBody(e: Pick<InventoryMovementEvidence, 'contract' | 'recordSchemaVersion' | 'scope' | 'source' | 'ordering' | 'recordCount' | 'records'>): string {
  return canonicalJson({ contract: e.contract, recordSchemaVersion: e.recordSchemaVersion, scope: e.scope, source: e.source, ordering: e.ordering, recordCount: e.recordCount, records: e.records });
}
export const computeDigest = (e: Parameters<typeof digestBody>[0]): string => sha256('bo-evidence-body:' + digestBody(e));
export const deriveEvidenceId = (digest: string): string => sha256('bo-evidence-id:' + INVENTORY_MOVEMENT_EVIDENCE.contract + ':' + digest);

export interface EvidenceExpectation { scope?: EvidenceScope; periodStart?: string; periodEnd?: string; recordCount?: number; digest?: string }

/** Verifies an evidence artifact completely: contract, schema, scope, period, every record, ordering, count, digest and id. Pure; used by the producer on its own output and by any later consumer. */
export function verifyInventoryMovementEvidence(artifact: unknown, expected: EvidenceExpectation = {}): EvidenceResult<InventoryMovementEvidence> {
  const fail = (code: EvidenceFailureCode, issues: EvidenceIssue[] = [], issueCount = issues.length): EvidenceResult<InventoryMovementEvidence> => ({ ok: false, code, issueCount, issues });
  if (!isPlainObject(artifact)) return fail('ARTIFACT_INVALID');
  const a = artifact as Partial<InventoryMovementEvidence> & Record<string, unknown>;
  const keys = Object.keys(a).sort().join(',');
  if (keys !== 'contract,digest,evidenceId,ordering,provenance,recordCount,recordSchemaVersion,records,scope,source') return fail('ARTIFACT_INVALID');
  const c = a.contract;
  if (!isPlainObject(c) || c.name !== INVENTORY_MOVEMENT_EVIDENCE.contract || c.version !== INVENTORY_MOVEMENT_EVIDENCE.contractVersion || c.status !== INVENTORY_MOVEMENT_EVIDENCE.status) return fail('CONTRACT_UNSUPPORTED');
  if (a.recordSchemaVersion !== INVENTORY_MOVEMENT_EVIDENCE.recordSchemaVersion) return fail('SCHEMA_VERSION_UNSUPPORTED');
  const s = a.scope;
  if (!isPlainObject(s) || Object.keys(s).sort().join(',') !== 'businessId,tenantId,workspaceId' || !['tenantId', 'workspaceId', 'businessId'].every((k) => typeof s[k] === 'string' && UUID.test(s[k] as string))) return fail('SCOPE_INVALID');
  const src = a.source;
  if (!isPlainObject(src) || Object.keys(src).sort().join(',') !== 'boPublicationPackageId,domain,periodEnd,periodStart' || src.domain !== INVENTORY_MOVEMENT_EVIDENCE.domain
    || !validPeriodInstant(src.periodStart) || !validPeriodInstant(src.periodEnd) || (src.periodStart as string) >= (src.periodEnd as string)
    || !(src.boPublicationPackageId === null || (typeof src.boPublicationPackageId === 'string' && UUID.test(src.boPublicationPackageId)))) return fail('PERIOD_INVALID');
  if (a.ordering !== INVENTORY_MOVEMENT_EVIDENCE.ordering) return fail('ARTIFACT_INVALID');
  const d = a.digest; const p = a.provenance;
  if (!isPlainObject(d) || d.algorithm !== INVENTORY_MOVEMENT_EVIDENCE.digestAlgorithm || d.canonicalization !== INVENTORY_MOVEMENT_EVIDENCE.canonicalization || typeof d.value !== 'string' || !/^[0-9a-f]{64}$/.test(d.value)
    || !isPlainObject(p) || typeof p.correlationId !== 'string' || !UUID.test(p.correlationId) || p.owner !== 'business_operations' || typeof a.evidenceId !== 'string' || !/^[0-9a-f]{64}$/.test(a.evidenceId)) return fail('ARTIFACT_INVALID');
  if (!Array.isArray(a.records) || !Number.isSafeInteger(a.recordCount)) return fail('ARTIFACT_INVALID');
  if (a.records.length > INVENTORY_MOVEMENT_EVIDENCE.maxRecords) return fail('TOO_MANY_RECORDS');
  if (a.recordCount !== a.records.length) return fail('RECORD_COUNT_MISMATCH');

  const scope = s as unknown as EvidenceScope; const period = { periodStart: src.periodStart as string, periodEnd: src.periodEnd as string };
  const issues: EvidenceIssue[] = []; let issueCount = 0;
  const flag = (code: EvidenceIssueCode, i: number, field: string | null): void => { issueCount += 1; if (issues.length < INVENTORY_MOVEMENT_EVIDENCE.maxIssuesReported) issues.push({ code, recordIndex: i, field }); };
  const ids = new Set<string>(); let previous: InventoryMovementRecord | null = null;
  a.records.forEach((r, i) => {
    checkRecord(r, i, scope, period, flag);
    if (!isPlainObject(r) || typeof r.movementId !== 'string' || typeof r.occurredAt !== 'string') return;
    const rec = r as unknown as InventoryMovementRecord;
    if (ids.has(rec.movementId)) flag('RECORD_DUPLICATE', i, 'movementId'); else ids.add(rec.movementId);
    if (previous && (rec.occurredAt < previous.occurredAt || (rec.occurredAt === previous.occurredAt && rec.movementId <= previous.movementId))) flag('RECORD_ORDER_VIOLATION', i, null);
    previous = rec;
  });
  if (issueCount > 0) return fail('RECORDS_REJECTED', issues, issueCount);

  const artifactTyped = a as unknown as InventoryMovementEvidence;
  const digest = computeDigest(artifactTyped);
  if (digest !== d.value) return fail('DIGEST_MISMATCH');
  if (deriveEvidenceId(digest) !== a.evidenceId) return fail('EVIDENCE_ID_MISMATCH');
  const x = expected;
  if ((x.scope && (x.scope.tenantId !== scope.tenantId || x.scope.workspaceId !== scope.workspaceId || x.scope.businessId !== scope.businessId))
    || (x.periodStart !== undefined && x.periodStart !== period.periodStart) || (x.periodEnd !== undefined && x.periodEnd !== period.periodEnd)
    || (x.recordCount !== undefined && x.recordCount !== a.recordCount) || (x.digest !== undefined && x.digest !== digest)) return fail('EXPECTATION_MISMATCH');
  return { ok: true, value: artifactTyped };
}

export interface BuildEvidenceInput { scope: EvidenceScope; period: EvidencePeriod; boPublicationPackageId: string | null; correlationId: string; rows: readonly RawInventoryMovementRow[] }
/** Builds the evidence artifact from ledger rows and verifies it completely before returning it, so an artifact that exists has already passed every check a consumer will make. */
export function buildInventoryMovementEvidence(input: BuildEvidenceInput): EvidenceResult<InventoryMovementEvidence> {
  const fail = (code: EvidenceFailureCode, issues: EvidenceIssue[] = [], issueCount = issues.length): EvidenceResult<InventoryMovementEvidence> => ({ ok: false, code, issueCount, issues });
  if (!isPlainObject(input.scope) || !['tenantId', 'workspaceId', 'businessId'].every((k) => typeof (input.scope as unknown as Record<string, unknown>)[k] === 'string' && UUID.test((input.scope as unknown as Record<string, string>)[k]!))) return fail('SCOPE_INVALID');
  if (!validPeriodInstant(input.period.periodStart) || !validPeriodInstant(input.period.periodEnd) || input.period.periodStart >= input.period.periodEnd) return fail('PERIOD_INVALID');
  if (input.rows.length > INVENTORY_MOVEMENT_EVIDENCE.maxRecords) return fail('TOO_MANY_RECORDS');
  const records: InventoryMovementRecord[] = []; const issues: EvidenceIssue[] = [];
  input.rows.forEach((row, i) => { const rec = serializeInventoryMovement(row); if (rec === null) issues.push({ code: 'RECORD_FIELD_INVALID', recordIndex: i, field: 'quantity' }); else records.push(rec); });
  if (issues.length > 0) return fail('RECORDS_REJECTED', issues.slice(0, INVENTORY_MOVEMENT_EVIDENCE.maxIssuesReported), issues.length);
  const ordered = sortRecords(records);
  const body = {
    contract: { name: INVENTORY_MOVEMENT_EVIDENCE.contract, version: INVENTORY_MOVEMENT_EVIDENCE.contractVersion, status: INVENTORY_MOVEMENT_EVIDENCE.status },
    recordSchemaVersion: INVENTORY_MOVEMENT_EVIDENCE.recordSchemaVersion,
    scope: { tenantId: input.scope.tenantId, workspaceId: input.scope.workspaceId, businessId: input.scope.businessId },
    source: { domain: INVENTORY_MOVEMENT_EVIDENCE.domain, periodStart: input.period.periodStart, periodEnd: input.period.periodEnd, boPublicationPackageId: input.boPublicationPackageId },
    ordering: INVENTORY_MOVEMENT_EVIDENCE.ordering, recordCount: ordered.length, records: ordered,
  };
  const value = computeDigest(body);
  const artifact: InventoryMovementEvidence = {
    ...body, digest: { algorithm: INVENTORY_MOVEMENT_EVIDENCE.digestAlgorithm, canonicalization: INVENTORY_MOVEMENT_EVIDENCE.canonicalization, value },
    evidenceId: deriveEvidenceId(value), provenance: { correlationId: input.correlationId, owner: 'business_operations' },
  };
  return verifyInventoryMovementEvidence(artifact, { scope: input.scope, periodStart: input.period.periodStart, periodEnd: input.period.periodEnd });
}
