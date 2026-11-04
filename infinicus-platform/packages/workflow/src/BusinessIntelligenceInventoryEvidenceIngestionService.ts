/**
 * BI-08-DEV-02: the first authentic BO -> BI record-level pathway. VERIFIED INVENTORY MOVEMENT EVIDENCE INGESTION, WAREHOUSE INSERTION AND DATASET SEALING.
 *
 *   BO-published evidence (read-only port) -> independent consumer verification -> BI-08 validation and mapping (exact decimals) -> append to the BI warehouse -> seal -> BI-10.
 *
 * What it accepts: only the name of a dataset version and of the BO publication header whose evidence should fill it. NO rows, NO values and NO evidence travel in the request
 * (the evidence is fetched through `InventoryMovementEvidenceSource`, which in production is the BO reader; this package imports nothing from Business Operations and never reads a
 * BO table: the only BO fact it sees is the publication header already resolved by the BI-08-DEV-01 target repository). The service has NO route: whoever exposes it later owns the
 * authority question (the BO side stays fail-closed, so no evidence exists to ingest until publication is activated).
 *
 * Idempotent and resumable by construction: the row repository replays identical rows and conflicts on different ones, and sealing is idempotent, so running it again (after a crash
 * between batches, or after the seal) completes or confirms the same result and can never overwrite anything. Fail closed at every step; results are closed codes with no value,
 * SQL, schema or identifier text. Sealing is the database's: the caller supplies neither a count nor a digest, and the seal must equal the record count BO declared.
 */
import {
  BiConflictError, BiValidationError, BiWarehouseRowRepository, type TenantContext,
} from '@infinicus/database';
import {
  INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, toTransformedRecords, verifyConsumedInventoryEvidence, type ConsumedEvidenceFailureCode,
} from './bi08/inventoryEvidenceConsumer.js';
import { BusinessIntelligenceWarehouseLoadPreparationService, type WarehouseLoadRefusalCode } from './BusinessIntelligenceWarehouseLoadPreparationService.js';

/** The only way this service sees BO evidence: a read-only, scope-controlled reader of VERIFIED, published evidence (BO's `PublishedInventoryMovementEvidenceReader` fits it). */
export interface InventoryMovementEvidenceSource {
  read(ctx: TenantContext, businessId: string, boPublicationPackageId: string): Promise<{ ok: true; evidence: unknown } | { ok: false; code: string }>;
}

export type IngestionFailureCode =
  | 'EVIDENCE_NOT_FOUND' | 'EVIDENCE_INTEGRITY' | 'EVIDENCE_REJECTED' | 'HEADER_MISMATCH' | 'RECORD_COUNT_MISMATCH'
  | 'LOAD_REFUSED' | 'INGESTION_CONFLICT' | 'SEAL_REFUSED';
export type IngestionResult =
  | { ok: true; datasetVersionId: string; boPublicationPackageId: string; evidenceId: string; evidenceDigest: string; preparedLoadId: string; recordCount: number;
      inserted: number; replayedRows: number; sealed: { rowCount: number; rowsDigest: string; replayed: boolean } }
  | { ok: false; code: IngestionFailureCode; detail?: ConsumedEvidenceFailureCode | WarehouseLoadRefusalCode };

export interface IngestInventoryEvidenceRequest {
  /** The BI dataset version to fill (a version materialized from the BO publication package's intake). */
  datasetVersionId: string;
  /** The BO publication header whose evidence is ingested; it must be the header the dataset version was built from. */
  boPublicationPackageId: string;
}

const refuse = (code: IngestionFailureCode, detail?: ConsumedEvidenceFailureCode | WarehouseLoadRefusalCode): IngestionResult => (detail === undefined ? { ok: false, code } : { ok: false, code, detail });

export class BusinessIntelligenceInventoryEvidenceIngestionService {
  constructor(
    private readonly evidence: InventoryMovementEvidenceSource,
    private readonly preparation: BusinessIntelligenceWarehouseLoadPreparationService = new BusinessIntelligenceWarehouseLoadPreparationService(),
    private readonly warehouse: BiWarehouseRowRepository = new BiWarehouseRowRepository(),
  ) {}

  /** NotFoundError (uniform, from the target resolution) when the dataset version is not in the caller's business. Every other refusal is a result. */
  async ingest(ctx: TenantContext, businessId: string, request: IngestInventoryEvidenceRequest): Promise<IngestionResult> {
    const header = typeof request?.boPublicationPackageId === 'string' ? request.boPublicationPackageId.toLowerCase() : '';
    // 1. Read the evidence through the BO port. Nothing the caller sent is a value.
    const read = await this.evidence.read(ctx, businessId, header);
    if (!read.ok) return refuse(read.code === 'EVIDENCE_NOT_FOUND' ? 'EVIDENCE_NOT_FOUND' : 'EVIDENCE_INTEGRITY');

    // 2. Do not trust the port: re-verify identity, scope, header binding, order, digest and id independently.
    const verified = verifyConsumedInventoryEvidence(read.evidence, { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: businessId.toLowerCase(), boPublicationPackageId: header });
    if (!verified.ok) return refuse(verified.code === 'HEADER_MISMATCH' ? 'HEADER_MISMATCH' : 'EVIDENCE_REJECTED', verified.code);
    const e = verified.evidence;

    // 3. BI-08 validation and mapping against the verified chain (dataset version -> intake -> BO header -> declared count), writing nothing. `allow`: resume or replay.
    const prepared = await this.preparation.prepare(ctx, businessId, {
      datasetVersionId: request.datasetVersionId, contract: INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, records: toTransformedRecords(e), existing: 'allow',
    });
    if (!prepared.ok) return refuse(prepared.code === 'RECORD_COUNT_MISMATCH' ? 'RECORD_COUNT_MISMATCH' : 'LOAD_REFUSED', prepared.code);
    const load = prepared.load;
    // the dataset version must have been built from the header whose evidence this is
    if (load.boPublicationPackageId.toLowerCase() !== header) return refuse('HEADER_MISMATCH');

    // 4. Append the batches (idempotent), then seal (idempotent; the database computes and checks it).
    let inserted = 0; let replayedRows = 0;
    try {
      for (const batch of load.appendBatches) {
        const r = await this.warehouse.appendRows(ctx, businessId, batch);
        inserted += r.inserted; replayedRows += r.replayed;
      }
    } catch (error) {
      if (error instanceof BiConflictError) return refuse('INGESTION_CONFLICT');
      if (error instanceof BiValidationError) return refuse('LOAD_REFUSED');
      throw error;
    }
    try {
      const seal = await this.warehouse.sealVersion(ctx, businessId, load.datasetVersionId);
      return {
        ok: true, datasetVersionId: load.datasetVersionId, boPublicationPackageId: load.boPublicationPackageId, evidenceId: e.evidenceId, evidenceDigest: e.digest.value,
        preparedLoadId: load.preparedLoadId, recordCount: load.recordCount, inserted, replayedRows, sealed: { rowCount: seal.rowCount, rowsDigest: seal.rowsDigest, replayed: seal.replayed },
      };
    } catch (error) {
      if (error instanceof BiValidationError || error instanceof BiConflictError) return refuse('SEAL_REFUSED');
      throw error;
    }
  }
}
