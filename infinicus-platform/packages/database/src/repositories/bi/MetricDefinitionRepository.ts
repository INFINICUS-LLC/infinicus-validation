import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';

export interface MetricDefinition {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  metricCode: string;
  domain: string;
  metricType: string;
  name: string;
  unit: string;
  currencyCode: string | null;
  status: string;
  latestVersion: number;
}

export interface MetricDefinitionVersion {
  id: string;
  metricDefinitionId: string;
  versionNumber: number;
  aggregationMethod: string;
  timeGrain: string;
  dimensionalFilters: unknown[];
}

export interface CreateMetricDefinitionInput {
  businessId: string;
  metricCode: string;
  domain: string;
  metricType: 'base' | 'derived' | 'ratio' | 'rate' | 'target';
  name: string;
  unit: string;
  currencyCode?: string;
  aggregationMethod: string;
  timeGrain: 'day' | 'week' | 'month' | 'quarter' | 'year';
  dimensionalFilters?: unknown[];
  calculationSpecification?: Record<string, unknown>;
}

function rowToDefinition(row: Record<string, unknown>): MetricDefinition {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    metricCode: row.metric_code as string,
    domain: row.domain as string,
    metricType: row.metric_type as string,
    name: row.name as string,
    unit: row.unit as string,
    currencyCode: row.currency_code as string | null,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

function rowToVersion(row: Record<string, unknown>): MetricDefinitionVersion {
  return {
    id: row.id as string,
    metricDefinitionId: row.metric_definition_id as string,
    versionNumber: row.version_number as number,
    aggregationMethod: row.aggregation_method as string,
    timeGrain: row.time_grain as string,
    dimensionalFilters: row.dimensional_filters as unknown[],
  };
}

export class MetricDefinitionRepository {
  async create(ctx: TenantContext, input: CreateMetricDefinitionInput): Promise<{ definition: MetricDefinition; version: MetricDefinitionVersion }> {
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query('SELECT id FROM business_intelligence.metric_definitions WHERE business_id = $1 AND metric_code = $2', [input.businessId, input.metricCode]);
      if (existing.rows.length > 0) throw new ConflictError('MetricDefinition', `metric_code already exists: ${input.metricCode}`);

      const def = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.metric_definitions
           (tenant_id, workspace_id, business_id, metric_code, domain, metric_type, name, unit, currency_code, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
         RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.metricCode, input.domain, input.metricType, input.name, input.unit, input.currencyCode ?? null]
      );
      const version = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.metric_definition_versions
           (metric_definition_id, tenant_id, workspace_id, business_id, version_number, aggregation_method, time_grain, dimensional_filters, calculation_specification)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)
         RETURNING *`,
        [
          def.rows[0].id, ctx.tenantId, ctx.workspaceId, input.businessId,
          input.aggregationMethod, input.timeGrain,
          JSON.stringify(input.dimensionalFilters ?? []),
          JSON.stringify(input.calculationSpecification ?? {}),
        ]
      );
      return { definition: rowToDefinition(def.rows[0]), version: rowToVersion(version.rows[0]) };
    });
  }

  async findById(ctx: TenantContext, id: string): Promise<MetricDefinition> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.metric_definitions WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new NotFoundError('MetricDefinition', id);
      return rowToDefinition(result.rows[0]);
    });
  }

  /** AC-2: a business's definition by its code (null when absent). */
  async findByCode(ctx: TenantContext, businessId: string, metricCode: string): Promise<MetricDefinition | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.metric_definitions WHERE business_id = $1 AND metric_code = $2', [businessId, metricCode]);
      return result.rows.length === 0 ? null : rowToDefinition(result.rows[0]);
    });
  }

  /** AC-2: the newest version of a definition (calculations reference a version). */
  async findLatestVersion(ctx: TenantContext, metricDefinitionId: string): Promise<MetricDefinitionVersion> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.metric_definition_versions WHERE metric_definition_id = $1 ORDER BY version_number DESC LIMIT 1', [metricDefinitionId]);
      if (result.rows.length === 0) throw new NotFoundError('MetricDefinitionVersion', metricDefinitionId);
      return rowToVersion(result.rows[0]);
    });
  }

  async listByDomain(ctx: TenantContext, domain: string): Promise<MetricDefinition[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.metric_definitions WHERE domain = $1 ORDER BY created_at DESC', [domain]
      );
      return result.rows.map(rowToDefinition);
    });
  }

  async createVersion(ctx: TenantContext, metricDefinitionId: string, input: Omit<CreateMetricDefinitionInput, 'businessId' | 'metricCode' | 'domain' | 'metricType' | 'name' | 'unit' | 'currencyCode'>): Promise<MetricDefinitionVersion> {
    return withTenantTransaction(ctx, async (client) => {
      const def = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.metric_definitions WHERE id = $1', [metricDefinitionId]);
      if (def.rows.length === 0) throw new NotFoundError('MetricDefinition', metricDefinitionId);
      const nextVersion = (def.rows[0].latest_version as number) + 1;
      const version = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.metric_definition_versions
           (metric_definition_id, tenant_id, workspace_id, business_id, version_number, aggregation_method, time_grain, dimensional_filters, calculation_specification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          metricDefinitionId, ctx.tenantId, ctx.workspaceId, def.rows[0].business_id, nextVersion,
          input.aggregationMethod, input.timeGrain,
          JSON.stringify(input.dimensionalFilters ?? []),
          JSON.stringify(input.calculationSpecification ?? {}),
        ]
      );
      await client.query('UPDATE business_intelligence.metric_definitions SET latest_version = $2 WHERE id = $1', [metricDefinitionId, nextVersion]);
      return rowToVersion(version.rows[0]);
    });
  }
}
