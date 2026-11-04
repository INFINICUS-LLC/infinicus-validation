/**
 * BO-PUB-DEV-02, aligned to the R4/D3 association model: durable storage of Business Operations record-publication evidence (migration 0224). BO-owned, append-only.
 *
 * ONE controlled writer. It does not decide what the evidence MEANS (the record schema, digest rules and complete verifier live in the Business Operations runtime, which depends
 * on this package, and run before this is called); it guarantees the database side of D3: one transaction on one connection, the scoped business, the header locked
 * `FOR UPDATE` by exact tenant, workspace, business and id BEFORE the association is inspected (lock order: header, then association), exact replay decided on the stored
 * canonical bytes (never on JSONB), a sanitized conflict for different content under the same header, `INSERT ... ON CONFLICT DO NOTHING` on the one-slot key with the winner
 * read back in a separate statement, and database refusals reported as outcomes (never SQL, schema or constraint text). The database independently enforces the one slot per
 * header, the composite header key that pins scope and period, the digest and id derivations, the creation state and append-only immutability.
 *
 * The only header statement is the `FOR UPDATE` read: the header is never updated, and no audit, outbox or dispatch event is written. Reads are SELECT-only and pinned to tenant,
 * workspace and business; another party's artifact is indistinguishable from a missing one. No operational ledger table and no Business Intelligence table is touched.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonicalUuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v.toLowerCase()) ? v.toLowerCase() : null);
const pgCode = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);

/** Engineering bound: the BI-10 engine reads at most this many rows per dataset, and the evidence contract refuses more. */
export const PUBLICATION_EVIDENCE_MAX_RECORDS = 100_000;

export interface AppendPublicationEvidenceInput {
  publicationPackageId: string;
  contractName: string; contractVersion: string; contractStatus: string; recordSchemaVersion: string; domain: string;
  /** UTC instants at millisecond precision, as the artifact states them. */
  periodStart: string; periodEnd: string;
  ordering: string; canonicalization: string; digestAlgorithm: string;
  recordCount: number;
  digest: string; evidenceId: string;
  /** The exact canonical text that was hashed: the equality reference. */
  canonicalBody: string;
  /** Provenance only: retained from the first association and ignored when comparing content. */
  correlationId: string;
}
export type AppendPublicationEvidenceOutcome =
  | { outcome: 'STORED'; evidenceRowId: string }
  | { outcome: 'REPLAYED'; evidenceRowId: string }
  /** A different artifact is already associated with this header (one permanent slot per header). */
  | { outcome: 'CONFLICT' }
  /** The header is not in this scope (a foreign, sibling-business or missing header are indistinguishable). */
  | { outcome: 'HEADER_NOT_FOUND' }
  /** The header exists but cannot take a NEW association: not addressed to BI, or not in the creation state 'ready'. */
  | { outcome: 'HEADER_NOT_ELIGIBLE' }
  /** The artifact disagrees with the header or the database refused it (period, count, binding, digest, id, identity). No detail is returned. */
  | { outcome: 'REFUSED' }
  | { outcome: 'UNKNOWN_BUSINESS' };

export interface StoredPublicationEvidence {
  id: string; tenantId: string; workspaceId: string; businessId: string; publicationPackageId: string;
  contractName: string; contractVersion: string; contractStatus: string; recordSchemaVersion: string; domain: string;
  periodStart: string; periodEnd: string; ordering: string; canonicalization: string; digestAlgorithm: string;
  recordCount: number; digest: string; evidenceId: string; canonicalBody: string; correlationId: string; createdAt: Date;
}

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const EVIDENCE_COLUMNS = `e.id, e.tenant_id, e.workspace_id, e.business_id, e.publication_package_id, e.contract_name, e.contract_version, e.contract_status, e.record_schema_version, e.domain,
       to_char(e.period_start AT TIME ZONE 'UTC', ${MS}) AS period_start, to_char(e.period_end AT TIME ZONE 'UTC', ${MS}) AS period_end,
       e.ordering, e.canonicalization, e.digest_algorithm, e.record_count, e.digest, e.evidence_id, e.canonical_body, e.correlation_id, e.created_at`;

function toStored(m: Record<string, unknown>): StoredPublicationEvidence {
  return {
    id: m.id as string, tenantId: m.tenant_id as string, workspaceId: m.workspace_id as string, businessId: m.business_id as string, publicationPackageId: m.publication_package_id as string,
    contractName: m.contract_name as string, contractVersion: m.contract_version as string, contractStatus: m.contract_status as string, recordSchemaVersion: m.record_schema_version as string, domain: m.domain as string,
    periodStart: m.period_start as string, periodEnd: m.period_end as string, ordering: m.ordering as string, canonicalization: m.canonicalization as string, digestAlgorithm: m.digest_algorithm as string,
    recordCount: Number(m.record_count), digest: m.digest as string, evidenceId: m.evidence_id as string, canonicalBody: m.canonical_body as string, correlationId: m.correlation_id as string, createdAt: m.created_at as Date,
  };
}

/** Exact replay: the stored canonical bytes, digest, evidence id, period, contract and schema all equal the offered artifact. The correlation id is provenance and is not compared. */
function sameArtifact(s: StoredPublicationEvidence, i: AppendPublicationEvidenceInput): boolean {
  return s.canonicalBody === i.canonicalBody && s.digest === i.digest && s.evidenceId === i.evidenceId && s.periodStart === i.periodStart && s.periodEnd === i.periodEnd
    && s.contractName === i.contractName && s.contractVersion === i.contractVersion && s.contractStatus === i.contractStatus && s.recordSchemaVersion === i.recordSchemaVersion
    && s.domain === i.domain && s.recordCount === i.recordCount && s.ordering === i.ordering && s.canonicalization === i.canonicalization && s.digestAlgorithm === i.digestAlgorithm;
}

export class BoPublicationEvidenceRepository {
  /** Associates one verified evidence artifact with its publication header, atomically. Idempotent on the stored canonical bytes. */
  async append(ctx: TenantContext, businessId: string, input: AppendPublicationEvidenceInput): Promise<AppendPublicationEvidenceOutcome> {
    const business = canonicalUuid(businessId); const header = canonicalUuid(input?.publicationPackageId); const correlation = canonicalUuid(input?.correlationId);
    if (business === null) return { outcome: 'UNKNOWN_BUSINESS' };
    if (header === null) return { outcome: 'HEADER_NOT_FOUND' };
    if (correlation === null || !Number.isInteger(input.recordCount) || input.recordCount < 0 || input.recordCount > PUBLICATION_EVIDENCE_MAX_RECORDS || typeof input.canonicalBody !== 'string') return { outcome: 'REFUSED' };

    return withTenantTransaction(ctx, async (client): Promise<AppendPublicationEvidenceOutcome> => {
      const exists = await client.query('SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL', [business, ctx.tenantId, ctx.workspaceId]);
      if (exists.rowCount !== 1) return { outcome: 'UNKNOWN_BUSINESS' };

      // Lock order: the scoped header first (FOR UPDATE, by exact tenant, workspace, business and id), then the association. The unique key is the final backstop.
      const locked = await client.query<{ target_layer: string; package_status: string; record_count: number; period_matches: boolean }>(
        `SELECT target_layer, package_status, record_count, (period_start = $5::timestamptz AND period_end = $6::timestamptz) AS period_matches
           FROM business_operations.bo_publication_packages WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4 FOR UPDATE`,
        [header, ctx.tenantId, ctx.workspaceId, business, input.periodStart, input.periodEnd]).catch((e: unknown) => { if ((pgCode(e) ?? '').startsWith('22')) return null; throw e; });
      if (locked === null) return { outcome: 'REFUSED' };
      if (locked.rowCount !== 1) return { outcome: 'HEADER_NOT_FOUND' };
      const h = locked.rows[0]!;

      const readStored = async (): Promise<StoredPublicationEvidence | null> => {
        const r = await client.query<Record<string, unknown>>(
          `SELECT ${EVIDENCE_COLUMNS} FROM business_operations.bo_publication_evidence e WHERE e.publication_package_id = $1 AND e.tenant_id = $2 AND e.workspace_id = $3 AND e.business_id = $4`,
          [header, ctx.tenantId, ctx.workspaceId, business]);
        return r.rowCount === 1 ? toStored(r.rows[0]!) : null;
      };
      const decide = (s: StoredPublicationEvidence): AppendPublicationEvidenceOutcome => (sameArtifact(s, input) ? { outcome: 'REPLAYED', evidenceRowId: s.id } : { outcome: 'CONFLICT' });

      // Replay is decided BEFORE eligibility: an exact replay is returned even after the header has advanced to an approved replay state.
      const existing = await readStored();
      if (existing !== null) return decide(existing);

      if (h.target_layer !== 'business_intelligence' || h.package_status !== 'ready') return { outcome: 'HEADER_NOT_ELIGIBLE' };
      if (!h.period_matches || Number(h.record_count) !== input.recordCount) return { outcome: 'REFUSED' };

      await client.query('SAVEPOINT evidence_insert');
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO business_operations.bo_publication_evidence
             (tenant_id, workspace_id, business_id, publication_package_id, period_start, period_end, contract_name, contract_version, contract_status, record_schema_version, domain,
              ordering, canonicalization, digest_algorithm, record_count, digest, evidence_id, canonical_body, correlation_id)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (publication_package_id) DO NOTHING RETURNING id`,
          [ctx.tenantId, ctx.workspaceId, business, header, input.periodStart, input.periodEnd, input.contractName, input.contractVersion, input.contractStatus, input.recordSchemaVersion, input.domain,
            input.ordering, input.canonicalization, input.digestAlgorithm, input.recordCount, input.digest, input.evidenceId, input.canonicalBody, correlation]);
        await client.query('RELEASE SAVEPOINT evidence_insert');
        if (inserted.rowCount === 1) return { outcome: 'STORED', evidenceRowId: inserted.rows[0]!.id };
        // A contender won: read the winner in a separate statement and apply the identical replay validation. A missing visible winner is a refusal.
        const winner = await readStored();
        return winner === null ? { outcome: 'REFUSED' } : decide(winner);
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

  /** The stored association of a publication header, or null. Read-only and scope-pinned. */
  async getByHeader(ctx: TenantContext, businessId: string, publicationPackageId: string): Promise<StoredPublicationEvidence | null> {
    const business = canonicalUuid(businessId); const header = canonicalUuid(publicationPackageId);
    if (business === null || header === null) return null;
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT ${EVIDENCE_COLUMNS} FROM business_operations.bo_publication_evidence e WHERE e.publication_package_id = $1 AND e.tenant_id = $2 AND e.workspace_id = $3 AND e.business_id = $4`,
        [header, ctx.tenantId, ctx.workspaceId, business]);
      return r.rowCount === 1 ? toStored(r.rows[0]!) : null;
    });
  }
}
