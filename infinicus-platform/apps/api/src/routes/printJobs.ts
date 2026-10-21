import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrintJobRepository, PrinterRepository } from '@infinicus/database';
import {
  orderParamsSchema, businessParamsSchema, listPrintJobsQuerySchema, recordPrintJobBodySchema,
  printJobResponseSchema, listPrintJobsResponseSchema, printRoutesResponseSchema,
} from '../schemas/printJobs.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

const printJobs = new PrintJobRepository();
const printers = new PrinterRepository();

/**
 * POS-8c: the print-job log and print routing. The counter records how each print attempt ended (append-only, no content); a cashier can record (`bo:write`,
 * Idempotency-Key), anyone who can read business operations can read. `print-routes` tells the counter which registered printer, if any, each kind of
 * print goes to (the active default of the kind); with none, the browser's own print path is used.
 */
export default async function printJobsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const read = [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace];

  server.post('/v1/businesses/:businessId/orders/:orderId/print-jobs', {
    schema: {
      tags: ['operations'],
      summary: 'Record how a print attempt for an order ended (append-only; a receipt only for a completed order, a kitchen ticket not for a voided one)',
      params: orderParamsSchema,
      body: recordPrintJobBodySchema,
      response: { 201: printJobResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), requireBusinessWorkspace, app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId } = request.params;
    const job = await printJobs.record(request.ctx!, { businessId, orderId, createdBy: request.ctx!.userId, ...request.body });
    return reply.status(201).send(job);
  });

  server.get('/v1/businesses/:businessId/orders/:orderId/print-jobs', {
    schema: {
      tags: ['operations'], summary: 'Print attempts for one order, newest first',
      params: orderParamsSchema,
      response: { 200: listPrintJobsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: read,
  }, async (request, reply) => reply.status(200).send({ printJobs: await printJobs.list(request.ctx!, request.params.businessId, { orderId: request.params.orderId }) }));

  server.get('/v1/businesses/:businessId/print-jobs', {
    schema: {
      tags: ['operations'], summary: 'Recent print attempts for a business, newest first',
      params: businessParamsSchema, querystring: listPrintJobsQuerySchema,
      response: { 200: listPrintJobsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: read,
  }, async (request, reply) => reply.status(200).send({ printJobs: await printJobs.list(request.ctx!, request.params.businessId, { limit: request.query.limit }) }));

  server.get('/v1/businesses/:businessId/print-routes', {
    schema: {
      tags: ['operations'], summary: 'The printer each kind of print goes to (the active default of its kind), or null',
      params: businessParamsSchema,
      response: { 200: printRoutesResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: read,
  }, async (request, reply) => reply.status(200).send(await printers.routes(request.ctx!, request.params.businessId)));
}
