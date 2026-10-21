import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { EXECUTION_HEALTH_PERMISSION, ExecutionHealthService } from '@infinicus/business-operations-runtime';
import { executionHealthParamsSchema, executionHealthResponseSchema } from '../schemas/executionHealth.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Operations: read-only health of authorized-action execution for ONE business (L-OBS-1). It reports stranded claims (due and never
 * attempted), overdue retries, and failed/refused outcomes by reason, from BO-owned facts only. It writes nothing, drives nothing and calls no
 * ABA component; the recovery control (`execution-recoveries`) and the worker remain the only things that act.
 *
 * Requires the EXISTING permission `bo:admin` (the same operator authority as recovery and activation); no permission was invented. Tenant,
 * workspace and actor come from the authenticated context, `businessId` is a lookup key verified against it (404 for a business outside it), and
 * every query is RLS-scoped to the caller, so no other tenant's claim can appear. It is a GET: no body, no idempotency key.
 */
const errors = { 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export default async function executionHealthRoutes(app: FastifyInstance, options: { service?: ExecutionHealthService } = {}) {
  const businesses = new BusinessRepository();
  const service = options.service ?? new ExecutionHealthService();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/execution-health', {
    schema: {
      tags: ['business-operations'],
      summary: 'Read the health of authorized-action execution for this business: stranded claims, overdue retries, failed and refused outcomes by reason (requires bo:admin; read-only)',
      params: executionHealthParamsSchema, response: { 200: executionHealthResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(EXECUTION_HEALTH_PERMISSION)],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    return reply.status(200).send(await service.getHealth(request.ctx!, EXECUTION_HEALTH_PERMISSION, businessId));
  });
}
