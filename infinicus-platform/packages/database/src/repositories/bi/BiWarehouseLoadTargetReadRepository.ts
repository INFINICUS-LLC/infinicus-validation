/**
 * BI-08 load target resolution (BI-08-DEV-01): everything the platform can VERIFY about the dataset version a warehouse load would fill, before any row is prepared.
 *
 * SELECT-only and business-scoped (tenant, workspace and business are pinned by the caller; another party's version is indistinguishable from a missing one).
 * It reads the BI side of the chain (version, intake package, source reference, declared record count, seal state, rows already held) and, read-only, Business
 * Operations' own publication package record, so that the count BO published, the count BI recorded at intake and the count of the records offered can be compared.
 * It never writes, and it never reads a BO operational table: only the publication package header BO already hands to BI.
 */
import type { TenantContext } from '../../client.js';
import { inBusinessScope } from './businessScope.js';
import { NotFoundError } from './errors.js';

export interface WarehouseLoadTarget {
  datasetId: string;
  datasetCode: string;
  datasetVersionId: string;
  versionNumber: number;
  publicationStatus: string;
  intakePackageId: string;
  intakeStatus: string;
  boPublicationPackageId: string;
  /** Header of the BO publication package, as BO holds it. */
  boPackage: { packageCode: string; packageStatus: string; targetLayer: string; recordCount: number };
  /** Record count recorded at intake for this version (dataset_data_references), the count a seal is checked against. */
  declaredRecordCount: number;
  /** The source reference(s) of the intake package: rows may cite only these. */
  sourceReferenceIds: string[];
  /** Rows already recorded for this version, and its seal if sealed. */
  heldRowCount: number;
  seal: { rowCount: number; rowsDigest: string } | null;
}

const STATEMENT = `
SELECT v.id AS version_id, v.version_number, v.publication_status, v.intake_package_id, d.id AS dataset_id, d.dataset_code,
       i.status AS intake_status, i.bo_publication_package_id,
       b.package_code, b.package_status, b.target_layer, b.record_count AS bo_record_count,
       (SELECT r.record_count FROM business_intelligence.dataset_data_references r
         WHERE r.dataset_version_id = v.id AND r.tenant_id = v.tenant_id AND r.workspace_id = v.workspace_id AND r.business_id = v.business_id
         ORDER BY r.created_at, r.id LIMIT 1) AS declared_record_count,
       ARRAY(SELECT s.id FROM business_intelligence.intelligence_source_references s
              WHERE s.intake_package_id = v.intake_package_id AND s.tenant_id = v.tenant_id AND s.workspace_id = v.workspace_id AND s.business_id = v.business_id
              ORDER BY s.id) AS source_reference_ids,
       (SELECT count(*) FROM business_intelligence.warehouse_dataset_rows w
         WHERE w.dataset_version_id = v.id AND w.tenant_id = v.tenant_id AND w.workspace_id = v.workspace_id AND w.business_id = v.business_id) AS held_rows,
       z.row_count AS seal_row_count, z.rows_digest AS seal_digest
  FROM business_intelligence.analytical_dataset_versions v
  JOIN business_intelligence.analytical_datasets d
    ON d.id = v.dataset_id AND d.tenant_id = v.tenant_id AND d.workspace_id = v.workspace_id AND d.business_id = v.business_id
  JOIN business_intelligence.intelligence_intake_packages i
    ON i.id = v.intake_package_id AND i.tenant_id = v.tenant_id AND i.workspace_id = v.workspace_id AND i.business_id = v.business_id
  JOIN business_operations.bo_publication_packages b
    ON b.id = i.bo_publication_package_id AND b.tenant_id = v.tenant_id AND b.workspace_id = v.workspace_id AND b.business_id = v.business_id
  LEFT JOIN business_intelligence.warehouse_dataset_version_seals z
    ON z.dataset_version_id = v.id AND z.tenant_id = v.tenant_id AND z.workspace_id = v.workspace_id AND z.business_id = v.business_id
 WHERE v.id = $1 AND v.tenant_id = $2 AND v.workspace_id = $3 AND v.business_id = $4`;

export class BiWarehouseLoadTargetReadRepository {
  /** The verified facts about a dataset version a load would fill. NotFoundError when the version is not in the caller's business (or its chain is broken). */
  async resolve(ctx: TenantContext, businessId: string, datasetVersionId: string): Promise<WarehouseLoadTarget> {
    if (typeof datasetVersionId !== 'string') throw new NotFoundError('DatasetVersion', String(datasetVersionId));
    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const id = datasetVersionId.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new NotFoundError('DatasetVersion', datasetVersionId);
      const res = await client.query<Record<string, unknown>>(STATEMENT, [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (res.rowCount !== 1) throw new NotFoundError('DatasetVersion', datasetVersionId);
      const r = res.rows[0]!;
      if (r.declared_record_count === null || r.declared_record_count === undefined) throw new NotFoundError('DatasetVersion', datasetVersionId);
      return {
        datasetId: r.dataset_id as string, datasetCode: r.dataset_code as string, datasetVersionId: r.version_id as string, versionNumber: Number(r.version_number),
        publicationStatus: r.publication_status as string, intakePackageId: r.intake_package_id as string, intakeStatus: r.intake_status as string,
        boPublicationPackageId: r.bo_publication_package_id as string,
        boPackage: { packageCode: r.package_code as string, packageStatus: r.package_status as string, targetLayer: r.target_layer as string, recordCount: Number(r.bo_record_count) },
        declaredRecordCount: Number(r.declared_record_count), sourceReferenceIds: r.source_reference_ids as string[], heldRowCount: Number(r.held_rows),
        seal: r.seal_row_count === null || r.seal_row_count === undefined ? null : { rowCount: Number(r.seal_row_count), rowsDigest: r.seal_digest as string },
      };
    });
  }
}
