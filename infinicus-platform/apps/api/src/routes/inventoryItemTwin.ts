import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { inventoryItemTwinBodySchema, inventoryItemTwinParamsSchema, inventoryItemTwinResponseSchema } from '../schemas/inventoryItemTwin.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildInventoryItemTwinService, type InventoryItemTwinCompositionOptions } from '../inventoryItemTwinComposition.js';

/**
 * Business Digital Twin: publish the modeled current state of one inventory item (AC-2 Block 6) from the latest Business Intelligence evidence. Existing
 * permission `dt:write`, active subscription, Idempotency-Key; tenant, workspace and actor from the authenticated context only; the body carries nothing the
 * caller could assert. 201 = state published; 200 = NOT_PUBLISHED with a named code (nothing persisted). It reads no Business Operations table, mutates no
 * operational state, issues no recommendation and executes nothing.
 */
export const INVENTORY_ITEM_TWIN_PERMISSION = 'dt:write';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export default async function inventoryItemTwinRoutes(app: FastifyInstance, options: InventoryItemTwinCompositionOptions = {}) {
  const service = options.service ?? buildInventoryItemTwinService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/inventory-items/:itemId/twin-state', {
    schema: {
      tags: ['business-digital-twin'],
      summary: 'Publish the modeled current state of an inventory item from the latest BI evidence (requires dt:write; idempotent; writes only Digital Twin tables)',
      params: inventoryItemTwinParamsSchema, body: inventoryItemTwinBodySchema,
      response: { 200: inventoryItemTwinResponseSchema, 201: inventoryItemTwinResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(INVENTORY_ITEM_TWIN_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, itemId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const out = await service.publish(request.ctx!, { businessId, itemId });
    return reply.status(out.outcome === 'PUBLISHED' ? 201 : 200).send(out);
  });
}
