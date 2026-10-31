/**
 * BI-owned warehouse row storage (BI-2-DEV-07, migration 0223). Rows belong to a PUBLISHED analytical dataset version and are recorded only through this
 * repository, which is meant for the BI ingestion pathway (BI-08): it has no route and no caller outside BI. Every row cites a source reference of the intake
 * package its version was built from (the database enforces it), is fingerprinted by the database, and is append-only. A version is then SEALED: the database
 * computes the row count, checks it against the record count Business Operations declared, checks the row numbers run 1..n, and stores a digest of the row
 * fingerprints. After the seal nothing can be added, and a calculation reads only sealed rows, re-checking the seal on every read (fail closed).
 *
 * Nothing here reads or writes Business Operations data, and nothing is invented: when the platform holds no sealed rows for a dataset, the read says so.
 * Decimal values should be stored as strings (JSON numbers are doubles once they leave PostgreSQL); the calculation reads both exactly as text.
 */
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { canonicalUuid, inBusinessScope, isPlainJson, pgCode } from './businessScope.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/** Engineering bound on one append call (the statement carries the rows as one JSON document). Larger sets are appended in several calls; never truncated. */
export const WAREHOUSE_APPEND_BATCH_MAX = 10_000;

export interface WarehouseRowInput { rowNumber: number; data: Record<string, unknown> }
export interface AppendRowsInput { datasetVersionId: string; sourceReferenceId: string; rows: readonly WarehouseRowInput[] }
export interface AppendRowsResult { inserted: number; replayed: number }
export interface SealResult { datasetVersionId: string; rowCount: number; rowsDigest: string; replayed: boolean }
export interface SealedDatasetRows {
  datasetId: string;
  datasetVersionId: string;
  versionNumber: number;
  /** Row count and digest as sealed by the database. */
  rowCount: number;
  rowsDigest: string;
  /** True when more rows are sealed than were returned (the caller asked for at most `maxRows`). The caller decides; nothing is silently dropped. */
  truncated: boolean;
  rows: Record<string, unknown>[];
}

const FINGERPRINT_SQL = "encode(sha256(convert_to(x.row_data::text, 'UTF8')), 'hex')";
const DIGEST_FROM_ROWS = "encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(row_data::text, 'UTF8')), 'hex'), ',' ORDER BY row_number), ''), 'UTF8')), 'hex')";

function integrityRefusal(entity: string, error: unknown): never {
  const code = pgCode(error);
  if (code === '23514') throw new ValidationError(entity, ['the data violates the dataset integrity rules']);
  if (code === '23503') throw new NotFoundError(entity, 'a referenced record');
  throw error;
}

export class BiWarehouseRowRepository {
  /** Records rows of a published, unsealed dataset version. Idempotent: a row already recorded with identical content is a replay; different content is a ConflictError. */
  async appendRows(ctx: TenantContext, businessId: string, input: AppendRowsInput): Promise<AppendRowsResult> {
    const versionId = canonicalUuid(input.datasetVersionId); const sourceId = canonicalUuid(input.sourceReferenceId);
    if (versionId === null) throw new ValidationError('WarehouseRows', ['datasetVersionId must be a UUID']);
    if (sourceId === null) throw new ValidationError('WarehouseRows', ['sourceReferenceId must be a UUID']);
    const rows = input.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > WAREHOUSE_APPEND_BATCH_MAX) throw new ValidationError('WarehouseRows', ['rows must hold 1 to ' + WAREHOUSE_APPEND_BATCH_MAX + ' rows per call']);
    const seen = new Set<number>();
    for (const r of rows) {
      if (!r || !Number.isInteger(r.rowNumber) || r.rowNumber < 1 || seen.has(r.rowNumber)) throw new ValidationError('WarehouseRows', ['rowNumber must be a unique integer from 1']);
      seen.add(r.rowNumber);
      if (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data) || !isPlainJson(r.data)) throw new ValidationError('WarehouseRows', ['every row must be a plain JSON object']);
    }
    const document = JSON.stringify(rows.map((r) => ({ row_number: r.rowNumber, row_data: r.data })));

    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const version = await client.query<{ dataset_id: string }>(
        `SELECT dataset_id FROM business_intelligence.analytical_dataset_versions WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (version.rowCount !== 1) throw new NotFoundError('DatasetVersion', input.datasetVersionId);
      const source = await client.query(
        `SELECT 1 FROM business_intelligence.intelligence_source_references WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [sourceId, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (source.rowCount !== 1) throw new NotFoundError('SourceReference', input.sourceReferenceId);
      const sealed = await client.query(
        `SELECT 1 FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);

      let inserted = 0;
      if (sealed.rowCount === 0) {
        try {
          const done = await client.query(
            `INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
             SELECT $1, $2, $3, $4, $5, x.row_number, x.row_data, $6
               FROM jsonb_to_recordset($7::jsonb) AS x(row_number integer, row_data jsonb) ORDER BY x.row_number
             ON CONFLICT (dataset_version_id, row_number) DO NOTHING RETURNING row_number`,
            [scope.tenantId, scope.workspaceId, scope.businessId, version.rows[0]!.dataset_id, versionId, sourceId, document]);
          inserted = done.rowCount ?? 0;
        } catch (error) { integrityRefusal('WarehouseRows', error); }
      }
      // Every row of the call that was not inserted must already be recorded with IDENTICAL content (a replay); anything else is a conflict.
      const identical = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM jsonb_to_recordset($5::jsonb) AS x(row_number integer, row_data jsonb)
           JOIN business_intelligence.warehouse_dataset_rows r ON r.dataset_version_id = $1 AND r.row_number = x.row_number
            AND r.tenant_id = $2 AND r.workspace_id = $3 AND r.business_id = $4 AND r.row_fingerprint = ${FINGERPRINT_SQL}`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId, document]);
      if (Number(identical.rows[0]!.n) !== rows.length) {
        throw new ConflictError('WarehouseRows', sealed.rowCount === 1 ? 'the dataset version is sealed and these rows are not exactly the sealed rows' : 'a row is already recorded with different content');
      }
      return { inserted, replayed: rows.length - inserted };
    });
  }

  /** Seals a published dataset version: the database computes and checks the seal. Idempotent. */
  async sealVersion(ctx: TenantContext, businessId: string, datasetVersionId: string): Promise<SealResult> {
    const versionId = canonicalUuid(datasetVersionId);
    if (versionId === null) throw new ValidationError('WarehouseSeal', ['datasetVersionId must be a UUID']);
    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const version = await client.query<{ dataset_id: string; publication_status: string }>(
        `SELECT dataset_id, publication_status FROM business_intelligence.analytical_dataset_versions WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (version.rowCount !== 1) throw new NotFoundError('DatasetVersion', datasetVersionId);
      if (version.rows[0]!.publication_status !== 'published') throw new ValidationError('WarehouseSeal', ['only a published dataset version can be sealed']);
      const existing = await client.query<{ row_count: number; rows_digest: string }>(
        `SELECT row_count, rows_digest FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (existing.rowCount === 1) return { datasetVersionId: versionId, rowCount: existing.rows[0]!.row_count, rowsDigest: existing.rows[0]!.rows_digest, replayed: true };

      const declared = await client.query<{ record_count: number }>(
        `SELECT record_count FROM business_intelligence.dataset_data_references WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4
          ORDER BY created_at, id LIMIT 1`, [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (declared.rowCount !== 1) throw new ValidationError('WarehouseSeal', ['the dataset version declares no record count to seal against']);
      const held = await client.query<{ n: string; mn: number | null; mx: number | null }>(
        `SELECT count(*) AS n, min(row_number) AS mn, max(row_number) AS mx FROM business_intelligence.warehouse_dataset_rows
          WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`, [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      const n = Number(held.rows[0]!.n);
      if (n !== declared.rows[0]!.record_count) throw new ValidationError('WarehouseSeal', ['the dataset version holds ' + n + ' rows but ' + declared.rows[0]!.record_count + ' were declared']);
      if (n > 0 && (held.rows[0]!.mn !== 1 || held.rows[0]!.mx !== n)) throw new ValidationError('WarehouseSeal', ['row numbers must run from 1 to the row count without gaps']);
      try {
        // The placeholder values are replaced by the database (trigger); the caller never supplies a count or a digest.
        const sealed = await client.query<{ row_count: number; rows_digest: string }>(
          `INSERT INTO business_intelligence.warehouse_dataset_version_seals (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_count, declared_record_count, rows_digest)
           VALUES ($1, $2, $3, $4, $5, 0, 0, repeat('0', 64)) ON CONFLICT (dataset_version_id) DO NOTHING RETURNING row_count, rows_digest`,
          [scope.tenantId, scope.workspaceId, scope.businessId, version.rows[0]!.dataset_id, versionId]);
        if (sealed.rowCount === 1) return { datasetVersionId: versionId, rowCount: sealed.rows[0]!.row_count, rowsDigest: sealed.rows[0]!.rows_digest, replayed: false };
      } catch (error) { integrityRefusal('WarehouseSeal', error); }
      const raced = await client.query<{ row_count: number; rows_digest: string }>(
        `SELECT row_count, rows_digest FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
      return { datasetVersionId: versionId, rowCount: raced.rows[0]!.row_count, rowsDigest: raced.rows[0]!.rows_digest, replayed: true };
    });
  }

  /** The sealed rows of a dataset's LATEST published version. NotFoundError when there is no such dataset or version; ConflictError when the version is not sealed or fails its seal. */
  async readLatestSealed(ctx: TenantContext, businessId: string, datasetId: string, maxRows: number): Promise<SealedDatasetRows> {
    const id = canonicalUuid(datasetId);
    if (id === null) throw new NotFoundError('Dataset', datasetId);
    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const version = await client.query<{ id: string }>(
        `SELECT v.id FROM business_intelligence.analytical_dataset_versions v
           JOIN business_intelligence.analytical_datasets d ON d.id = v.dataset_id AND d.tenant_id = v.tenant_id AND d.workspace_id = v.workspace_id AND d.business_id = v.business_id
          WHERE d.id = $1 AND d.tenant_id = $2 AND d.workspace_id = $3 AND d.business_id = $4 AND v.version_number = d.latest_version AND v.publication_status = 'published'`,
        [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (version.rowCount !== 1) throw new NotFoundError('PublishedDatasetVersion', datasetId);
      return this.readSealedWithin(client, scope, version.rows[0]!.id, maxRows);
    });
  }

  /** The sealed rows of one specific dataset version (used to re-verify what a run read). */
  async readSealedVersion(ctx: TenantContext, businessId: string, datasetVersionId: string, maxRows: number): Promise<SealedDatasetRows> {
    const id = canonicalUuid(datasetVersionId);
    if (id === null) throw new NotFoundError('DatasetVersion', datasetVersionId);
    return inBusinessScope(ctx, businessId, (client, scope) => this.readSealedWithin(client, scope, id, maxRows));
  }

  private async readSealedWithin(
    client: PoolClient, scope: { tenantId: string; workspaceId: string; businessId: string }, versionId: string, maxRows: number,
  ): Promise<SealedDatasetRows> {
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new ValidationError('SealedRows', ['maxRows must be a positive integer']);
    const version = await client.query<{ dataset_id: string; version_number: number; publication_status: string }>(
      `SELECT dataset_id, version_number, publication_status FROM business_intelligence.analytical_dataset_versions WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
      [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
    if (version.rowCount !== 1 || version.rows[0]!.publication_status !== 'published') throw new NotFoundError('PublishedDatasetVersion', versionId);
    const seal = await client.query<{ row_count: number; rows_digest: string }>(
      `SELECT row_count, rows_digest FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
      [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
    if (seal.rowCount !== 1) throw new ConflictError('WarehouseDataset', 'the published dataset version has no sealed rows');
    // The seal is re-checked against the stored rows on every read: a count or digest that no longer matches is refused, never returned.
    const actual = await client.query<{ n: string; digest: string }>(
      `SELECT count(*) AS n, ${DIGEST_FROM_ROWS} AS digest FROM business_intelligence.warehouse_dataset_rows
        WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`, [versionId, scope.tenantId, scope.workspaceId, scope.businessId]);
    if (Number(actual.rows[0]!.n) !== seal.rows[0]!.row_count || actual.rows[0]!.digest !== seal.rows[0]!.rows_digest) {
      throw new ConflictError('WarehouseDataset', 'the stored rows no longer match their seal');
    }
    const rows = await client.query<{ row_data: Record<string, unknown> }>(
      `SELECT row_data FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4
        ORDER BY row_number LIMIT $5`, [versionId, scope.tenantId, scope.workspaceId, scope.businessId, maxRows]);
    return {
      datasetId: version.rows[0]!.dataset_id, datasetVersionId: versionId, versionNumber: version.rows[0]!.version_number, rowCount: seal.rows[0]!.row_count,
      rowsDigest: seal.rows[0]!.rows_digest, truncated: seal.rows[0]!.row_count > rows.rowCount!, rows: rows.rows.map((r) => r.row_data),
    };
  }
}
