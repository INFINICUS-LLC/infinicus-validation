/**
 * BO-PUB-DEV-02: durable storage of Business Operations record-publication evidence (migration 0224). BO-owned and append-only.
 *
 * The repository stores and returns what the caller hands it; it does not decide what the evidence MEANS (the record schema, the digest rules and the complete
 * verifier live in the Business Operations runtime, which depends on this package). What it guarantees is the database side: one transaction per artifact, a scoped
 * business, an advisory lock per publication header so concurrent publishers serialise, a deterministic replay (the same digest again stores nothing), a conflict for
 * any other artifact under the same header, and sanitized outcomes (a database refusal is reported as REFUSED, never as SQL, schema or constraint text). The database
 * itself refuses an artifact that is not bound to the authoritative header or whose records differ from the canonical body, and makes a stored artifact immutable.
 *
 * Reads are SELECT-only and pinned to tenant, workspace and business; another party's artifact is indistinguishable from a missing one. Nothing here touches an
 * operational ledger table, a header's state, or any Business Intelligence table.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonicalUuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v.toLowerCase()) ? v.toLowerCase() : null);
const pgCode = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);

/** Engineering bound: the BI-10 engine reads at most this many rows per dataset, and the evidence contract refuses more. */
export const PUBLICATION_EVIDENCE_MAX_RECORDS = 100_000;

export interface PublicationEvidenceRecordInput { position: number; movementId: string; record: Record<string, unknown> }
export interface AppendPublicationEvidenceInput {
  publicationPackageId: string;
  contractName: string; contractVersion: string; contractStatus: string; recordSchemaVersion: string; domain: string;
  /** UTC instants at millisecond precision, as the artifact states them. */
  periodStart: string; periodEnd: string;
  ordering: string; canonicalization: string; digestAlgorithm: string;
  recordCount: number;
  digest: string; evidenceId: string;
  /** The exact canonical text that was hashed. */
  canonicalBody: string;
  correlationId: string;
  records: readonly PublicationEvidenceRecordInput[];
}
export type AppendPublicationEvidenceOutcome =
  | { outcome: 'STORED'; evidenceRowId: string }
  | { outcome: 'REPLAYED'; evidenceRowId: string }
  /** A different artifact is already published for this header (evidence is immutable and one per header). */
  | { outcome: 'CONFLICT' }
  /** The database refused the artifact (not bound to the header, wrong state, count or period disagreement, records differ from the body, malformed). No detail is returned. */
  | { outcome: 'REFUSED' }
  | { outcome: 'UNKNOWN_BUSINESS' };

export interface StoredPublicationEvidence {
  id: string; tenantId: string; workspaceId: string; businessId: string; publicationPackageId: string;
  contractName: string; contractVersion: string; contractStatus: string; recordSchemaVersion: string; domain: string;
  periodStart: string; periodEnd: string; ordering: string; canonicalization: string; digestAlgorithm: string;
  declaredRecordCount: number; recordCount: number; digest: string; evidenceId: string; canonicalBody: string; correlationId: string; createdAt: Date;
  records: Array<{ position: number; movementId: string; record: Record<string, unknown> }>;
}

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const EVIDENCE_COLUMNS = `e.id, e.tenant_id, e.workspace_id, e.business_id, e.publication_package_id, e.contract_name, e.contract_version, e.contract_status, e.record_schema_version, e.domain,
       to_char(e.period_start AT TIME ZONE 'UTC', ${MS}) AS period_start, to_char(e.period_end AT TIME ZONE 'UTC', ${MS}) AS period_end,
       e.ordering, e.canonicalization, e.digest_algorithm, e.declared_record_count, e.record_count, e.digest, e.evidence_id, e.canonical_body, e.correlation_id, e.created_at`;

export class BoPublicationEvidenceRepository {
  /** Atomically stores one evidence artifact and its ordered records for a publication header. Idempotent on the digest. */
  async append(ctx: TenantContext, businessId: string, input: AppendPublicationEvidenceInput): Promise<AppendPublicationEvidenceOutcome> {
    const business = canonicalUuid(businessId); const header = canonicalUuid(input?.publicationPackageId); const correlation = canonicalUuid(input?.correlationId);
    if (business === null) return { outcome: 'UNKNOWN_BUSINESS' };
    if (header === null || correlation === null || !Array.isArray(input.records) || input.records.length > PUBLICATION_EVIDENCE_MAX_RECORDS || input.records.length !== input.recordCount) return { outcome: 'REFUSED' };
    const recordsDocument = JSON.stringify(input.records.map((r) => ({ position: r.position, movement_id: r.movementId, record: r.record })));

    return withTenantTransaction(ctx, async (client): Promise<AppendPublicationEvidenceOutcome> => {
      const exists = await client.query('SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL', [business, ctx.tenantId, ctx.workspaceId]);
      if (exists.rowCount !== 1) return { outcome: 'UNKNOWN_BUSINESS' };
      // Serialise publishers of the same header: the second one sees the committed artifact and replays or conflicts.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bo_publication_evidence:${business}:${header}`]);
      const existing = await client.query<{ id: string; digest: string }>(
        `SELECT id, digest FROM business_operations.bo_publication_evidence WHERE publication_package_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [header, ctx.tenantId, ctx.workspaceId, business]);
      if (existing.rowCount === 1) return existing.rows[0]!.digest === input.digest ? { outcome: 'REPLAYED', evidenceRowId: existing.rows[0]!.id } : { outcome: 'CONFLICT' };

      // A failed statement aborts the transaction; the savepoint lets a refusal be reported as an outcome and rolled back cleanly.
      await client.query('SAVEPOINT evidence_insert');
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO business_operations.bo_publication_evidence
             (tenant_id, workspace_id, business_id, publication_package_id, contract_name, contract_version, contract_status, record_schema_version, domain, period_start, period_end,
              ordering, canonicalization, digest_algorithm, declared_record_count, record_count, digest, evidence_id, canonical_body, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$15,$16,$17,$18,$19) RETURNING id`,
          [ctx.tenantId, ctx.workspaceId, business, header, input.contractName, input.contractVersion, input.contractStatus, input.recordSchemaVersion, input.domain, input.periodStart, input.periodEnd,
            input.ordering, input.canonicalization, input.digestAlgorithm, input.recordCount, input.digest, input.evidenceId, input.canonicalBody, correlation]);
        const evidenceRowId = inserted.rows[0]!.id;
        await client.query(
          `INSERT INTO business_operations.bo_publication_evidence_records (tenant_id, workspace_id, business_id, evidence_row_id, position, movement_id, record)
           SELECT $1, $2, $3, $4, x.position, x.movement_id, x.record FROM jsonb_to_recordset($5::jsonb) AS x(position integer, movement_id uuid, record jsonb)`,
          [ctx.tenantId, ctx.workspaceId, business, evidenceRowId, recordsDocument]);
        // The deferred completeness check runs at commit; forcing it now reports a refusal as an outcome instead of failing the commit.
        await client.query('SET CONSTRAINTS business_operations.check_bo_publication_evidence_complete IMMEDIATE');
        await client.query('RELEASE SAVEPOINT evidence_insert');
        return { outcome: 'STORED', evidenceRowId };
      } catch (error) {
        const code = pgCode(error);
        if (code !== undefined && (code.startsWith('23') || code.startsWith('22'))) {
          await client.query('ROLLBACK TO SAVEPOINT evidence_insert');
          return { outcome: code === '23505' ? 'CONFLICT' : 'REFUSED' };
        }
        throw error;
      }
    });
  }

  /** The stored evidence of a publication header with its ordered records, or null. Read-only and scope-pinned. */
  async getByHeader(ctx: TenantContext, businessId: string, publicationPackageId: string): Promise<StoredPublicationEvidence | null> {
    const business = canonicalUuid(businessId); const header = canonicalUuid(publicationPackageId);
    if (business === null || header === null) return null;
    return withTenantTransaction(ctx, async (client) => {
      const meta = await client.query<Record<string, unknown>>(
        `SELECT ${EVIDENCE_COLUMNS} FROM business_operations.bo_publication_evidence e
          WHERE e.publication_package_id = $1 AND e.tenant_id = $2 AND e.workspace_id = $3 AND e.business_id = $4`, [header, ctx.tenantId, ctx.workspaceId, business]);
      if (meta.rowCount !== 1) return null;
      const m = meta.rows[0]!;
      const rows = await client.query<{ position: number; movement_id: string; record: Record<string, unknown> }>(
        `SELECT r.position, r.movement_id, r.record FROM business_operations.bo_publication_evidence_records r
          WHERE r.evidence_row_id = $1 AND r.tenant_id = $2 AND r.workspace_id = $3 AND r.business_id = $4 ORDER BY r.position ASC LIMIT $5`,
        [m.id, ctx.tenantId, ctx.workspaceId, business, PUBLICATION_EVIDENCE_MAX_RECORDS + 1]);
      return {
        id: m.id as string, tenantId: m.tenant_id as string, workspaceId: m.workspace_id as string, businessId: m.business_id as string, publicationPackageId: m.publication_package_id as string,
        contractName: m.contract_name as string, contractVersion: m.contract_version as string, contractStatus: m.contract_status as string, recordSchemaVersion: m.record_schema_version as string, domain: m.domain as string,
        periodStart: m.period_start as string, periodEnd: m.period_end as string, ordering: m.ordering as string, canonicalization: m.canonicalization as string, digestAlgorithm: m.digest_algorithm as string,
        declaredRecordCount: Number(m.declared_record_count), recordCount: Number(m.record_count), digest: m.digest as string, evidenceId: m.evidence_id as string, canonicalBody: m.canonical_body as string,
        correlationId: m.correlation_id as string, createdAt: m.created_at as Date,
        records: rows.rows.map((r) => ({ position: Number(r.position), movementId: r.movement_id, record: r.record })),
      };
    });
  }
}
