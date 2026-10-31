import { z } from 'zod';
import { RESULT_CALCULATION_STATUSES, RESULT_QUERY_BOUNDS, RESULT_THRESHOLD_STATUSES } from '@infinicus/database';

/**
 * Governed BI-10 calculation execution, run retrieval and result querying (BI-2-DEV-08). Identifiers are UUIDs (either letter case in, lower case out: the platform
 * identifier rule); every request schema is strict, so an unknown field is refused. The execute body carries NO data: only an optional metric selection and an optional
 * statement of the hand-off the caller expects. Responses are allow-lists: no tenant, workspace or storage detail.
 */
const uuid = z.string().uuid().transform((value) => value.toLowerCase());

export const biCalcBusinessParamsSchema = z.object({ businessId: uuid });
export const biCalcRunParamsSchema = z.object({ businessId: uuid, runId: uuid });

export const biCalcExecuteBodySchema = z.object({
  /** Metric ids to calculate; absent means every approved, active governed metric of the business. De-duplicated. */
  metricIds: z.array(uuid).min(1).optional().transform((v) => (v === undefined ? undefined : [...new Set(v)])),
  /** The BI-09 hand-off id the caller expects; if the registry now yields another hand-off the request is refused (409) and nothing is calculated. */
  calculationHandoffId: uuid.optional(),
}).strict().optional();

export const biMetricResultsQuerySchema = z.object({
  calculationRunId: uuid.optional(),
  metricId: uuid.optional(),
  metricCode: z.string().regex(/^[a-z0-9_]{1,128}$/).optional(),
  calculationStatus: z.enum(RESULT_CALCULATION_STATUSES).optional(),
  thresholdStatus: z.enum(RESULT_THRESHOLD_STATUSES).optional(),
  timeBucket: z.string().regex(/^(\d{4}|\d{4}-\d{2}|\d{4}-\d{2}-\d{2}|unknown)$/).optional(),
  limit: z.coerce.number().int().min(RESULT_QUERY_BOUNDS.minLimit).max(RESULT_QUERY_BOUNDS.maxLimit).default(20),
  offset: z.coerce.number().int().min(RESULT_QUERY_BOUNDS.minOffset).max(RESULT_QUERY_BOUNDS.maxOffset).default(0),
}).strict();

const dataset = z.object({
  warehouseDatasetId: z.string().uuid(),
  /** The sealed warehouse dataset version the run read. */
  datasetVersionId: z.string().uuid(),
  rowCount: z.number().int(),
  rowsFingerprint: z.string(),
  sealDigest: z.string(),
});

const runBase = {
  calculationRunId: z.string().uuid(),
  calculationHandoffId: z.string().uuid(),
  warehouseSnapshotId: z.string().nullable(),
  correlationId: z.string(),
  /** The stored creation time of the newest handed-over metric version (BI-09). Not a calculation time. */
  handoffSourceTimestamp: z.string(),
  /** When the run was stored: the database clock. */
  persistedAt: z.string(),
  metricCount: z.number().int(),
  resultCount: z.number().int(),
  status: z.literal('completed'),
  datasets: z.array(dataset),
};
export const biCalcExecuteResponseSchema = z.object({ ...runBase, replayed: z.boolean() });
export const biCalcRunResponseSchema = z.object(runBase);

const result = z.object({
  metricResultId: z.string().uuid(),
  calculationRunId: z.string().uuid(),
  metricId: z.string().uuid(),
  metricVersion: z.number().int(),
  metricCode: z.string(),
  metricType: z.string(),
  metricContentHash: z.string(),
  warehouseDatasetId: z.string().uuid(),
  datasetVersionId: z.string().uuid().nullable(),
  groupKey: z.string(),
  group: z.object({ dimensions: z.record(z.string(), z.unknown()), timeBucket: z.string().nullable() }),
  /** Canonical decimal text, or null when there was nothing to calculate. */
  value: z.string().nullable(),
  unit: z.string(),
  currency: z.string().nullable(),
  target: z.string().nullable(),
  threshold: z.object({ status: z.enum(RESULT_THRESHOLD_STATUSES), targetMet: z.boolean().nullable() }),
  sourceRowCount: z.number().int().nullable(),
  calculationStatus: z.enum(RESULT_CALCULATION_STATUSES),
  persistedAt: z.string(),
});
export const biMetricResultsResponseSchema = z.object({ results: z.array(result), limit: z.number().int(), offset: z.number().int() });
