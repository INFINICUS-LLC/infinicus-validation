/**
 * BI-1 (BI-02 source-to-dataset mapping, feeding the BI-08 dataset tables): turns a validated BO -> BI intake into a governed, versioned analytical dataset.
 *
 * One dataset per (business, BI block): each further package for the same block is the next VERSION of that dataset, covering the package's period. A version
 * carries its intake package, a data reference to the BO publication (never BO's rows), lineage back to the intake's source reference, and NULL quality and
 * completeness scores: nothing has assessed them yet, so none is invented. Everything happens in one transaction and is idempotent per intake package.
 * Writes business_intelligence only. The one business_operations table it reads is the publication package, for the period BO published (read-only, scoped).
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { NotFoundError } from './errors.js';

export interface IntakeDatasetResult {
  datasetId: string;
  datasetCode: string;
  datasetVersionId: string;
  versionNumber: number;
  domain: string;
  effectiveStart: Date;
  effectiveEnd: Date;
  recordCount: number;
  idempotentReplay: boolean;
}

/** The intake cannot become a dataset (not validated, provenance missing); nothing was changed. `reason` is a stable code, never a value. */
export class IntakeNotMaterializableError extends Error {
  constructor(readonly reason: string) {
    super(`Intake package cannot be materialized: ${reason}`);
    this.name = 'IntakeNotMaterializableError';
  }
}

/** The dataset code of a BI block's data from BO. Deterministic: the same block always lands in the same dataset. */
export const datasetCodeFor = (targetBlock: string): string => `bo-${targetBlock.toLowerCase()}`;

/** Deterministic, value-free description of the shape of a BO payload reference (field name and primitive type, sorted by name). */
export function schemaReferenceOf(payloadReference: Record<string, unknown>): { contract: string; fields: Array<{ name: string; type: string }> } {
  return {
    contract: 'bo-publication-reference/1',
    fields: Object.keys(payloadReference).sort().map((name) => ({ name, type: payloadReference[name] === null ? 'null' : typeof payloadReference[name] })),
  };
}

export class IntakeDatasetRepository {
  async materialize(ctx: TenantContext, intakePackageId: string): Promise<IntakeDatasetResult> {
    return withTenantTransaction(ctx, async (client) => {
      // Row-level security pins this to the caller's tenant and workspace; the explicit predicates say so too.
      const intake = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, bo_publication_package_id, domain, status, correlation_id FROM business_intelligence.intelligence_intake_packages
          WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3`,
        [intakePackageId, ctx.tenantId, ctx.workspaceId]
      );
      if (intake.rowCount !== 1) throw new NotFoundError('IntelligenceIntakePackage', intakePackageId);
      const pkg = intake.rows[0];
      const businessId = pkg.business_id as string;
      const domain = pkg.domain as string;
      const correlationId = pkg.correlation_id as string;

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bi_dataset:${businessId}:${intakePackageId}`]);

      const replayed = await client.query<Record<string, unknown>>(
        `SELECT v.id, v.version_number, v.effective_start, v.effective_end, d.id AS dataset_id, d.dataset_code, d.domain,
                (SELECT record_count FROM business_intelligence.dataset_data_references r WHERE r.dataset_version_id = v.id ORDER BY r.created_at LIMIT 1) AS record_count
           FROM business_intelligence.analytical_dataset_versions v JOIN business_intelligence.analytical_datasets d ON d.id = v.dataset_id
          WHERE v.intake_package_id = $1 AND v.tenant_id = $2 AND v.workspace_id = $3`,
        [intakePackageId, ctx.tenantId, ctx.workspaceId]
      );
      if (replayed.rowCount === 1) {
        const r = replayed.rows[0];
        return {
          datasetId: r.dataset_id as string, datasetCode: r.dataset_code as string, datasetVersionId: r.id as string, versionNumber: r.version_number as number,
          domain: r.domain as string, effectiveStart: r.effective_start as Date, effectiveEnd: r.effective_end as Date, recordCount: Number(r.record_count), idempotentReplay: true,
        };
      }
      if (pkg.status !== 'validated') throw new IntakeNotMaterializableError(`status_is_${String(pkg.status)}_not_validated`);

      // What was recorded when the package was ingested: its version, its source reference and its pending domain input.
      const version = await client.query<{ payload_reference: Record<string, unknown>; record_count: number }>(
        `SELECT payload_reference, record_count FROM business_intelligence.intelligence_intake_package_versions WHERE intake_package_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [intakePackageId]
      );
      const source = await client.query<{ id: string; source_reference: Record<string, unknown> }>(
        `SELECT id, source_reference FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1 ORDER BY recorded_at LIMIT 1`,
        [intakePackageId]
      );
      const input = await client.query<{ id: string; input_reference: Record<string, unknown> }>(
        `SELECT id, input_reference FROM business_intelligence.intelligence_domain_inputs WHERE intake_package_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1`,
        [intakePackageId]
      );
      if (version.rowCount !== 1 || source.rowCount !== 1 || input.rowCount !== 1) throw new IntakeNotMaterializableError('intake_provenance_incomplete');
      const targetBlock = String(input.rows[0].input_reference.targetBlock ?? '');
      if (!/^BI-\d{2}$/.test(targetBlock)) throw new IntakeNotMaterializableError('intake_target_block_missing');

      // The period BO published for the package (read-only, pinned to the caller's scope).
      const period = await client.query<{ period_start: Date; period_end: Date }>(
        `SELECT period_start, period_end FROM business_operations.bo_publication_packages WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4`,
        [pkg.bo_publication_package_id, businessId, ctx.tenantId, ctx.workspaceId]
      );
      if (period.rowCount !== 1) throw new IntakeNotMaterializableError('bo_publication_package_not_found_in_scope');

      const code = datasetCodeFor(targetBlock);
      const existing = await client.query<{ id: string; latest_version: number; domain: string }>(
        `SELECT id, latest_version, domain FROM business_intelligence.analytical_datasets WHERE business_id = $1 AND dataset_code = $2 FOR UPDATE`,
        [businessId, code]
      );
      let datasetId: string; let versionNumber: number;
      if (existing.rowCount === 1) {
        if (existing.rows[0].domain !== domain) throw new IntakeNotMaterializableError('dataset_domain_differs_from_intake');
        datasetId = existing.rows[0].id; versionNumber = existing.rows[0].latest_version + 1;
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO business_intelligence.analytical_datasets (tenant_id, workspace_id, business_id, dataset_code, domain, name, description, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
          [ctx.tenantId, ctx.workspaceId, businessId, code, domain, `Business Operations data for ${targetBlock}`, `Versions of what Business Operations published for ${targetBlock}, one per publication package.`]
        );
        datasetId = created.rows[0].id; versionNumber = 1;
      }

      const published = await client.query<{ id: string }>(
        `INSERT INTO business_intelligence.analytical_dataset_versions
           (dataset_id, tenant_id, workspace_id, business_id, version_number, schema_reference, effective_start, effective_end, quality_score, completeness_score,
            publication_status, intake_package_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,'published',$9,$10) RETURNING id`,
        [datasetId, ctx.tenantId, ctx.workspaceId, businessId, versionNumber, JSON.stringify(schemaReferenceOf(version.rows[0].payload_reference)),
          period.rows[0].period_start, period.rows[0].period_end, intakePackageId, correlationId]
      );
      const versionId = published.rows[0].id;
      await client.query('UPDATE business_intelligence.analytical_datasets SET latest_version = $2 WHERE id = $1', [datasetId, versionNumber]);
      await client.query(
        `INSERT INTO business_intelligence.dataset_data_references (dataset_version_id, tenant_id, workspace_id, business_id, reference_type, reference, record_count)
         VALUES ($1,$2,$3,$4,'bo_publication_package',$5,$6)`,
        [versionId, ctx.tenantId, ctx.workspaceId, businessId,
          JSON.stringify({ boPublicationPackageId: pkg.bo_publication_package_id, packageCode: source.rows[0].source_reference.packageCode ?? null, targetBlock, payloadReference: version.rows[0].payload_reference }),
          version.rows[0].record_count]
      );
      await client.query(
        `INSERT INTO business_intelligence.dataset_lineage (dataset_version_id, tenant_id, workspace_id, business_id, source_reference_id, lineage_type)
         VALUES ($1,$2,$3,$4,$5,'derived_from')`,
        [versionId, ctx.tenantId, ctx.workspaceId, businessId, source.rows[0].id]
      );
      await client.query(`UPDATE business_intelligence.intelligence_domain_inputs SET status = 'mapped' WHERE id = $1`, [input.rows[0].id]);
      await client.query(`UPDATE business_intelligence.intelligence_intake_packages SET status = 'processed' WHERE id = $1`, [intakePackageId]);
      await client.query(
        `INSERT INTO business_intelligence.intelligence_processing_status_history
           (intake_package_id, tenant_id, workspace_id, business_id, from_status, to_status, reason, correlation_id)
         VALUES ($1,$2,$3,$4,'validated','processed',$5,$6)`,
        [intakePackageId, ctx.tenantId, ctx.workspaceId, businessId, `dataset ${code} version ${versionNumber}`, correlationId]
      );
      return {
        datasetId, datasetCode: code, datasetVersionId: versionId, versionNumber, domain, effectiveStart: period.rows[0].period_start, effectiveEnd: period.rows[0].period_end,
        recordCount: version.rows[0].record_count, idempotentReplay: false,
      };
    });
  }
}
