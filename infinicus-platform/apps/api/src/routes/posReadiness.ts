import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PosReadinessService } from '@infinicus/business-operations-runtime';
import { posReadinessParamsSchema, posReadinessResponseSchema } from '../schemas/posReadiness.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

const readiness = new PosReadinessService();

/**
 * POS readiness (POS2-03): a READ-ONLY report of whether a business is configured to sell. It is deliberately not gated by a POS entitlement or by the
 * subscription: readiness is about configuration, billing is a separate question, and reads of the customer's own records stay available. It needs
 * `bo:read` and a business in the caller's workspace. Nothing is written, activated or changed by calling it, and no other route consults it yet.
 */
export default async function posReadinessRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/pos-readiness', {
    schema: {
      tags: ['operations'],
      summary: 'Whether the business is operationally configured to use POS (read-only; independent of billing entitlement)',
      params: posReadinessParamsSchema,
      response: { 200: posReadinessResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace],
  }, async (request, reply) => {
    const result = await readiness.evaluate(request.ctx!, request.params.businessId);
    return reply.status(200).send(result);
  });
}
