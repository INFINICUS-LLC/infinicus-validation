import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

export interface DTHandoffEnvelopeRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  dtPublicationPackageId: string;
  snapshotVersionId: string;
  confidenceScoreId: string;
  contractVersion: string;
  schemaVersion: string;
  correlationId: string;
  causationId: string;
  /** The complete DT -> SIM hand-off envelope exactly as validated and recorded. */
  envelope: unknown;
  envelopeDigest: string;
  sourceEvidenceDigest: string;
  sourceRevalidatedAt: Date;
  createdAt: Date;
}

export interface RecordHandoffEnvelopeInput {
  businessId: string;
  dtPublicationPackageId: string;
  snapshotVersionId: string;
  confidenceScoreId: string;
  contractVersion: string;
  schemaVersion: string;
  correlationId: string;
  causationId: string;
  envelope: unknown;
  envelopeDigest: string;
  sourceEvidenceDigest: string;
  sourceRevalidatedAt: Date;
}

function rowToRecord(row: Record<string, unknown>): DTHandoffEnvelopeRecord {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    dtPublicationPackageId: row.dt_publication_package_id as string, snapshotVersionId: row.snapshot_version_id as string, confidenceScoreId: row.confidence_score_id as string,
    contractVersion: row.contract_version as string, schemaVersion: row.schema_version as string, correlationId: row.correlation_id as string, causationId: row.causation_id as string,
    envelope: row.envelope, envelopeDigest: row.envelope_digest as string, sourceEvidenceDigest: row.source_evidence_digest as string,
    sourceRevalidatedAt: row.source_revalidated_at as Date, createdAt: row.created_at as Date,
  };
}

/**
 * The durable, append-only record of a DT -> SIM hand-off envelope (`dt_handoff_envelopes`, migration 0221). It is written while the publication package is still
 * a draft - the database refuses it otherwise, and refuses to ready or dispatch a performance hand-off package without it - and it is never updated or deleted.
 */
export class DTHandoffEnvelopeRepository {
  async record(ctx: TenantContext, input: RecordHandoffEnvelopeInput): Promise<DTHandoffEnvelopeRecord> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_digital_twin.dt_handoff_envelopes
           (tenant_id, workspace_id, business_id, dt_publication_package_id, snapshot_version_id, confidence_score_id, contract_version, schema_version,
            correlation_id, causation_id, envelope, envelope_digest, source_evidence_digest, source_revalidated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.dtPublicationPackageId, input.snapshotVersionId, input.confidenceScoreId, input.contractVersion, input.schemaVersion,
         input.correlationId, input.causationId, JSON.stringify(input.envelope), input.envelopeDigest, input.sourceEvidenceDigest, input.sourceRevalidatedAt]
      );
      return rowToRecord(result.rows[0]);
    });
  }

  async getByPackage(ctx: TenantContext, businessId: string, dtPublicationPackageId: string): Promise<DTHandoffEnvelopeRecord | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_digital_twin.dt_handoff_envelopes WHERE business_id = $1 AND dt_publication_package_id = $2', [businessId, dtPublicationPackageId]
      );
      return result.rows.length === 0 ? null : rowToRecord(result.rows[0]);
    });
  }
}
