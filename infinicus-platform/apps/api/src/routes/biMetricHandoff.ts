import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BiConflictError, BiNotFoundError } from '@infinicus/database';
import { BusinessIntelligenceCalculationHandoffService, type CalculationHandoff, type PERSISTABLE_STATUSES, type PERSISTABLE_TIME_GRAINS } from '@infinicus/workflow';
import { biHandoffParamsSchema, biHandoffQuerySchema, biHandoffResponseSchema } from '../schemas/biMetricHandoff.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

/**
 * BI-09 -> BI-10 calculation hand-off read API (BI-2-DEV-04): the approved, active governed metrics of a business, at their latest versions, in the shape
 * Business Intelligence calculation (BI-10) receives. One GET and nothing else. Existing permission `bi:read` only. Tenant and workspace come from the
 * authenticated context; the business must exist in the caller's workspace (404 otherwise). The hand-off identity is derived from the hand-off content, so
 * the same registry state returns the same id on every call; nothing is stored, written or calculated here (calculation is BI-10).
 *
 * Error mapping (stable, sanitized): invalid input 400 (schema) - unknown or other-scope metric or business 404 - a metric that is not approved and active,
 * a dependency outside the hand-off, or nothing to hand over 409 - anything else 500 with a generic body.
 */
type StoredStatus = (typeof PERSISTABLE_STATUSES)[number];
type StoredTimeGrain = (typeof PERSISTABLE_TIME_GRAINS)[number];
export const BI_HANDOFF_READ_PERMISSION = 'bi:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export interface BiMetricHandoffRoutesOptions { service?: BusinessIntelligenceCalculationHandoffService }

/** The wire form of a hand-off: the contract fields plus the business id; the tenant and workspace of the internal scope are not exposed. */
function wire(h: CalculationHandoff) {
  return {
    calculationHandoffId: h.calculationHandoffId,
    targetBlock: h.targetBlock,
    businessId: h.scope.businessId,
    warehouseSnapshotId: h.warehouseSnapshotId,
    correlationId: h.correlationId,
    // time grain and status are CHECK-constrained columns of the stored registry; the service takes them from those columns, not from free text
    metrics: h.metrics.map(({ scope: _scope, ...m }) => ({ ...m, timeGrain: m.timeGrain as StoredTimeGrain, status: m.status as StoredStatus })),
    metricVersions: h.metricVersions,
    status: h.status,
    createdAt: h.createdAt,
  };
}

export default async function biMetricHandoffRoutes(app: FastifyInstance, options: BiMetricHandoffRoutesOptions = {}) {
  const service = options.service ?? new BusinessIntelligenceCalculationHandoffService();
  const server = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [app.authenticate, app.resolveTenantContext, app.requirePermission(BI_HANDOFF_READ_PERMISSION), requireBusinessWorkspace];

  server.get('/v1/businesses/:businessId/bi/metric-handoff', {
    schema: { tags: ['business-intelligence'], summary: 'The BI-09 to BI-10 calculation hand-off of the approved, active governed metrics of a business (requires bi:read; read-only, nothing stored)',
      params: biHandoffParamsSchema, querystring: biHandoffQuerySchema, response: { 200: biHandoffResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId } = request.params;
    const result = await service.calculationHandoff(request.ctx!, businessId, { ...(request.query.metricIds ? { metricIds: request.query.metricIds } : {}), correlationId: request.correlationId });
    if (result.ok) return reply.status(200).send(wire(result.handoff));
    switch (result.code) {
      case 'METRIC_NOT_FOUND': throw new BiNotFoundError('Metric', 'in this business');
      case 'METRIC_NOT_APPROVED': throw new BiConflictError('CalculationHandoff', 'a selected metric is not an approved active metric');
      case 'NO_METRICS_SELECTED': throw new BiConflictError('CalculationHandoff', 'there is no approved active metric to hand over');
      case 'HANDOFF_INVALID': throw new BiConflictError('CalculationHandoff', 'a selected metric depends on a metric that is not part of the hand-off');
      default: throw new Error('calculation hand-off could not be built');
    }
  });
}
