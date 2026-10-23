import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository, GovernedMeasurementDefinitionRepository } from '@infinicus/database';
import { governedDefinitionParamsSchema, governedDefinitionResponseSchema } from '../schemas/governedMeasurementDefinitions.js';
import { errorResponseSchema } from '../schemas/common.js';

/** OM-MEASURE-2 read-only review of explicitly approved measurement definitions. Never issues a verdict. */
export default async function governedMeasurementDefinitionRoutes(app: FastifyInstance) {
  const businesses = new BusinessRepository();
  const definitions = new GovernedMeasurementDefinitionRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();
  server.get('/v1/businesses/:businessId/outcome-measurement-definitions', {
    schema: {
      tags: ['outcome-monitoring'],
      summary: 'List approved, immutable Outcome Monitoring measurement definitions for this business (bo:admin; read-only)',
      params: governedDefinitionParamsSchema,
      response: { 200: governedDefinitionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:admin')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    return reply.status(200).send({ businessId, ...await definitions.listApproved(request.ctx!, businessId) });
  });
}
