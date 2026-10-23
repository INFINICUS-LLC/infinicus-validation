import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import {
  businessPerformanceTwinBodySchema, businessPerformanceTwinLatestResponseSchema, businessPerformanceTwinParamsSchema, businessPerformanceTwinPublishResponseSchema,
  businessPerformanceTwinQuerySchema,
} from '../schemas/businessPerformanceTwin.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildBusinessPerformanceTwinService, type BusinessPerformanceTwinCompositionOptions } from '../businessPerformanceTwinComposition.js';

/**
 * Business Digital Twin: represent the governed Business Intelligence financial and sales evidence of one reporting period (NEW-BDT-01).
 * POST publishes the twin state: existing permission `dt:write`, active subscription, Idempotency-Key; 201 = published, 200 = NOT_PUBLISHED with a named code
 * (nothing persisted), 400 = an invalid reporting period. GET reads the newest published state (existing `dt:read`) and re-verifies its integrity digest.
 * Tenant, workspace and actor come from the authenticated context only; the body carries the period and nothing the caller could assert. It reads no Business
 * Operations table, derives no KPI, mutates no operational state, issues no recommendation and executes nothing.
 */
export const BUSINESS_PERFORMANCE_TWIN_WRITE_PERMISSION = 'dt:write';
export const BUSINESS_PERFORMANCE_TWIN_READ_PERMISSION = 'dt:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export default async function businessPerformanceTwinRoutes(app: FastifyInstance, options: BusinessPerformanceTwinCompositionOptions = {}) {
  const service = options.service ?? buildBusinessPerformanceTwinService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/twin/business-performance', {
    schema: {
      tags: ['business-digital-twin'],
      summary: 'Publish the Digital Twin representation of the BI financial and sales evidence of a reporting period (requires dt:write; idempotent; writes only Digital Twin tables)',
      params: businessPerformanceTwinParamsSchema, body: businessPerformanceTwinBodySchema,
      response: { 200: businessPerformanceTwinPublishResponseSchema, 201: businessPerformanceTwinPublishResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(BUSINESS_PERFORMANCE_TWIN_WRITE_PERMISSION), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const out = await service.publish(request.ctx!, { businessId, ...request.body });
    if (out.outcome === 'NOT_PUBLISHED' && out.code === 'INVALID_REQUEST') {
      return reply.status(400).send({ error: { code: out.code, message: out.detail, correlationId: request.correlationId } });
    }
    return reply.status(out.outcome === 'PUBLISHED' ? 201 : 200).send(out);
  });

  server.get('/v1/businesses/:businessId/twin/business-performance', {
    schema: {
      tags: ['business-digital-twin'],
      summary: 'The newest published business performance twin state (optionally of one reporting period), with its integrity re-verified (requires dt:read)',
      params: businessPerformanceTwinParamsSchema, querystring: businessPerformanceTwinQuerySchema,
      response: { 200: businessPerformanceTwinLatestResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(BUSINESS_PERFORMANCE_TWIN_READ_PERMISSION)],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const { from, to } = request.query;
    const latest = await service.getLatest(request.ctx!, businessId, from !== undefined && to !== undefined ? { from, to } : undefined);
    if (latest === null) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no business performance twin state has been published', correlationId: request.correlationId } });
    return reply.status(200).send(latest);
  });
}
