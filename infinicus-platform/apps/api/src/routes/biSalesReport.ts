import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { biSalesReportParamsSchema, biSalesReportQuerySchema, biSalesReportResponseSchema } from '../schemas/biSalesReport.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';
import { buildSalesReportService, type BiSalesReportCompositionOptions } from '../biSalesReportComposition.js';

/**
 * Business Intelligence: the sales report of one business over an explicit period (BI-SALES-1). Read-only and computed on read from authoritative Business
 * Operations orders; it persists nothing and mutates nothing. Existing permissions only: `bi:read` (the report is BI's) AND `bo:read` (it exposes
 * Business Operations facts). Tenant, workspace and business come from the authenticated context and the path; the business must exist in the caller's
 * workspace (404 otherwise, the same as every other business route). 200 REPORT (possibly with no currency sections when nothing was sold) or 200
 * NOT_AVAILABLE with a named code when the facts cannot be stated exactly.
 */
export const BI_SALES_REPORT_PERMISSIONS = ['bi:read', 'bo:read'] as const;
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export default async function biSalesReportRoutes(app: FastifyInstance, options: BiSalesReportCompositionOptions = {}) {
  const service = options.service ?? buildSalesReportService();
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses/:businessId/bi/sales-report', {
    schema: {
      tags: ['business-intelligence'],
      summary: 'Sales report of a business over an explicit inclusive day range (requires bi:read and bo:read; read-only; integer minor units per currency, currencies never combined)',
      params: biSalesReportParamsSchema, querystring: biSalesReportQuerySchema,
      response: { 200: biSalesReportResponseSchema, ...errors },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, ...BI_SALES_REPORT_PERMISSIONS.map((p) => app.requirePermission(p)), requireBusinessWorkspace],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const { from, to } = request.query;
    const result = await service.report(request.ctx!, { businessId, from, to });
    return reply.status(200).send(result);
  });
}
