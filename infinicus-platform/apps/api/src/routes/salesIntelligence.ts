import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { salesReportParamsSchema, salesReportQuerySchema, salesReportResponseSchema } from '../schemas/salesIntelligence.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildSalesIntelligenceService, type SalesIntelligenceCompositionOptions } from '../salesIntelligenceComposition.js';

/**
 * Business Intelligence: the sales and operations performance report of ONE business for a period (NEW-BI-02). Read-only and computed on request: orders,
 * revenue, average order value, units, customers (new versus returning), item mix, top products, fulfilment, order completion, a comparison with the
 * preceding period of equal length and a trend, per currency. It writes nothing and persists nothing; every figure is derived by Business Intelligence from
 * read-only Business Operations facts.
 *
 * Existing permission `bi:read`. Tenant, workspace and actor come from the authenticated context only; `businessId` is a lookup key verified against it
 * (404 for a business outside it, indistinguishable from one that does not exist); every query is RLS-scoped. A figure that evidence cannot support is
 * returned with an explicit state, never as a fabricated value.
 */
export const SALES_REPORT_PERMISSION = 'bi:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export default async function salesIntelligenceRoutes(app: FastifyInstance, options: SalesIntelligenceCompositionOptions = {}) {
  const service = options.service ?? buildSalesIntelligenceService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/intelligence/sales-report', {
    schema: {
      tags: ['business-intelligence'],
      summary: 'Sales and operations performance of a business for a period: orders, revenue, customers, products, fulfilment, comparison and trend, per currency (requires bi:read; read-only)',
      params: salesReportParamsSchema, querystring: salesReportQuerySchema, response: { 200: salesReportResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(SALES_REPORT_PERMISSION)],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId); // 404s cleanly when the business is not in this tenant and workspace
    const out = await service.report(request.ctx!, { businessId, ...request.query });
    if (out.outcome === 'UNAVAILABLE') {
      const status = out.code === 'INVALID_REQUEST' ? 400 : 500;
      return reply.status(status).send({ error: { code: out.code, message: out.detail, correlationId: request.correlationId } });
    }
    return reply.status(200).send(out.report);
  });
}
