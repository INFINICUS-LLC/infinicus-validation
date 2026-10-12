import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import type { ExecutionCapabilityActivation } from '@infinicus/database';
import { EXECUTION_ACTIVATION_PERMISSION, ExecutionActivationError, ExecutionActivationService } from '@infinicus/business-operations-runtime';
import type { ExecutionActivationServiceDependencies } from '@infinicus/business-operations-runtime';
import {
  executionActivationParamsSchema, executionActivationQuerySchema, setExecutionActivationBodySchema, executionActivationViewSchema, setExecutionActivationResponseSchema,
} from '../schemas/executionActivations.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Operations: governed activation of a supported authorized-action type for ONE business (P0-6e). BO-owned: it imports only the BO
 * runtime and the database package.
 *
 * Changing the state needs the EXISTING permission `bo:admin` ("Administer business operations configuration"; held by the owner and admin
 * roles). ABA's approval permissions are not activation permissions, and no permission was invented. Server-authoritative: tenant, workspace and
 * actor come from the authenticated context, `businessId` is a lookup key verified against it, and the body can name nothing else. Idempotent
 * (Idempotency-Key, plus an exact no-op when the state is unchanged) and audited atomically with the change.
 *
 * Enabling grants NO authorization: ABA authorization, the BO claim, the fresh authority check and the execution boundaries are all still
 * required. With no record the type is CLOSED. Nothing is activated by default and nothing is backfilled.
 */
export const EXECUTION_ACTIVATION_ROUTE_PERMISSION = EXECUTION_ACTIVATION_PERMISSION;
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export interface ExecutionActivationRouteOptions {
  dependencies?: ExecutionActivationServiceDependencies;
}

const view = (businessId: string, actionType: { code: string; schemaVersion: string }, a: ExecutionCapabilityActivation | null) => ({
  businessId, actionType, state: a?.state ?? ('NOT_ACTIVATED' as const), version: a?.version ?? null, actorUserId: a?.actorUserId ?? null,
  permissionCode: a?.permissionCode ?? null, reason: a?.reason ?? null, recordedAt: a?.recordedAt ?? null,
});

export default async function executionActivationRoutes(app: FastifyInstance, options: ExecutionActivationRouteOptions = {}) {
  const service = new ExecutionActivationService(options.dependencies);
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.put('/v1/businesses/:businessId/execution-activations', {
    schema: {
      tags: ['business-operations'],
      summary: 'Enable or disable a supported authorized-action type for this business (requires bo:admin; idempotent; audited). Enabling grants no authorization',
      params: executionActivationParamsSchema, body: setExecutionActivationBodySchema,
      response: { 200: setExecutionActivationResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(EXECUTION_ACTIVATION_ROUTE_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    try {
      const { actionType, state, reason } = request.body;
      const out = await service.setActivation(request.ctx!, EXECUTION_ACTIVATION_ROUTE_PERMISSION, { businessId, actionType, state, reason, correlationId: request.correlationId });
      return reply.status(200).send({ ...view(businessId, actionType, out.activation), changed: out.changed });
    } catch (error) {
      if (error instanceof ExecutionActivationError) {
        const status = error.code === 'ACTION_TYPE_UNSUPPORTED' || error.code === 'SUBSCRIPTIONS_INVALID' ? 409 : error.code === 'BUSINESS_NOT_IN_SCOPE' ? 404 : error.code === 'PERMISSION_INVALID' ? 403 : 400;
        return reply.status(status).send({ error: { code: error.name, message: error.message, correlationId: request.correlationId } });
      }
      throw error;
    }
  });

  server.get('/v1/businesses/:businessId/execution-activations', {
    schema: {
      tags: ['business-operations'],
      summary: 'Current activation state of an authorized-action type for this business (requires bo:read). NOT_ACTIVATED means closed',
      params: executionActivationParamsSchema, querystring: executionActivationQuerySchema,
      response: { 200: executionActivationViewSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const actionType = { code: request.query.code, schemaVersion: request.query.schemaVersion };
    return reply.status(200).send(view(businessId, actionType, await service.current(request.ctx!, businessId, actionType)));
  });
}
