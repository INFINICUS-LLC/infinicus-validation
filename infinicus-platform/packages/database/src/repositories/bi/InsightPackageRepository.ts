import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';

export interface InsightPackage {
  id: string;
  businessId: string;
  packageCode: string;
  latestVersion: number;
  status: string;
}

export interface InsightPackageVersion {
  id: string;
  insightPackageId: string;
  versionNumber: number;
  summary: string;
  findingIds: string[];
  /** AC-2: the metric calculations this version references (analytical evidence by id, never duplicated). */
  metricValueIds: string[];
  correlationId: string;
}

export interface CreateInsightPackageVersionInput {
  summary: string;
  findingIds?: string[];
  metricValueIds?: string[];
  forecastRunIds?: string[];
  anomalyDetectionIds?: string[];
  riskAssessmentIds?: string[];
}

function rowToPackage(row: Record<string, unknown>): InsightPackage {
  return { id: row.id as string, businessId: row.business_id as string, packageCode: row.package_code as string, latestVersion: row.latest_version as number, status: row.status as string };
}

function rowToVersion(row: Record<string, unknown>): InsightPackageVersion {
  return {
    id: row.id as string,
    insightPackageId: row.insight_package_id as string,
    versionNumber: row.version_number as number,
    summary: row.summary as string,
    findingIds: row.finding_ids as string[],
    metricValueIds: (row.metric_value_ids ?? []) as string[],
    correlationId: row.correlation_id as string,
  };
}

export class InsightPackageRepository {
  async create(ctx: TenantContext, businessId: string, packageCode: string): Promise<InsightPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query('SELECT id FROM business_intelligence.insight_packages WHERE business_id = $1 AND package_code = $2', [businessId, packageCode]);
      if (existing.rows.length > 0) throw new ConflictError('InsightPackage', `package_code already exists: ${packageCode}`);
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.insight_packages (tenant_id, workspace_id, business_id, package_code, latest_version)
         VALUES ($1,$2,$3,$4,0) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, packageCode]
      );
      return rowToPackage(result.rows[0]);
    });
  }

  async findById(ctx: TenantContext, id: string): Promise<InsightPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.insight_packages WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new NotFoundError('InsightPackage', id);
      return rowToPackage(result.rows[0]);
    });
  }

  /** AC-2: a business's package by its code (null when absent). */
  async findByCode(ctx: TenantContext, businessId: string, packageCode: string): Promise<InsightPackage | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.insight_packages WHERE business_id = $1 AND package_code = $2', [businessId, packageCode]);
      return result.rows.length === 0 ? null : rowToPackage(result.rows[0]);
    });
  }

  /** AC-2: the newest published version of a package (null when none). */
  async findLatestVersion(ctx: TenantContext, insightPackageId: string): Promise<InsightPackageVersion | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.insight_package_versions WHERE insight_package_id = $1 ORDER BY version_number DESC LIMIT 1', [insightPackageId]);
      return result.rows.length === 0 ? null : rowToVersion(result.rows[0]);
    });
  }

  async listForBusiness(ctx: TenantContext, businessId: string): Promise<InsightPackage[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.insight_packages WHERE business_id = $1 ORDER BY created_at DESC',
        [businessId]
      );
      return result.rows.map(rowToPackage);
    });
  }

  async publishVersion(ctx: TenantContext, insightPackageId: string, businessId: string, input: CreateInsightPackageVersionInput): Promise<InsightPackageVersion> {
    return withTenantTransaction(ctx, async (client) => {
      const pkg = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.insight_packages WHERE id = $1', [insightPackageId]);
      if (pkg.rows.length === 0) throw new NotFoundError('InsightPackage', insightPackageId);
      const nextVersion = (pkg.rows[0].latest_version as number) + 1;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.insight_package_versions
           (insight_package_id, tenant_id, workspace_id, business_id, version_number, finding_ids, metric_value_ids, forecast_run_ids, anomaly_detection_ids, risk_assessment_ids, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          insightPackageId, ctx.tenantId, ctx.workspaceId, businessId, nextVersion,
          JSON.stringify(input.findingIds ?? []), JSON.stringify(input.metricValueIds ?? []),
          JSON.stringify(input.forecastRunIds ?? []), JSON.stringify(input.anomalyDetectionIds ?? []),
          JSON.stringify(input.riskAssessmentIds ?? []), input.summary,
        ]
      );
      await client.query(`UPDATE business_intelligence.insight_packages SET latest_version = $2, status = 'published' WHERE id = $1`, [insightPackageId, nextVersion]);
      return rowToVersion(result.rows[0]);
    });
  }

  async findVersionById(ctx: TenantContext, id: string): Promise<InsightPackageVersion> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.insight_package_versions WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new NotFoundError('InsightPackageVersion', id);
      return rowToVersion(result.rows[0]);
    });
  }

  async revoke(ctx: TenantContext, insightPackageId: string): Promise<InsightPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_intelligence.insight_packages SET status = 'revoked' WHERE id = $1 RETURNING *`, [insightPackageId]
      );
      if (result.rows.length === 0) throw new NotFoundError('InsightPackage', insightPackageId);
      return rowToPackage(result.rows[0]);
    });
  }
}
