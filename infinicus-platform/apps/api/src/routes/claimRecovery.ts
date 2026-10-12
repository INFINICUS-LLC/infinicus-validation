import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { CLAIM_RECOVERY_OPERATOR_PERMISSION, ClaimRecoveryOperatorError } from '@infinicus/business-operations-runtime';
import type { ClaimRecoveryOperatorService } from '@infinicus/business-operations-runtime';
import { claimRecoveryBodySchema, claimRecoveryParamsSchema, claimRecoveryResponseSchema } from '../schemas/claimRecovery.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Operations: interim operator recovery of stranded claims for ONE business (P0-6h). BO-owned: it imports only the BO runtime and the
 * database package; the engine and the ABA status provider are joined in the composition root (`claimRecoveryComposition.ts`), not here.
 *
 * Requires the EXISTING permission `bo:admin` and an Idempotency-Key. Server-authoritative: tenant, workspace and actor come from the
 * authenticated context, `businessId` is a lookup key verified against it, and the body cannot name a claim. It drives only claims that are
 * DUE (the worker's own 60 s / backoff rule), with fresh ABA status and authority, behind the governed gate; a terminal claim is never
 * re-driven. Refused (409) while the gate is closed. Audited as a user action before and after.
 */
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export interface ClaimRecoveryRouteOptions {
  operator: ClaimRecoveryOperatorService;
}

export default async function claimRecoveryRoutes(app: FastifyInstance, options: ClaimRecoveryRouteOptions) {
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/execution-recoveries', {
    schema: {
      tags: ['business-operations'],
      summary: 'Interim operator control: drive the due, stranded authorized-action claims of this business through the one execution engine (requires bo:admin; idempotent; audited; refused while the gate is closed)',
      params: claimRecoveryParamsSchema, body: claimRecoveryBodySchema,
      response: { 200: claimRecoveryResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(CLAIM_RECOVERY_OPERATOR_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    try {
      const { actionType, reason, limit } = request.body;
      const out = await options.operator.recover(request.ctx!, CLAIM_RECOVERY_OPERATOR_PERMISSION, { businessId, actionType, reason, ...(limit !== undefined ? { limit } : {}), correlationId: request.correlationId });
      return reply.status(200).send({ businessId, actionType, attempted: out.attempted, results: out.results });
    } catch (error) {
      if (error instanceof ClaimRecoveryOperatorError) {
        const status = error.code === 'GATE_CLOSED' || error.code === 'ACTION_TYPE_UNSUPPORTED' ? 409 : error.code === 'PERMISSION_INVALID' ? 403 : 400;
        return reply.status(status).send({ error: { code: error.name, message: error.message, correlationId: request.correlationId } });
      }
      throw error;
    }
  });
}
