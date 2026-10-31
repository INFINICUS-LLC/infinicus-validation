import { z } from 'zod';
import { METRIC_AGGREGATIONS, METRIC_TYPES, PERSISTABLE_STATUSES, PERSISTABLE_TIME_GRAINS } from '@infinicus/workflow';

/**
 * BI-09 -> BI-10 calculation hand-off read API (BI-2-DEV-04). Read-only. The only input is an optional list of metric ids (repeated `metricIds`): each a UUID
 * in either letter case, canonicalized to lower case, de-duplicated; unknown query parameters are refused. The business id is a UUID path parameter. The
 * response is the hand-off contract (docs/bi-calculation-handoff-api.md) as an allow-list: no tenant or workspace id, no storage detail.
 */
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const biHandoffParamsSchema = z.object({ businessId: uuid });
export const biHandoffQuerySchema = z.object({
  metricIds: z.union([uuid, z.array(uuid)]).optional().transform((v) => (v === undefined ? undefined : [...new Set(Array.isArray(v) ? v : [v])])),
}).strict();

const metric = z.object({
  metricId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  metricType: z.enum(METRIC_TYPES),
  warehouseDatasetId: z.string().uuid(),
  sourceField: z.string().nullable(),
  aggregation: z.enum(METRIC_AGGREGATIONS).nullable(),
  dependencies: z.array(z.string()),
  formula: z.unknown().nullable(),
  filters: z.array(z.unknown()),
  dimensions: z.array(z.string()),
  timeGrain: z.enum(PERSISTABLE_TIME_GRAINS),
  unit: z.string(),
  currency: z.string().nullable(),
  target: z.number().nullable(),
  thresholds: z.record(z.string(), z.unknown()),
  owner: z.string(),
  governanceStatus: z.string(),
  version: z.number().int(),
  status: z.enum(PERSISTABLE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const biHandoffResponseSchema = z.object({
  calculationHandoffId: z.string().uuid(),
  targetBlock: z.literal('BI-10'),
  businessId: z.string().uuid(),
  warehouseSnapshotId: z.string().nullable(),
  correlationId: z.string(),
  metrics: z.array(metric),
  metricVersions: z.array(z.object({ metricId: z.string().uuid(), version: z.number().int() })),
  status: z.literal('ready'),
  createdAt: z.string(),
});
