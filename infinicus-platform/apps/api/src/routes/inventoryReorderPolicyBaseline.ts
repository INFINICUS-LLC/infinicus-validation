import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BusinessRepository } from '@infinicus/database';
import { InventoryReorderPolicyService, ReorderBaselineChangedError, ReorderPolicyAlreadyConfiguredError, OperationalMappingError } from '@infinicus/business-operations-runtime';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Operations: state the FIRST reorder policy of an inventory balance (AC-2, owner ruling D2). Business Operations owns operational policy; Data
 * Acquisition never sets it, so a balance created by intake starts UNSET at 0/0. This route configures it exactly once: it is refused (409) when the
 * balance is already CONFIGURED, so changing an existing policy remains an authorized action (ABA package -> BO execution). It uses the EXISTING
 * permission `bo:admin` (owner/admin), requires an Idempotency-Key, takes tenant/workspace/actor from the authenticated context only, and commits the
 * change with its audit record atomically. Values must be positive and are never rounded (at most four decimals).
 */
export const INITIAL_REORDER_POLICY_PERMISSION = 'bo:admin';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

const paramsSchema = z.object({ businessId: z.string().uuid(), itemId: z.string().uuid(), warehouseId: z.string().uuid() });
const bodySchema = z.object({ reorderPoint: z.number().positive().finite(), reorderQuantity: z.number().positive().finite() }).strict();
const snapshot = z.object({ reorderPoint: z.string(), reorderQuantity: z.string(), state: z.enum(['UNSET', 'CONFIGURED']), version: z.number().int() });
const responseSchema = z.object({
  businessId: z.string().uuid(), inventoryItemId: z.string().uuid(), warehouseId: z.string().uuid(), balanceId: z.string().uuid(), applied: z.boolean(), before: snapshot, after: snapshot,
});

export default async function inventoryReorderPolicyBaselineRoutes(app: FastifyInstance) {
  const service = new InventoryReorderPolicyService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.put('/v1/businesses/:businessId/inventory-items/:itemId/warehouses/:warehouseId/initial-reorder-policy', {
    schema: {
      tags: ['business-operations'],
      summary: 'State the first reorder policy of an inventory balance (requires bo:admin; idempotent; audited; refused once the balance is configured)',
      params: paramsSchema, body: bodySchema, response: { 200: responseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(INITIAL_REORDER_POLICY_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, itemId, warehouseId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    try {
      const out = await service.configureInitial(request.ctx!, { businessId, inventoryItemId: itemId, warehouseId, ...request.body, correlationId: request.correlationId }, INITIAL_REORDER_POLICY_PERMISSION);
      return reply.status(200).send({ businessId, inventoryItemId: itemId, warehouseId, balanceId: out.recordId, applied: out.applied, before: out.before, after: out.after });
    } catch (error) {
      if (error instanceof ReorderPolicyAlreadyConfiguredError || error instanceof ReorderBaselineChangedError) {
        return reply.status(409).send({ error: { code: error.name, message: error.message, correlationId: request.correlationId } });
      }
      if (error instanceof OperationalMappingError) {
        return reply.status(400).send({ error: { code: error.name, message: error.message, correlationId: request.correlationId } });
      }
      throw error;
    }
  });
}
