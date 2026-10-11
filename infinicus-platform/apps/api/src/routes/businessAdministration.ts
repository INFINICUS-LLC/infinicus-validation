import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessDeclaredCurrencyService } from '@infinicus/onboarding';
import type { BusinessDeclaredCurrencyDependencies } from '@infinicus/onboarding';
import { BusinessRepository, type DeclaredCurrencyRecord } from '@infinicus/database';
import {
  declaredCurrencyParamsSchema, declareCurrencyBodySchema, declareCurrencyResponseSchema, declaredCurrencyViewSchema,
  declaredCurrencyHistoryResponseSchema,
} from '../schemas/businessAdministration.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * Business Administration: a business's DECLARED CURRENCY (the governed currency used for governance and cost evaluation).
 *
 * Declaring or changing it needs `platform:admin` - the existing tenant/workspace administration permission (owner role; the `admin` role
 * deliberately does not hold it). No new permission was invented; reads need `bo:read`, like the business record itself. Tenant, workspace
 * and actor come from the authenticated context only. Every mutation is idempotent (Idempotency-Key header, plus an exact-replay no-op in
 * the service) and audited atomically with the change.
 */
export const DECLARE_CURRENCY_PERMISSION = 'platform:admin';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };
const view = (r: DeclaredCurrencyRecord) => ({
  declarationId: r.declarationId, version: r.version, currency: r.currency, priorCurrency: r.priorCurrency, supersedesVersion: r.supersedesVersion,
  provenance: r.provenance, declaredByUserId: r.declaredByUserId, permissionUsed: r.permissionUsed, reason: r.reason, correlationId: r.correlationId,
  declaredAt: r.declaredAt,
});

export interface BusinessAdministrationRouteOptions {
  dependencies?: Partial<BusinessDeclaredCurrencyDependencies>;
}

export default async function businessAdministrationRoutes(app: FastifyInstance, options: BusinessAdministrationRouteOptions = {}) {
  const service = new BusinessDeclaredCurrencyService(options.dependencies);
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.put('/v1/businesses/:businessId/declared-currency', {
    schema: {
      tags: ['business-administration'],
      summary: 'Declare (or explicitly change) the business\'s governed currency (requires platform:admin; idempotent; audited; a change needs expectedVersion and a reason)',
      params: declaredCurrencyParamsSchema, body: declareCurrencyBodySchema,
      response: { 200: declareCurrencyResponseSchema, 201: declareCurrencyResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(DECLARE_CURRENCY_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const result = await service.declare(
      request.ctx!, { permissionUsed: DECLARE_CURRENCY_PERMISSION, correlationId: request.correlationId },
      { businessId: request.params.businessId, currency: request.body.currency, expectedVersion: request.body.expectedVersion, ...(request.body.reason === undefined ? {} : { reason: request.body.reason }) },
    );
    return reply.status(result.outcome === 'UNCHANGED' ? 200 : 201).send({ outcome: result.outcome, businessId: request.params.businessId, declaration: view(result.declaration) });
  });

  server.get('/v1/businesses/:businessId/declared-currency', {
    schema: {
      tags: ['business-administration'],
      summary: 'Read the business\'s declared currency, or UNDECLARED (requires bo:read; never returns a default)',
      params: declaredCurrencyParamsSchema, response: { 200: declaredCurrencyViewSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    await businesses.getById(request.ctx!, request.params.businessId);
    const state = await service.getCurrent(request.ctx!, request.params.businessId);
    return reply.status(200).send({
      status: state.status, businessId: state.businessId, declaration: state.status === 'DECLARED' ? view(state.current) : null,
    });
  });

  server.get('/v1/businesses/:businessId/declared-currency/history', {
    schema: {
      tags: ['business-administration'],
      summary: 'Read the business\'s declared-currency history, oldest first (requires bo:read)',
      params: declaredCurrencyParamsSchema, response: { 200: declaredCurrencyHistoryResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    await businesses.getById(request.ctx!, request.params.businessId);
    const items = await service.history(request.ctx!, request.params.businessId);
    return reply.status(200).send({ businessId: request.params.businessId, items: items.map(view) });
  });
}
