import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { buildReorderPolicyRecommendationProducer, type ReorderRecommendationCompositionOptions } from '../reorderPolicyRecommendationComposition.js';
import { reorderPolicyRecommendationParamsSchema, reorderPolicyRecommendationResponseSchema } from '../schemas/reorderPolicyRecommendation.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * ADI: produce the structured recommendation for `inventory_reorder_policy_update@1` for ONE inventory item (AC-1). Needs the existing
 * `adi:write` permission and BO's `bo:write` (it appends the BO evaluation facts the proposal cites). It authorizes nothing and executes nothing: the response is a published ADI recommendation that Approved Business
 * Action may review, approve, modify or reject. 201 = a recommendation was produced and persisted; 200 = NO recommendation (the reason is
 * named and nothing was persisted). Tenant, workspace and actor come from the authenticated context only.
 */
export const REORDER_RECOMMENDATION_PERMISSION = 'adi:write';
/** The route also appends Business Operations evaluation facts (the proposal's authoritative baseline), so it requires BO's own write permission too. */
export const REORDER_RECOMMENDATION_BO_PERMISSION = 'bo:write';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export default async function reorderPolicyRecommendationRoutes(app: FastifyInstance, options: ReorderRecommendationCompositionOptions = {}) {
  const producer = buildReorderPolicyRecommendationProducer(options);
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/inventory-items/:itemId/reorder-policy-recommendation', {
    schema: {
      tags: ['decisions'],
      summary: 'Produce the structured ADI recommendation for the reorder policy of one inventory item (requires adi:write and bo:write; rule-derived from authoritative Business Operations facts, with BO evaluation evidence recorded for exactly the proposal; authorizes and executes nothing)',
      params: reorderPolicyRecommendationParamsSchema,
      response: { 200: reorderPolicyRecommendationResponseSchema, 201: reorderPolicyRecommendationResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(REORDER_RECOMMENDATION_PERMISSION), app.requirePermission(REORDER_RECOMMENDATION_BO_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, itemId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const result = await producer.produce(request.ctx!, { businessId, itemId }, { permissionUsed: REORDER_RECOMMENDATION_BO_PERMISSION });
    return reply.status(result.outcome === 'RECOMMENDED' ? 201 : 200).send(result as never);
  });
}
