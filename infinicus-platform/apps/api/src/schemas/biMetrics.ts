import { z } from 'zod';
import { METRIC_AGGREGATIONS, METRIC_TYPES, PERSISTABLE_STATUSES, PERSISTABLE_TIME_GRAINS } from '@infinicus/workflow';

/**
 * BI-09 governed metric registry read API (BI-2-DEV-03). Read-only. Identifiers are UUIDs (a malformed one is a 400 before any query); unknown query
 * parameters are refused; filters are limited to the dataset a metric is defined on, its status and its time grain, each using the values the persisted
 * registry can hold. Responses are allow-lists: no tenant, workspace, correlation or storage details.
 */
const status = z.enum(PERSISTABLE_STATUSES);
const timeGrain = z.enum(PERSISTABLE_TIME_GRAINS);
const page = { limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100_000).default(0) };

export const biMetricBusinessParamsSchema = z.object({ businessId: z.string().uuid() });
export const biMetricParamsSchema = z.object({ businessId: z.string().uuid(), metricId: z.string().uuid() });
export const biMetricListQuerySchema = z.object({ datasetId: z.string().uuid().optional(), status: status.optional(), timeGrain: timeGrain.optional(), ...page }).strict();
export const biMetricDetailQuerySchema = z.object({ versionLimit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

const summary = z.object({
  metricId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  metricType: z.enum(METRIC_TYPES),
  aggregation: z.enum(METRIC_AGGREGATIONS).nullable(),
  unit: z.string(),
  currency: z.string().nullable(),
  timeGrain,
  status,
  governanceStatus: z.string(),
  owner: z.string(),
  version: z.number().int(),
  warehouseDatasetId: z.string().uuid(),
  domain: z.string(),
  updatedAt: z.string(),
});

export const biMetricListResponseSchema = z.object({ metrics: z.array(summary), limit: z.number().int(), offset: z.number().int() });

export const biMetricDetailResponseSchema = summary.extend({
  description: z.string(),
  sourceField: z.string().nullable(),
  dependencies: z.array(z.string()),
  dimensions: z.array(z.string()),
  filters: z.array(z.unknown()),
  formula: z.unknown().nullable(),
  target: z.number().nullable(),
  thresholds: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  createdAt: z.string(),
  versions: z.array(z.object({ version: z.number().int(), contentHash: z.string(), governanceStatus: z.string(), timeGrain, createdAt: z.string() })),
});
