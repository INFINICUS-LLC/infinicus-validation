/**
 * BI-08 warehouse load PREPARATION (BI-08-DEV-01): the verified, deterministic step between "Business Operations published a package" and "rows may be stored".
 *
 * What it does: resolves the dataset version a load would fill (read-only), verifies the chain back to the BO publication package (publication state, target layer,
 * intake status, declared record count agreement between BO, BI intake and the records offered, a single source reference, nothing stored yet), validates the offered
 * transformed records against the dataset contract and maps them to the exact `AppendRowsInput` batches `BiWarehouseRowRepository.appendRows` accepts.
 *
 * What it does NOT do, by design: it writes nothing. It never calls appendRows or seal, has no route, and reads no BO operational table. The warehouse write boundary
 * stays DISABLED: no record-level BO publication contract exists (BO publishes a package header, a count and a scalar payload reference), so there is no authoritative
 * source of records to ingest from. Records offered to this service are an internal in-process representation, checked and never trusted; a later, separately
 * authorised block decides where real records come from and enables the write.
 */
import { createHash } from 'node:crypto';
import { BiWarehouseLoadTargetReadRepository, WAREHOUSE_APPEND_BATCH_MAX, type AppendRowsInput, type TenantContext, type WarehouseLoadTarget } from '@infinicus/database';
import { prepareWarehouseRows, WAREHOUSE_LOAD_LIMITS, type LoadIssue, type LoadPreparationCode, type TransformedRecord, type WarehouseDatasetContract } from './bi08/warehouseLoad.js';

export type WarehouseLoadRefusalCode =
  | LoadPreparationCode
  | 'TARGET_NOT_PUBLISHED' | 'INTAKE_NOT_PROCESSED' | 'SOURCE_NOT_FOR_BI' | 'SOURCE_NOT_PUBLISHED' | 'SOURCE_REFERENCE_AMBIGUOUS'
  | 'TARGET_ALREADY_SEALED' | 'TARGET_HAS_ROWS' | 'DECLARED_COUNT_CONFLICT' | 'RECORD_COUNT_MISMATCH';

export interface PreparedWarehouseLoad {
  /** Deterministic: names the target version, its BO package, the contract and the exact rows. The same inputs always give the same id. */
  preparedLoadId: string;
  datasetId: string;
  datasetVersionId: string;
  intakePackageId: string;
  boPublicationPackageId: string;
  sourceReferenceId: string;
  contractHash: string;
  declaredRecordCount: number;
  recordCount: number;
  rowsFingerprint: string;
  partitions: Array<{ partitionKey: string; recordCount: number }>;
  /** Exactly what BiWarehouseRowRepository.appendRows accepts, in row order, split at the repository's batch bound. Nothing has been written. */
  appendBatches: AppendRowsInput[];
}
export type WarehouseLoadPreparationResult =
  | { ok: true; load: PreparedWarehouseLoad }
  | { ok: false; code: WarehouseLoadRefusalCode; issueCount: number; issues: LoadIssue[] };

export interface WarehouseLoadPreparationRequest {
  datasetVersionId: string;
  contract: WarehouseDatasetContract;
  records: readonly TransformedRecord[];
}

const refuse = (code: WarehouseLoadRefusalCode, issues: LoadIssue[] = [], issueCount = issues.length): WarehouseLoadPreparationResult => ({ ok: false, code, issueCount, issues });
/** BO package states from which BI may take what was published (the BO -> BI contract's intake-able states, and the acknowledgement that follows a dispatch). */
const PUBLISHED_STATES = ['ready', 'dispatched', 'received'];

export class BusinessIntelligenceWarehouseLoadPreparationService {
  constructor(private readonly targets: BiWarehouseLoadTargetReadRepository = new BiWarehouseLoadTargetReadRepository()) {}

  /** NotFoundError (from the repository) when the version is not in the caller's business. Every other refusal is a result, never an exception, and never carries a value. */
  async prepare(ctx: TenantContext, businessId: string, request: WarehouseLoadPreparationRequest): Promise<WarehouseLoadPreparationResult> {
    const target = await this.targets.resolve(ctx, businessId, request.datasetVersionId);
    const unfit = verifyTarget(target);
    if (unfit) return refuse(unfit);

    // The count BO declared, the count BI recorded at intake and the records offered must all agree; a seal would refuse anything else later, so refuse it now.
    const offered = Array.isArray(request.records) ? request.records.length : 0;
    if (Array.isArray(request.records) && offered > WAREHOUSE_LOAD_LIMITS.maxRecords) return refuse('TOO_MANY_RECORDS');
    if (Array.isArray(request.records) && offered > 0 && offered !== target.declaredRecordCount) return refuse('RECORD_COUNT_MISMATCH');

    const result = prepareWarehouseRows(request.contract, request.records);
    if (!result.ok) return refuse(result.code, result.issues, result.issueCount);
    const { prepared } = result;
    if (prepared.recordCount !== target.declaredRecordCount) return refuse('RECORD_COUNT_MISMATCH');

    const sourceReferenceId = target.sourceReferenceIds[0]!;
    const appendBatches: AppendRowsInput[] = [];
    for (let at = 0; at < prepared.rows.length; at += WAREHOUSE_APPEND_BATCH_MAX) {
      appendBatches.push({ datasetVersionId: target.datasetVersionId, sourceReferenceId, rows: prepared.rows.slice(at, at + WAREHOUSE_APPEND_BATCH_MAX) });
    }
    const preparedLoadId = createHash('sha256').update(['bi08-load', target.datasetVersionId, sourceReferenceId, target.boPublicationPackageId, prepared.contractHash, prepared.rowsFingerprint].join('|'), 'utf8').digest('hex');
    return {
      ok: true,
      load: {
        preparedLoadId, datasetId: target.datasetId, datasetVersionId: target.datasetVersionId, intakePackageId: target.intakePackageId,
        boPublicationPackageId: target.boPublicationPackageId, sourceReferenceId, contractHash: prepared.contractHash, declaredRecordCount: target.declaredRecordCount,
        recordCount: prepared.recordCount, rowsFingerprint: prepared.rowsFingerprint, partitions: prepared.partitions, appendBatches,
      },
    };
  }
}

function verifyTarget(t: WarehouseLoadTarget): WarehouseLoadRefusalCode | null {
  if (t.publicationStatus !== 'published') return 'TARGET_NOT_PUBLISHED';
  if (t.intakeStatus !== 'processed') return 'INTAKE_NOT_PROCESSED';
  if (t.boPackage.targetLayer !== 'business_intelligence') return 'SOURCE_NOT_FOR_BI';
  if (!PUBLISHED_STATES.includes(t.boPackage.packageStatus)) return 'SOURCE_NOT_PUBLISHED';
  if (t.sourceReferenceIds.length !== 1) return 'SOURCE_REFERENCE_AMBIGUOUS';
  if (t.seal !== null) return 'TARGET_ALREADY_SEALED';
  if (t.heldRowCount > 0) return 'TARGET_HAS_ROWS';
  if (t.boPackage.recordCount !== t.declaredRecordCount) return 'DECLARED_COUNT_CONFLICT';
  return null;
}
