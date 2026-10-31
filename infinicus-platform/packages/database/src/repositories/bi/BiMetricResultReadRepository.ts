/**
 * Governed BI-10 metric result querying (BI-2-DEV-08). SELECT-only over metric_results (migration 0223), pinned to the caller's tenant, workspace and one business
 * (a result of another business is simply not there: no enumeration), with filters limited to what the frozen result carries. One static statement: every filter
 * and the page are bound parameters; the order is total (persisted time newest first, then run, metric code, group key and id), so pages are deterministic.
 * Paging bounds are enforced HERE, before any connection is taken, and never clamped: an out-of-range value is a ValidationError.
 * Values are the stored exact decimals as canonical text. Integrity of a whole run (ids, digest) is verified by the persistence service when a run is read.
 */
import type { TenantContext } from '../../client.js';
import { canonicalUuid, inBusinessScope } from './businessScope.js';
import { ValidationError } from './errors.js';

export const RESULT_QUERY_BOUNDS = { minLimit: 1, maxLimit: 100, minOffset: 0, maxOffset: 100_000 } as const;
export const RESULT_THRESHOLD_STATUSES = ['no_data', 'normal', 'warning', 'critical', 'good'] as const;
export const RESULT_CALCULATION_STATUSES = ['completed', 'no_data'] as const;
const METRIC_CODE = /^[a-z0-9_]{1,128}$/;
const TIME_BUCKET = /^(\d{4}|\d{4}-\d{2}|\d{4}-\d{2}-\d{2}|unknown)$/;

export interface MetricResultFilter {
  calculationRunId?: string;
  metricId?: string;
  metricCode?: string;
  calculationStatus?: string;
  thresholdStatus?: string;
  timeBucket?: string;
}
export interface MetricResultPage { limit: number; offset: number }

export interface MetricResultView {
  metricResultId: string;
  calculationRunId: string;
  metricId: string;
  metricVersion: number;
  metricCode: string;
  metricType: string;
  metricContentHash: string;
  warehouseDatasetId: string;
  /** The sealed dataset version the run read for this dataset; null for results whose dataset the run did not read (derived and ratio metrics). */
  datasetVersionId: string | null;
  groupKey: string;
  groupDimensions: Record<string, unknown>;
  timeBucket: string | null;
  value: string | null;
  unit: string;
  currency: string | null;
  target: string | null;
  thresholdStatus: string;
  targetMet: boolean | null;
  sourceRowCount: number | null;
  calculationStatus: string;
  persistedAt: Date;
}

function boundedInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ValidationError('MetricResultPage', [name + ' must be an integer from ' + min + ' to ' + max]);
  return value;
}

const LIST = `SELECT r.id, r.run_id, r.metric_definition_id, r.metric_version, r.metric_code, r.metric_type, r.metric_content_hash, r.warehouse_dataset_id, i.dataset_version_id,
       r.group_key, r.group_dimensions, r.time_bucket, r.value::text AS value, r.unit, r.currency, r.target::text AS target, r.threshold_status, r.target_met,
       r.source_row_count, r.calculation_status, r.persisted_at
  FROM business_intelligence.metric_results r
  LEFT JOIN business_intelligence.metric_calculation_run_inputs i
    ON i.run_id = r.run_id AND i.dataset_id = r.warehouse_dataset_id AND i.tenant_id = r.tenant_id AND i.workspace_id = r.workspace_id AND i.business_id = r.business_id
 WHERE r.tenant_id = $1 AND r.workspace_id = $2 AND r.business_id = $3
   AND ($4::uuid IS NULL OR r.run_id = $4::uuid)
   AND ($5::uuid IS NULL OR r.metric_definition_id = $5::uuid)
   AND ($6::text IS NULL OR r.metric_code = $6::text)
   AND ($7::text IS NULL OR r.calculation_status = $7::text)
   AND ($8::text IS NULL OR r.threshold_status = $8::text)
   AND ($9::text IS NULL OR r.time_bucket = $9::text)
 ORDER BY r.persisted_at DESC, r.run_id ASC, r.metric_code COLLATE "C" ASC, r.group_key COLLATE "C" ASC, r.id ASC
 LIMIT $10 OFFSET $11`;

export class BiMetricResultReadRepository {
  async list(ctx: TenantContext, businessId: string, filter: MetricResultFilter, page: MetricResultPage): Promise<MetricResultView[]> {
    if (typeof page !== 'object' || page === null) throw new ValidationError('MetricResultPage', ['page is required']);
    const limit = boundedInteger('limit', page.limit, RESULT_QUERY_BOUNDS.minLimit, RESULT_QUERY_BOUNDS.maxLimit);
    const offset = boundedInteger('offset', page.offset, RESULT_QUERY_BOUNDS.minOffset, RESULT_QUERY_BOUNDS.maxOffset);
    const run = filter.calculationRunId === undefined ? null : canonicalUuid(filter.calculationRunId);
    const metric = filter.metricId === undefined ? null : canonicalUuid(filter.metricId);
    if (filter.calculationRunId !== undefined && run === null) throw new ValidationError('MetricResultFilter', ['calculationRunId must be a UUID']);
    if (filter.metricId !== undefined && metric === null) throw new ValidationError('MetricResultFilter', ['metricId must be a UUID']);
    if (filter.metricCode !== undefined && !METRIC_CODE.test(filter.metricCode)) throw new ValidationError('MetricResultFilter', ['metricCode is not a valid metric code']);
    if (filter.calculationStatus !== undefined && !(RESULT_CALCULATION_STATUSES as readonly string[]).includes(filter.calculationStatus)) throw new ValidationError('MetricResultFilter', ['calculationStatus is not supported']);
    if (filter.thresholdStatus !== undefined && !(RESULT_THRESHOLD_STATUSES as readonly string[]).includes(filter.thresholdStatus)) throw new ValidationError('MetricResultFilter', ['thresholdStatus is not supported']);
    if (filter.timeBucket !== undefined && !TIME_BUCKET.test(filter.timeBucket)) throw new ValidationError('MetricResultFilter', ['timeBucket is not a valid time bucket']);

    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const rows = await client.query<Record<string, unknown>>(LIST, [
        scope.tenantId, scope.workspaceId, scope.businessId, run, metric, filter.metricCode ?? null, filter.calculationStatus ?? null, filter.thresholdStatus ?? null, filter.timeBucket ?? null, limit, offset,
      ]);
      return rows.rows.map((x): MetricResultView => ({
        metricResultId: x.id as string, calculationRunId: x.run_id as string, metricId: x.metric_definition_id as string, metricVersion: x.metric_version as number, metricCode: x.metric_code as string,
        metricType: x.metric_type as string, metricContentHash: x.metric_content_hash as string, warehouseDatasetId: x.warehouse_dataset_id as string,
        datasetVersionId: (x.dataset_version_id as string | null) ?? null, groupKey: x.group_key as string, groupDimensions: x.group_dimensions as Record<string, unknown>,
        timeBucket: (x.time_bucket as string | null) ?? null, value: (x.value as string | null) ?? null, unit: x.unit as string, currency: (x.currency as string | null) ?? null,
        target: (x.target as string | null) ?? null, thresholdStatus: x.threshold_status as string, targetMet: (x.target_met as boolean | null) ?? null,
        sourceRowCount: (x.source_row_count as number | null) ?? null, calculationStatus: x.calculation_status as string, persistedAt: x.persisted_at as Date,
      }));
    });
  }
}
