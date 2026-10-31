/**
 * BI-09 registry READ side (BI-2-DEV-03). SELECT-only: it lists and reads the governed metric definitions that BiMetricRegistryRepository wrote, and never
 * changes a version, an approval state or any evidence. Only GOVERNED definitions are visible (a Stage 2D definition has no snapshot and is not part of the
 * governed registry). Every statement is pinned to the caller's tenant and workspace and to one business, and the business must belong to the caller's workspace;
 * an id outside that scope is NotFoundError, identical to one that does not exist. The domain of a metric comes from its dataset (the authoritative relationship),
 * not from a copy. Filters are bound parameters in one static statement; ordering is total (code, then id), so pages are deterministic.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { NotFoundError } from './errors.js';

export interface MetricListFilter { datasetId?: string; status?: string; timeGrain?: string }
export interface MetricPage { limit: number; offset: number }

export interface GovernedMetricView {
  metricId: string;
  /** The canonical definition content exactly as committed (BI-09 model). */
  content: Record<string, unknown>;
  contentHash: string;
  /** Stored, CHECK-constrained columns of the latest version / header. */
  timeGrain: string;
  status: string;
  latestVersion: number;
  warehouseDatasetId: string;
  /** The domain of the metric's own dataset. */
  domain: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GovernedMetricVersionView { versionNumber: number; contentHash: string; governanceStatus: string; timeGrain: string; createdAt: Date }
export interface GovernedMetricDetail extends GovernedMetricView { versions: GovernedMetricVersionView[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toView = (r: Record<string, unknown>): GovernedMetricView => ({
  metricId: r.metric_id as string,
  content: r.definition_content as Record<string, unknown>,
  contentHash: r.content_hash as string,
  timeGrain: r.time_grain as string,
  status: r.status as string,
  latestVersion: r.latest_version as number,
  warehouseDatasetId: r.warehouse_dataset_id as string,
  domain: r.dataset_domain as string,
  createdAt: r.definition_created_at as Date,
  updatedAt: r.version_created_at as Date,
});

/** The latest governed version of each governed definition, with its dataset's domain. $1..$3 are tenant, workspace and business. */
const LATEST = `SELECT d.id AS metric_id, d.status, d.latest_version, d.created_at AS definition_created_at,
         v.definition_content, v.content_hash, v.time_grain, v.warehouse_dataset_id, v.created_at AS version_created_at, ds.domain AS dataset_domain
    FROM business_intelligence.metric_definitions d
    JOIN business_intelligence.metric_definition_versions v
      ON v.metric_definition_id = d.id AND v.version_number = d.latest_version
     AND v.tenant_id = d.tenant_id AND v.workspace_id = d.workspace_id AND v.business_id = d.business_id
    JOIN business_intelligence.analytical_datasets ds
      ON ds.id = v.warehouse_dataset_id AND ds.tenant_id = d.tenant_id AND ds.workspace_id = d.workspace_id AND ds.business_id = d.business_id
   WHERE d.tenant_id = $1 AND d.workspace_id = $2 AND d.business_id = $3 AND v.definition_content IS NOT NULL`;

export class BiMetricRegistryReadRepository {
  /** Runs `fn` in a tenant transaction after confirming the business belongs to the caller's workspace (NotFoundError otherwise). */
  private async scoped<T>(ctx: TenantContext, businessId: string, fn: (query: (sql: string, args: unknown[]) => Promise<Record<string, unknown>[]>, scope: string[]) => Promise<T>): Promise<T> {
    if (!UUID.test(businessId)) throw new NotFoundError('Business', businessId);
    return withTenantTransaction(ctx, async (client) => {
      const business = await client.query(
        'SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL', [businessId, ctx.tenantId, ctx.workspaceId]);
      if (business.rowCount !== 1) throw new NotFoundError('Business', businessId);
      return fn(async (sql, args) => (await client.query<Record<string, unknown>>(sql, args)).rows, [ctx.tenantId, ctx.workspaceId, businessId]);
    });
  }

  /** Governed metrics of a business by code. Filters narrow the result; they never widen it. */
  async list(ctx: TenantContext, businessId: string, filter: MetricListFilter, page: MetricPage): Promise<GovernedMetricView[]> {
    return this.scoped(ctx, businessId, async (query, scope) => {
      const rows = await query(
        `${LATEST}
        AND ($4::uuid IS NULL OR v.warehouse_dataset_id = $4::uuid)
        AND ($5::text IS NULL OR d.status = $5::text)
        AND ($6::text IS NULL OR v.time_grain = $6::text)
      ORDER BY d.metric_code ASC, d.id ASC
      LIMIT $7 OFFSET $8`,
        [...scope, filter.datasetId ?? null, filter.status ?? null, filter.timeGrain ?? null, page.limit, page.offset]);
      return rows.map(toView);
    });
  }

  /** One governed metric with its newest versions (newest first). NotFoundError for an id that is not a governed metric of this business. */
  async get(ctx: TenantContext, businessId: string, metricId: string, versionLimit: number): Promise<GovernedMetricDetail> {
    if (!UUID.test(metricId)) throw new NotFoundError('MetricDefinition', metricId);
    return this.scoped(ctx, businessId, async (query, scope) => {
      const latest = await query(`${LATEST} AND d.id = $4::uuid`, [...scope, metricId]);
      if (latest.length !== 1) throw new NotFoundError('MetricDefinition', metricId);
      const versions = await query(
        `SELECT v.version_number, v.content_hash, v.governance_status, v.time_grain, v.created_at
           FROM business_intelligence.metric_definition_versions v
          WHERE v.tenant_id = $1 AND v.workspace_id = $2 AND v.business_id = $3 AND v.metric_definition_id = $4::uuid AND v.definition_content IS NOT NULL
          ORDER BY v.version_number DESC
          LIMIT $5`,
        [...scope, metricId, versionLimit]);
      return {
        ...toView(latest[0]!),
        versions: versions.map((r) => ({
          versionNumber: r.version_number as number, contentHash: r.content_hash as string, governanceStatus: r.governance_status as string,
          timeGrain: r.time_grain as string, createdAt: r.created_at as Date,
        })),
      };
    });
  }
}
