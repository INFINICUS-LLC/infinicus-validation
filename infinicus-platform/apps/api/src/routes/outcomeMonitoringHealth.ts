import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { OUTCOME_MONITORING_HEALTH_PERMISSION, OutcomeMonitoringHealthService } from '@infinicus/outcome-monitoring-runtime';
import { outcomeMonitoringHealthParamsSchema, outcomeMonitoringHealthResponseSchema } from '../schemas/outcomeMonitoringHealth.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Outcome Monitoring: read-only health of verification for ONE business (OM-OBS-1). It reports executions awaiting an outcome, inconclusive ones,
 * failed verification attempts, missing evidence and dead-lettered notifications, from stored facts only. It is separate from execution health
 * (`execution-health`, Business Operations). It writes nothing, verifies nothing, replays nothing and informs no learning.
 *
 * Requires the EXISTING permission `bo:admin` (the same operator authority as execution health, recovery and activation); no permission was invented.
 * Tenant, workspace and actor come from the authenticated context, `businessId` is a lookup key verified against it (404 for a business outside it,
 * indistinguishable from one that does not exist), and every query is RLS-scoped to the caller. It is a GET: no body, no idempotency key.
 */
const errors = { 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export default async function outcomeMonitoringHealthRoutes(app: FastifyInstance, options: { service?: OutcomeMonitoringHealthService } = {}) {
  const businesses = new BusinessRepository();
  const service = options.service ?? new OutcomeMonitoringHealthService();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/outcome-monitoring-health', {
    schema: {
      tags: ['outcome-monitoring'],
      summary: 'Read the health of Outcome Monitoring for this business: executions awaiting outcome, inconclusive outcomes, failed verification attempts, missing evidence and dead-lettered notifications (requires bo:admin; read-only)',
      params: outcomeMonitoringHealthParamsSchema, response: { 200: outcomeMonitoringHealthResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(OUTCOME_MONITORING_HEALTH_PERMISSION)],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    return reply.status(200).send(await service.getHealth(request.ctx!, OUTCOME_MONITORING_HEALTH_PERMISSION, businessId));
  });
}
