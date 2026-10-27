import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { performanceSimulationHandoffBodySchema, performanceSimulationHandoffParamsSchema, performanceSimulationHandoffResponseSchema } from '../schemas/performanceSimulationHandoff.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildPerformanceSimulationHandoffService, type PerformanceSimulationHandoffCompositionOptions } from '../performanceSimulationHandoffComposition.js';

/**
 * Business Digital Twin -> Simulation: hand off the published business performance state of one reporting period as a Simulation-ready scenario baseline
 * (NEW-BDT-SIM-01). The twin publishes; Simulation's intake is Simulation's own act and is not performed here. Existing permission `dt:write`, active
 * subscription, Idempotency-Key; tenant, workspace and actor from the authenticated context only; the body carries the period and nothing the caller could
 * assert. 201 = handed off (the validated frozen DT -> SIM hand-off is returned); 200 = replay of an existing hand-off, or NOT_HANDED_OFF with a named code
 * (nothing persisted); 400 = an invalid reporting period. It writes only Digital Twin tables, derives no KPI, recommends nothing and executes nothing.
 */
export const PERFORMANCE_SIMULATION_HANDOFF_PERMISSION = 'dt:write';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export default async function performanceSimulationHandoffRoutes(app: FastifyInstance, options: PerformanceSimulationHandoffCompositionOptions = {}) {
  const service = options.service ?? buildPerformanceSimulationHandoffService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/twin/business-performance/simulation-handoff', {
    schema: {
      tags: ['business-digital-twin'],
      summary: 'Hand the published business performance state of a period to Simulation as a scenario baseline (requires dt:write; idempotent; writes only Digital Twin tables)',
      params: performanceSimulationHandoffParamsSchema, body: performanceSimulationHandoffBodySchema,
      response: { 200: performanceSimulationHandoffResponseSchema, 201: performanceSimulationHandoffResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(PERFORMANCE_SIMULATION_HANDOFF_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const out = await service.handOff(request.ctx!, { businessId, ...request.body });
    if (out.outcome === 'NOT_HANDED_OFF' && out.code === 'INVALID_REQUEST') {
      return reply.status(400).send({ error: { code: out.code, message: out.detail, correlationId: request.correlationId } });
    }
    return reply.status(out.outcome === 'HANDED_OFF' && !out.replay ? 201 : 200).send(out);
  });
}
