import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { InventoryPolicyEvaluationService, type InventoryPolicyEvaluationDependencies } from '@infinicus/business-operations-runtime';
import {
  inventoryPolicyEvaluationParamsSchema, requestInventoryPolicyEvaluationBodySchema, inventoryPolicyEvaluationResponseSchema,
} from '../schemas/inventoryPolicyEvaluations.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Operations: request an inventory policy evaluation (P0-5 Block B2c). BO-owned: it imports only BO runtime and the database
 * package, never ABA or workflow code. Needs the existing `bo:write` permission (no new permission). Tenant, workspace and actor come from
 * the authenticated context only; `businessId` is a lookup key verified against that context. The evaluator computes every result itself
 * and the database stamps `evaluated_at`. The response is a set of evidence REFERENCES to immutable records, not an authorization:
 * ABA verifies them later through the GovernanceEvidenceVerifier port. Idempotency-Key is required (existing plugin: same key + same body
 * replays the original response, same key + different body is a conflict); a genuinely new request appends new immutable evidence.
 * This surface mutates no inventory row, emits no event, issues no package and executes nothing.
 */
export const REQUEST_EVALUATION_PERMISSION = 'bo:write';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export interface InventoryPolicyEvaluationRouteOptions {
  dependencies?: Partial<InventoryPolicyEvaluationDependencies>;
}

export default async function inventoryPolicyEvaluationRoutes(app: FastifyInstance, options: InventoryPolicyEvaluationRouteOptions = {}) {
  const service = new InventoryPolicyEvaluationService(options.dependencies);
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/inventory-policy-evaluations', {
    schema: {
      tags: ['business-operations'],
      summary: 'Evaluate a proposed inventory reorder policy against the approved rule set and append the authoritative evaluation records (requires bo:write; idempotent; audited). Returns evidence references, not an authorization',
      params: inventoryPolicyEvaluationParamsSchema, body: requestInventoryPolicyEvaluationBodySchema,
      response: { 201: inventoryPolicyEvaluationResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(REQUEST_EVALUATION_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const outcome = await service.evaluate(
      request.ctx!,
      { businessId, ...request.body, correlationId: request.correlationId },
      REQUEST_EVALUATION_PERMISSION,
    );
    return reply.status(201).send({
      businessId, subjectDigest: outcome.subjectDigest, ruleSetVersion: outcome.ruleSetVersion, snapshotDigest: outcome.snapshotDigest, warehouseId: outcome.warehouseId,
      evidence: outcome.evaluations.map((e) => ({ kind: 'bo_inventory_policy_evaluation' as const, id: e.id, dimension: e.dimension as 'CONSTRAINTS', result: e.result as 'PASSED', evaluatedAt: e.evaluatedAt })),
    });
  });
}
