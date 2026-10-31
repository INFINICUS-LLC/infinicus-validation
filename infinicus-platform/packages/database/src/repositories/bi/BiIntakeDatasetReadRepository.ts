/**
 * BI-1 read side: what Business Intelligence has taken in from Business Operations, and the versioned analytical datasets built from it.
 *
 * Read-only by construction (SELECT only) and business-scoped: every statement pins tenant, workspace AND business from the caller, so an identifier that
 * belongs to another business, workspace or tenant is indistinguishable from one that does not exist (NotFoundError, never a different error). Nothing
 * here touches business_operations: BO's publication is represented only by the references BI recorded at intake. Quality and completeness scores are
 * returned exactly as stored, NULL when nothing has assessed them.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { NotFoundError } from './errors.js';

export interface PageInput { limit: number; offset: number }

export interface IntakePackageSummary {
  id: string; businessId: string; boPublicationPackageId: string; intakeCode: string; domain: string; status: string; rejectionReason: string | null;
  schemaVersion: string; correlationId: string; createdAt: Date; updatedAt: Date;
}
export interface IntakePackageDetail extends IntakePackageSummary {
  statusHistory: Array<{ fromStatus: string | null; toStatus: string; reason: string | null; occurredAt: Date }>;
  versions: Array<{ versionNumber: number; recordCount: number; payloadReference: Record<string, unknown>; qualityScore: number | null; completenessScore: number | null; recordedAt: Date }>;
  sourceReferences: Array<{ id: string; sourceSystem: string; boHandoffRecordId: string | null; packageCode: string | null; handoffId: string | null; contractVersion: string | null; recordedAt: Date }>;
  domainInputs: Array<{ domain: string; status: string }>;
  datasetVersions: Array<{ datasetId: string; datasetCode: string; datasetVersionId: string; versionNumber: number }>;
}

export interface DatasetSummary { id: string; businessId: string; datasetCode: string; domain: string; name: string; description: string | null; status: string; latestVersion: number; createdAt: Date; updatedAt: Date }
export interface DatasetVersionView {
  id: string; versionNumber: number; effectiveStart: Date; effectiveEnd: Date | null; publicationStatus: string; qualityScore: number | null; completenessScore: number | null;
  intakePackageId: string | null; schemaReference: Record<string, unknown>; correlationId: string; createdAt: Date;
  dataReferences: Array<{ referenceType: string; recordCount: number; reference: Record<string, unknown> }>;
  lineage: Array<{ lineageType: string; sourceReferenceId: string | null; parentDatasetVersionId: string | null }>;
}
export interface DatasetDetail extends DatasetSummary { versions: DatasetVersionView[] }

/**
 * The lifecycle of an intake in order. Rows written in one transaction share one timestamp, so time alone cannot order them; each row says which status it
 * came from, so the chain (null -> received -> ...) is followed, taking the earliest row first and falling back to time order for anything off the chain.
 */
export function orderStatusHistory<T extends { fromStatus: string | null; toStatus: string }>(rows: readonly T[]): T[] {
  const remaining = [...rows]; const ordered: T[] = []; let current: string | null = null;
  while (remaining.length > 0) {
    const i = remaining.findIndex((r) => r.fromStatus === current);
    const [next] = remaining.splice(i === -1 ? 0 : i, 1);
    ordered.push(next); current = next.toStatus;
  }
  return ordered;
}

const score = (v: unknown): number | null => (v === null || v === undefined ? null : Number.parseFloat(String(v)));
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toIntake(r: Record<string, unknown>): IntakePackageSummary {
  return {
    id: r.id as string, businessId: r.business_id as string, boPublicationPackageId: r.bo_publication_package_id as string, intakeCode: r.intake_code as string,
    domain: r.domain as string, status: r.status as string, rejectionReason: (r.rejection_reason as string | null) ?? null, schemaVersion: r.schema_version as string,
    correlationId: r.correlation_id as string, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  };
}
function toDataset(r: Record<string, unknown>): DatasetSummary {
  return {
    id: r.id as string, businessId: r.business_id as string, datasetCode: r.dataset_code as string, domain: r.domain as string, name: r.name as string,
    description: (r.description as string | null) ?? null, status: r.status as string, latestVersion: r.latest_version as number, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  };
}

export class BiIntakeDatasetReadRepository {
  async listIntakePackages(ctx: TenantContext, businessId: string, filter: { status?: string; domain?: string }, page: PageInput): Promise<IntakePackageSummary[]> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, bo_publication_package_id, intake_code, domain, status, rejection_reason, schema_version, correlation_id, created_at, updated_at
           FROM business_intelligence.intelligence_intake_packages
          WHERE business_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND ($4::text IS NULL OR status = $4) AND ($5::text IS NULL OR domain = $5)
          ORDER BY created_at DESC, id LIMIT $6 OFFSET $7`,
        [businessId, ctx.tenantId, ctx.workspaceId, filter.status ?? null, filter.domain ?? null, page.limit, page.offset]
      );
      return r.rows.map(toIntake);
    });
  }

  async getIntakePackage(ctx: TenantContext, businessId: string, intakePackageId: string): Promise<IntakePackageDetail> {
    return withTenantTransaction(ctx, async (client) => {
      const scope = [intakePackageId, businessId, ctx.tenantId, ctx.workspaceId];
      const pkg = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, bo_publication_package_id, intake_code, domain, status, rejection_reason, schema_version, correlation_id, created_at, updated_at
           FROM business_intelligence.intelligence_intake_packages WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4`, scope);
      if (pkg.rowCount !== 1) throw new NotFoundError('IntelligenceIntakePackage', intakePackageId);
      const history = await client.query<Record<string, unknown>>(
        `SELECT from_status, to_status, reason, occurred_at FROM business_intelligence.intelligence_processing_status_history
          WHERE intake_package_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY occurred_at, created_at, to_status`, scope);
      const versions = await client.query<Record<string, unknown>>(
        `SELECT version_number, record_count, payload_reference, quality_score, completeness_score, recorded_at FROM business_intelligence.intelligence_intake_package_versions
          WHERE intake_package_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY version_number`, scope);
      const sources = await client.query<Record<string, unknown>>(
        `SELECT id, source_system, source_reference, bo_handoff_record_id, recorded_at FROM business_intelligence.intelligence_source_references
          WHERE intake_package_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY recorded_at, id`, scope);
      const inputs = await client.query<Record<string, unknown>>(
        `SELECT domain, status FROM business_intelligence.intelligence_domain_inputs
          WHERE intake_package_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY created_at, id`, scope);
      const datasets = await client.query<Record<string, unknown>>(
        `SELECT d.id AS dataset_id, d.dataset_code, v.id AS version_id, v.version_number
           FROM business_intelligence.analytical_dataset_versions v JOIN business_intelligence.analytical_datasets d ON d.id = v.dataset_id
          WHERE v.intake_package_id = $1 AND v.business_id = $2 AND v.tenant_id = $3 AND v.workspace_id = $4 ORDER BY v.version_number, v.id`, scope);
      return {
        ...toIntake(pkg.rows[0]),
        statusHistory: orderStatusHistory(history.rows.map((h) => ({ fromStatus: (h.from_status as string | null) ?? null, toStatus: h.to_status as string, reason: (h.reason as string | null) ?? null, occurredAt: h.occurred_at as Date }))),
        versions: versions.rows.map((v) => ({ versionNumber: v.version_number as number, recordCount: v.record_count as number, payloadReference: v.payload_reference as Record<string, unknown>,
          qualityScore: score(v.quality_score), completenessScore: score(v.completeness_score), recordedAt: v.recorded_at as Date })),
        // Only a whitelist of what BI recorded about BO's publication is exposed, never the raw jsonb.
        sourceReferences: sources.rows.map((s) => {
          const ref = (s.source_reference ?? {}) as Record<string, unknown>;
          return { id: s.id as string, sourceSystem: s.source_system as string, boHandoffRecordId: (s.bo_handoff_record_id as string | null) ?? null, packageCode: str(ref.packageCode),
            handoffId: str(ref.handoffId), contractVersion: str(ref.contractVersion), recordedAt: s.recorded_at as Date };
        }),
        domainInputs: inputs.rows.map((i) => ({ domain: i.domain as string, status: i.status as string })),
        datasetVersions: datasets.rows.map((d) => ({ datasetId: d.dataset_id as string, datasetCode: d.dataset_code as string, datasetVersionId: d.version_id as string, versionNumber: d.version_number as number })),
      };
    });
  }

  async listDatasets(ctx: TenantContext, businessId: string, filter: { domain?: string }, page: PageInput): Promise<DatasetSummary[]> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, dataset_code, domain, name, description, status, latest_version, created_at, updated_at FROM business_intelligence.analytical_datasets
          WHERE business_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND ($4::text IS NULL OR domain = $4) ORDER BY dataset_code, id LIMIT $5 OFFSET $6`,
        [businessId, ctx.tenantId, ctx.workspaceId, filter.domain ?? null, page.limit, page.offset]
      );
      return r.rows.map(toDataset);
    });
  }

  /** A dataset with its newest versions first (at most `versionLimit`), each with its data references and lineage. */
  async getDataset(ctx: TenantContext, businessId: string, datasetId: string, versionLimit: number): Promise<DatasetDetail> {
    return withTenantTransaction(ctx, async (client) => {
      const ds = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, dataset_code, domain, name, description, status, latest_version, created_at, updated_at FROM business_intelligence.analytical_datasets
          WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4`, [datasetId, businessId, ctx.tenantId, ctx.workspaceId]);
      if (ds.rowCount !== 1) throw new NotFoundError('AnalyticalDataset', datasetId);
      const versions = await client.query<Record<string, unknown>>(
        `SELECT id, version_number, effective_start, effective_end, publication_status, quality_score, completeness_score, intake_package_id, schema_reference, correlation_id, created_at
           FROM business_intelligence.analytical_dataset_versions WHERE dataset_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4
          ORDER BY version_number DESC LIMIT $5`, [datasetId, businessId, ctx.tenantId, ctx.workspaceId, versionLimit]);
      const ids = versions.rows.map((v) => v.id as string);
      const refs = ids.length === 0 ? { rows: [] as Record<string, unknown>[] } : await client.query<Record<string, unknown>>(
        `SELECT dataset_version_id, reference_type, record_count, reference FROM business_intelligence.dataset_data_references
          WHERE dataset_version_id = ANY($1) AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY created_at, id`, [ids, businessId, ctx.tenantId, ctx.workspaceId]);
      const lineage = ids.length === 0 ? { rows: [] as Record<string, unknown>[] } : await client.query<Record<string, unknown>>(
        `SELECT dataset_version_id, lineage_type, source_reference_id, parent_dataset_version_id FROM business_intelligence.dataset_lineage
          WHERE dataset_version_id = ANY($1) AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 ORDER BY created_at, id`, [ids, businessId, ctx.tenantId, ctx.workspaceId]);
      return {
        ...toDataset(ds.rows[0]),
        versions: versions.rows.map((v) => ({
          id: v.id as string, versionNumber: v.version_number as number, effectiveStart: v.effective_start as Date, effectiveEnd: (v.effective_end as Date | null) ?? null,
          publicationStatus: v.publication_status as string, qualityScore: score(v.quality_score), completenessScore: score(v.completeness_score),
          intakePackageId: (v.intake_package_id as string | null) ?? null, schemaReference: v.schema_reference as Record<string, unknown>, correlationId: v.correlation_id as string,
          createdAt: v.created_at as Date,
          dataReferences: refs.rows.filter((r) => r.dataset_version_id === v.id).map((r) => ({ referenceType: r.reference_type as string, recordCount: r.record_count as number, reference: r.reference as Record<string, unknown> })),
          lineage: lineage.rows.filter((l) => l.dataset_version_id === v.id).map((l) => ({ lineageType: l.lineage_type as string, sourceReferenceId: (l.source_reference_id as string | null) ?? null, parentDatasetVersionId: (l.parent_dataset_version_id as string | null) ?? null })),
        })),
      };
    });
  }
}
