import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ValidationError } from './errors.js';

export interface MetricCalculatedValue {
  id: string;
  metricDefinitionId: string;
  metricDefinitionVersionId: string;
  businessId: string;
  value: number;
  unit: string;
  currencyCode: string | null;
  dimensions: Record<string, unknown>;
  periodStart: Date;
  periodEnd: Date;
  calculationStatus: string;
  confidence: number | null;
  /** AC-2: where the value came from (source layer, record references, fact digest). Never a claim; a pointer to the evidence. */
  evidenceReference: Record<string, unknown>;
  correlationId: string;
}

export interface RecordCalculationInput {
  metricDefinitionId: string;
  metricDefinitionVersionId: string;
  businessId: string;
  value: number;
  unit: string;
  currencyCode?: string;
  dimensions?: Record<string, unknown>;
  periodStart: Date;
  periodEnd: Date;
  calculationStatus?: 'completed' | 'partial' | 'failed';
  confidence?: number;
  datasetVersionId?: string;
  evidenceReference?: Record<string, unknown>;
  correlationId?: string;
}

export interface TimeSeriesPoint {
  id: string;
  metricCalculatedValueId: string;
  observedAt: Date;
  sequenceNumber: number;
  value: number;
  unit: string;
}

function rowToValue(row: Record<string, unknown>): MetricCalculatedValue {
  return {
    id: row.id as string,
    metricDefinitionId: row.metric_definition_id as string,
    metricDefinitionVersionId: row.metric_definition_version_id as string,
    businessId: row.business_id as string,
    value: parseFloat(String(row.value)),
    unit: row.unit as string,
    currencyCode: row.currency_code as string | null,
    dimensions: row.dimensions as Record<string, unknown>,
    periodStart: row.period_start as Date,
    periodEnd: row.period_end as Date,
    calculationStatus: row.calculation_status as string,
    confidence: row.confidence === null ? null : parseFloat(String(row.confidence)),
    evidenceReference: (row.evidence_reference ?? {}) as Record<string, unknown>,
    correlationId: row.correlation_id as string,
  };
}

function rowToTimeSeriesPoint(row: Record<string, unknown>): TimeSeriesPoint {
  return {
    id: row.id as string,
    metricCalculatedValueId: row.metric_calculated_value_id as string,
    observedAt: row.observed_at as Date,
    sequenceNumber: row.sequence_number as number,
    value: parseFloat(String(row.value)),
    unit: row.unit as string,
  };
}

export class MetricCalculationRepository {
  async recordCalculation(ctx: TenantContext, input: RecordCalculationInput): Promise<MetricCalculatedValue> {
    if (input.periodEnd <= input.periodStart) {
      throw new ValidationError('MetricCalculatedValue', ['period_end must be after period_start']);
    }
    return withTenantTransaction(ctx, async (client) => {
      const correlationId = input.correlationId ?? randomUUID();
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.metric_calculated_values
           (metric_definition_id, metric_definition_version_id, tenant_id, workspace_id, business_id,
            dataset_version_id, value, unit, currency_code, dimensions, period_start, period_end,
            calculation_status, confidence, evidence_reference, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          input.metricDefinitionId, input.metricDefinitionVersionId, ctx.tenantId, ctx.workspaceId, input.businessId,
          input.datasetVersionId ?? null, input.value, input.unit, input.currencyCode ?? null,
          JSON.stringify(input.dimensions ?? {}), input.periodStart, input.periodEnd,
          input.calculationStatus ?? 'completed', input.confidence ?? null, JSON.stringify(input.evidenceReference ?? {}), correlationId,
        ]
      );
      return rowToValue(result.rows[0]);
    });
  }

  async findById(ctx: TenantContext, id: string): Promise<MetricCalculatedValue> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM business_intelligence.metric_calculated_values WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new NotFoundError('MetricCalculatedValue', id);
      return rowToValue(result.rows[0]);
    });
  }

  async listByMetricDefinition(ctx: TenantContext, metricDefinitionId: string): Promise<MetricCalculatedValue[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.metric_calculated_values WHERE metric_definition_id = $1 ORDER BY period_start', [metricDefinitionId]
      );
      return result.rows.map(rowToValue);
    });
  }

  async appendTimeSeriesPoint(ctx: TenantContext, metricCalculatedValueId: string, observedAt: Date, sequenceNumber: number, value: number, unit: string): Promise<TimeSeriesPoint> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_intelligence.metric_time_series_values
           (metric_calculated_value_id, tenant_id, workspace_id, business_id, observed_at, sequence_number, value, unit)
         SELECT $1, $2, $3, business_id, $4, $5, $6, $7
         FROM business_intelligence.metric_calculated_values WHERE id = $1
         RETURNING *`,
        [metricCalculatedValueId, ctx.tenantId, ctx.workspaceId, observedAt, sequenceNumber, value, unit]
      );
      if (result.rows.length === 0) throw new NotFoundError('MetricCalculatedValue', metricCalculatedValueId);
      return rowToTimeSeriesPoint(result.rows[0]);
    });
  }

  async listTimeSeries(ctx: TenantContext, metricCalculatedValueId: string): Promise<TimeSeriesPoint[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_intelligence.metric_time_series_values WHERE metric_calculated_value_id = $1 ORDER BY sequence_number', [metricCalculatedValueId]
      );
      return result.rows.map(rowToTimeSeriesPoint);
    });
  }
}
