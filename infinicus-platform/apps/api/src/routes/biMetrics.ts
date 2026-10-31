import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BiMetricRegistryReadRepository, type GovernedMetricView } from '@infinicus/database';
import type { MetricAggregation, MetricType } from '@infinicus/workflow';
import type { PERSISTABLE_STATUSES, PERSISTABLE_TIME_GRAINS } from '@infinicus/workflow';
import {
  biMetricBusinessParamsSchema, biMetricParamsSchema, biMetricListQuerySchema, biMetricDetailQuerySchema, biMetricListResponseSchema, biMetricDetailResponseSchema,
} from '../schemas/biMetrics.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

/**
 * BI-09 governed metric registry read API (BI-2-DEV-03): the metric and KPI definitions that Business Intelligence has registered and versioned.
 *
 * Two GET routes and nothing else: there is no create, update, delete or approval endpoint (registration stays a service). Existing permission `bi:read` only.
 * Tenant and workspace come from the authenticated context; the business must exist in the caller's workspace (404 otherwise); a metric id of another
 * business, workspace or tenant is a 404 exactly like one that does not exist. Only governed definitions are visible. A metric's domain is its dataset's domain.
 * Reads business_intelligence only. Nothing is calculated here (metric evaluation is BI-10).
 */
export const BI_METRIC_READ_PERMISSION = 'bi:read';
type StoredStatus = (typeof PERSISTABLE_STATUSES)[number];
type StoredTimeGrain = (typeof PERSISTABLE_TIME_GRAINS)[number];
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export interface BiMetricRoutesOptions { repository?: BiMetricRegistryReadRepository }

/** The fields common to the list and the detail, from the stored definition content and the stored (constrained) columns. */
function summaryOf(m: GovernedMetricView) {
  const c = m.content as Record<string, unknown>;
  return {
    metricId: m.metricId, code: c.code as string, name: c.name as string, metricType: c.metricType as MetricType, aggregation: (c.aggregation ?? null) as MetricAggregation | null,
    unit: c.unit as string, currency: (c.currency ?? null) as string | null, timeGrain: m.timeGrain as StoredTimeGrain, status: m.status as StoredStatus, governanceStatus: c.governanceStatus as string,
    owner: c.owner as string, version: m.latestVersion, warehouseDatasetId: m.warehouseDatasetId, domain: m.domain, updatedAt: m.updatedAt.toISOString(),
  };
}

export default async function biMetricRoutes(app: FastifyInstance, options: BiMetricRoutesOptions = {}) {
  const repository = options.repository ?? new BiMetricRegistryReadRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [app.authenticate, app.resolveTenantContext, app.requirePermission(BI_METRIC_READ_PERMISSION), requireBusinessWorkspace];

  server.get('/v1/businesses/:businessId/bi/metrics', {
    schema: { tags: ['business-intelligence'], summary: 'List the governed metric and KPI definitions of a business by code; filter by dataset, status or time grain (requires bi:read; read-only)',
      params: biMetricBusinessParamsSchema, querystring: biMetricListQuerySchema, response: { 200: biMetricListResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId } = request.params; const { datasetId, status, timeGrain, limit, offset } = request.query;
    const rows = await repository.list(request.ctx!, businessId, { datasetId, status, timeGrain }, { limit, offset });
    return reply.status(200).send({ metrics: rows.map(summaryOf), limit, offset });
  });

  server.get('/v1/businesses/:businessId/bi/metrics/:metricId', {
    schema: { tags: ['business-intelligence'], summary: 'One governed metric definition at its latest version, with its newest versions (requires bi:read; read-only)',
      params: biMetricParamsSchema, querystring: biMetricDetailQuerySchema, response: { 200: biMetricDetailResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId, metricId } = request.params;
    const m = await repository.get(request.ctx!, businessId, metricId, request.query.versionLimit);
    const c = m.content as Record<string, unknown>;
    return reply.status(200).send({
      ...summaryOf(m),
      description: c.description as string, sourceField: (c.sourceField ?? null) as string | null, dependencies: c.dependencies as string[], dimensions: c.dimensions as string[],
      filters: c.filters as unknown[], formula: c.formula ?? null, target: (c.target ?? null) as number | null, thresholds: c.thresholds as Record<string, unknown>,
      contentHash: m.contentHash, createdAt: m.createdAt.toISOString(),
      versions: m.versions.map((v) => ({ version: v.versionNumber, contentHash: v.contentHash, governanceStatus: v.governanceStatus, timeGrain: v.timeGrain as StoredTimeGrain, createdAt: v.createdAt.toISOString() })),
    });
  });
}
