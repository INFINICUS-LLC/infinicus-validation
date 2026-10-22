import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { financialReportParamsSchema, financialReportQuerySchema, financialReportResponseSchema } from '../schemas/financialIntelligence.js';
import { errorResponseSchema } from '../schemas/common.js';
import { buildFinancialIntelligenceService, type FinancialIntelligenceCompositionOptions } from '../financialIntelligenceComposition.js';

/**
 * Business Intelligence: the financial report of ONE business for a period (NEW-BI-01). Read-only and computed on request: revenue and expenses by currency,
 * gross profit only where cost evidence supports it, a comparison with the preceding period of equal length, a trend, and the indicators Business Operations
 * recorded. It writes nothing and persists nothing; every figure is derived by Business Intelligence from read-only Business Operations facts.
 *
 * Existing permission `bi:read` (held by owner, admin, member and viewer). Tenant, workspace and actor come from the authenticated context only;
 * `businessId` is a lookup key verified against it (404 for a business outside it, indistinguishable from one that does not exist); every query is RLS-scoped.
 * A figure that evidence cannot support is returned with an explicit state, never as a fabricated value.
 */
export const FINANCIAL_REPORT_PERMISSION = 'bi:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export default async function financialIntelligenceRoutes(app: FastifyInstance, options: FinancialIntelligenceCompositionOptions = {}) {
  const service = options.service ?? buildFinancialIntelligenceService();
  const businesses = new BusinessRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/intelligence/financial-report', {
    schema: {
      tags: ['business-intelligence'],
      summary: 'Financial report of a business for a period: revenue, expenses, gross profit where evidenced, comparison and trend, per currency (requires bi:read; read-only)',
      params: financialReportParamsSchema, querystring: financialReportQuerySchema, response: { 200: financialReportResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission(FINANCIAL_REPORT_PERMISSION)],
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
