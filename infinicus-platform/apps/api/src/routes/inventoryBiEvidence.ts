import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { inventoryBiEvidenceBodySchema, inventoryBiEvidenceParamsSchema, inventoryBiEvidenceResponseSchema } from '../schemas/inventoryBiEvidence.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildInventoryBiEvidenceService, type InventoryBiEvidenceCompositionOptions } from '../inventoryBiEvidenceComposition.js';

/**
 * Business Intelligence: publish the analytical evidence of one inventory item (AC-2 Block 5). BI owns analytical evidence, not operational mutation: this
 * route writes only BI tables (metric calculations and an insight package version) from read-only Business Operations facts. Existing permission `bi:write`,
 * active subscription, Idempotency-Key; tenant, workspace and actor from the authenticated context only. 201 = evidence published; 200 = NOT_PUBLISHED with a
 * named code (nothing persisted). It issues no recommendation, no approval, no package and executes nothing.
 */
export const INVENTORY_BI_EVIDENCE_PERMISSION = 'bi:write';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export default async function inventoryBiEvidenceRoutes(app: FastifyInstance, options: InventoryBiEvidenceCompositionOptions = {}) {
  const service = options.service ?? buildInventoryBiEvidenceService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/inventory-items/:itemId/bi-evidence', {
    schema: {
      tags: ['business-intelligence'],
      summary: 'Publish the BI evidence of an inventory item from read-only Business Operations facts (requires bi:write; idempotent; writes only BI tables)',
      params: inventoryBiEvidenceParamsSchema, body: inventoryBiEvidenceBodySchema,
      response: { 200: inventoryBiEvidenceResponseSchema, 201: inventoryBiEvidenceResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(INVENTORY_BI_EVIDENCE_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, itemId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const out = await service.publish(request.ctx!, { businessId, itemId, ruleSetVersion: request.body.ruleSetVersion, correlationId: request.correlationId });
    return reply.status(out.outcome === 'PUBLISHED' ? 201 : 200).send(out);
  });
}
