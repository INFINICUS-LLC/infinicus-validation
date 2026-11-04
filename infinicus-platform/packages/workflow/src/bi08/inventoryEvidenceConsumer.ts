/**
 * BI-08-DEV-02, consumer side of the BO -> BI record pathway. Pure and deterministic: no clock, no randomness, no database, no I/O.
 *
 * Business Intelligence consumes ONLY approved BO publication evidence for one domain (inventory movements), through a read-only port. It does not trust the port: this module
 * independently re-verifies what it is given against the contract identifiers it was built for (the BO-PUB-DEV-01/02 development candidate, 0.1.0-proposed, PROPOSED_NOT_ACTIVE),
 * checks the evidence belongs to exactly the tenant, workspace, business and publication header the caller expects, re-derives the SHA-256 digest and the evidence id from the
 * canonical body, checks the declared order, the exact property set of every record and its scope, and the cost/currency invariant. It then maps the verified records onto the BI-08
 * load contract (exact-decimal text for quantities and costs). It imports nothing from Business Operations: the contract is restated here, and the live end-to-end test proves the
 * two sides agree.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, type TransformedRecord, type WarehouseDatasetContract } from './warehouseLoad.js';

export const CONSUMED_EVIDENCE_CONTRACT = Object.freeze({
  name: 'bo.inventory_movements.record_evidence',
  version: '0.1.0-proposed',
  status: 'PROPOSED_NOT_ACTIVE',
  recordSchemaVersion: 'bo.inventory_movement.record.v0.1-proposed',
  domain: 'inventory_movements',
  ordering: 'occurredAt asc, movementId asc',
  canonicalization: 'bo-canonical-json-v1',
  digestAlgorithm: 'sha256',
  maxRecords: 100_000,
});

export const MOVEMENT_TYPES = ['receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment', 'return', 'write_off', 'cycle_count'] as const;
export const REFERENCE_TYPES = ['purchase_receipt', 'order_line', 'transfer', 'adjustment', 'manual', 'other'] as const;
/** The 14 properties of an evidence record; any other property (notes, performed_by, ...) is refused. */
export const EVIDENCE_RECORD_PROPERTIES = [
  'tenantId', 'workspaceId', 'businessId', 'movementId', 'inventoryItemId', 'warehouseId', 'movementType', 'quantity', 'referenceType', 'referenceId',
  'unitCost', 'unitCostCurrency', 'occurredAt', 'correlationId',
] as const;

/** The BI warehouse contract for inventory movements. Quantities and costs are EXACT decimal text (BI-08 `decimal`), never JSON numbers; the grain is the movement id. */
export const INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT: WarehouseDatasetContract = Object.freeze({
  datasetContractId: 'bi.inventory_movements.from_bo_evidence.v0.1-proposed',
  datasetType: 'fact',
  loadMode: 'append',
  primaryKeyFields: ['movementId'],
  partitionFields: ['movementType'],
  fields: [
    { name: 'tenantId', dataType: 'string', required: true },
    { name: 'workspaceId', dataType: 'string', required: true },
    { name: 'businessId', dataType: 'string', required: true },
    { name: 'movementId', dataType: 'string', required: true },
    { name: 'inventoryItemId', dataType: 'string', required: true },
    { name: 'warehouseId', dataType: 'string', required: true },
    { name: 'movementType', dataType: 'string', required: true, allowedValues: [...MOVEMENT_TYPES] },
    { name: 'quantity', dataType: 'decimal', required: true },
    { name: 'referenceType', dataType: 'string', required: false, allowedValues: [...REFERENCE_TYPES] },
    { name: 'referenceId', dataType: 'string', required: false },
    { name: 'unitCost', dataType: 'decimal', required: false, minimum: '0.0001' },
    { name: 'unitCostCurrency', dataType: 'string', required: false },
    { name: 'occurredAt', dataType: 'datetime', required: true },
    { name: 'correlationId', dataType: 'string', required: true },
  ],
}) as WarehouseDatasetContract;

export interface ConsumedInventoryEvidence {
  contract: { name: string; version: string; status: string };
  recordSchemaVersion: string;
  scope: { tenantId: string; workspaceId: string; businessId: string };
  source: { domain: string; periodStart: string; periodEnd: string; boPublicationPackageId: string | null };
  ordering: string;
  recordCount: number;
  records: Array<Record<string, unknown>>;
  digest: { algorithm: string; canonicalization: string; value: string };
  evidenceId: string;
  provenance: { correlationId: string; owner: string };
}
export interface ConsumedEvidenceExpectation { tenantId: string; workspaceId: string; businessId: string; boPublicationPackageId: string; recordCount?: number }
export type ConsumedEvidenceFailureCode =
  | 'ARTIFACT_SHAPE' | 'CONTRACT_UNSUPPORTED' | 'SCHEMA_UNSUPPORTED' | 'SCOPE_MISMATCH' | 'HEADER_MISMATCH' | 'COUNT_MISMATCH' | 'ORDER_VIOLATION'
  | 'DIGEST_MISMATCH' | 'EVIDENCE_ID_MISMATCH' | 'RECORD_INVALID';
export type ConsumedEvidenceResult = { ok: true; evidence: ConsumedInventoryEvidence } | { ok: false; code: ConsumedEvidenceFailureCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => { const k = Object.keys(o).sort(); const e = [...keys].sort(); return k.length === e.length && k.every((x, i) => x === e[i]); };

/** The digest rule of the contract: SHA-256 of 'bo-evidence-body:' + the canonical JSON of everything except the digest, the evidence id and the provenance. */
export function consumedDigest(e: ConsumedInventoryEvidence): string {
  return sha256('bo-evidence-body:' + canonicalJson({ contract: e.contract, recordSchemaVersion: e.recordSchemaVersion, scope: e.scope, source: e.source, ordering: e.ordering, recordCount: e.recordCount, records: e.records }));
}
export const consumedEvidenceId = (digest: string): string => sha256(`bo-evidence-id:${CONSUMED_EVIDENCE_CONTRACT.name}:${digest}`);

/** Verifies what the BO reader handed over, independently of the BO verifier. Returns a closed code and never a value. */
export function verifyConsumedInventoryEvidence(value: unknown, expected: ConsumedEvidenceExpectation): ConsumedEvidenceResult {
  const fail = (code: ConsumedEvidenceFailureCode): ConsumedEvidenceResult => ({ ok: false, code });
  if (!isObject(value) || !sameKeys(value, ['contract', 'digest', 'evidenceId', 'ordering', 'provenance', 'recordCount', 'recordSchemaVersion', 'records', 'scope', 'source'])) return fail('ARTIFACT_SHAPE');
  const e = value as unknown as ConsumedInventoryEvidence; const C = CONSUMED_EVIDENCE_CONTRACT;
  if (!isObject(e.contract) || e.contract.name !== C.name || e.contract.version !== C.version || e.contract.status !== C.status) return fail('CONTRACT_UNSUPPORTED');
  if (e.recordSchemaVersion !== C.recordSchemaVersion || e.ordering !== C.ordering) return fail('SCHEMA_UNSUPPORTED');
  if (!isObject(e.digest) || e.digest.algorithm !== C.digestAlgorithm || e.digest.canonicalization !== C.canonicalization || typeof e.digest.value !== 'string' || !HEX64.test(e.digest.value) || typeof e.evidenceId !== 'string' || !HEX64.test(e.evidenceId)) return fail('ARTIFACT_SHAPE');
  if (!isObject(e.scope) || !sameKeys(e.scope, ['tenantId', 'workspaceId', 'businessId'])) return fail('ARTIFACT_SHAPE');
  if (e.scope.tenantId !== expected.tenantId || e.scope.workspaceId !== expected.workspaceId || e.scope.businessId !== expected.businessId) return fail('SCOPE_MISMATCH');
  if (!isObject(e.source) || !sameKeys(e.source, ['domain', 'periodStart', 'periodEnd', 'boPublicationPackageId']) || e.source.domain !== C.domain) return fail('ARTIFACT_SHAPE');
  if (e.source.boPublicationPackageId !== expected.boPublicationPackageId) return fail('HEADER_MISMATCH');
  if (!isObject(e.provenance) || e.provenance.owner !== 'business_operations') return fail('ARTIFACT_SHAPE');
  if (!Array.isArray(e.records) || !Number.isSafeInteger(e.recordCount) || e.records.length > C.maxRecords) return fail('ARTIFACT_SHAPE');
  if (e.recordCount !== e.records.length || (expected.recordCount !== undefined && e.recordCount !== expected.recordCount)) return fail('COUNT_MISMATCH');

  let previous: Record<string, unknown> | null = null; const seen = new Set<string>();
  for (const r of e.records) {
    if (!isObject(r) || !sameKeys(r, EVIDENCE_RECORD_PROPERTIES)) return fail('RECORD_INVALID');
    if (r.tenantId !== expected.tenantId || r.workspaceId !== expected.workspaceId || r.businessId !== expected.businessId) return fail('SCOPE_MISMATCH');
    if (typeof r.movementId !== 'string' || !UUID.test(r.movementId) || typeof r.occurredAt !== 'string' || seen.has(r.movementId)) return fail('RECORD_INVALID');
    // the approved rule: a cost and its currency are present exactly together (a cost with an unproven currency is never ingested)
    if ((r.unitCost === null) !== (r.unitCostCurrency === null)) return fail('RECORD_INVALID');
    if (previous && !(String(r.occurredAt) > String(previous.occurredAt) || (r.occurredAt === previous.occurredAt && String(r.movementId) > String(previous.movementId)))) return fail('ORDER_VIOLATION');
    seen.add(r.movementId); previous = r;
  }
  const digest = consumedDigest(e);
  if (digest !== e.digest.value) return fail('DIGEST_MISMATCH');
  if (consumedEvidenceId(digest) !== e.evidenceId) return fail('EVIDENCE_ID_MISMATCH');
  return { ok: true, evidence: e };
}

/** Maps verified evidence records onto BI-07 -> BI-08 transformed records: the movement id is the source identity, the evidence order is the source order. Values are untouched. */
export function toTransformedRecords(e: ConsumedInventoryEvidence): TransformedRecord[] {
  return e.records.map((record, i) => ({ sourceRecordId: record.movementId as string, sourceIndex: i, fields: { ...record } }));
}
