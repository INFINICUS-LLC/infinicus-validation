import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrinterRepository } from '@infinicus/database';
import {
  businessIdParamsSchema, printerIdParamsSchema, createPrinterBodySchema, printerResponseSchema, listPrintersResponseSchema,
} from '../schemas/printers.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

const printers = new PrinterRepository();

/**
 * POS-8b printer registry. Declaring, changing the default and retiring printers is business configuration, so it needs the EXISTING permission `bo:admin`
 * (owner and admin) and an Idempotency-Key; reading the list needs `bo:read`. The registry holds no network/Bluetooth/USB address: that stays on the
 * device (see the device shell contract).
 */
export default async function printersRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const admin = [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:admin'), app.requireActiveSubscription(), requireBusinessWorkspace, app.requireIdempotencyKey];

  server.post('/v1/businesses/:businessId/printers', {
    schema: {
      tags: ['operations'],
      summary: 'Declare a printer for a business (requires bo:admin; the first active printer of a kind becomes its default)',
      params: businessIdParamsSchema,
      body: createPrinterBodySchema,
      response: { 201: printerResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: admin,
  }, async (request, reply) => {
    const created = await printers.create(request.ctx!, { businessId: request.params.businessId, createdBy: request.ctx!.userId, ...request.body });
    return reply.status(201).send(created);
  });

  server.get('/v1/businesses/:businessId/printers', {
    schema: {
      tags: ['operations'],
      summary: 'List the printers declared for a business (active first, then retired)',
      params: businessIdParamsSchema,
      response: { 200: listPrintersResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace],
  }, async (request, reply) => reply.status(200).send({ printers: await printers.list(request.ctx!, request.params.businessId) }));

  server.post('/v1/businesses/:businessId/printers/:printerId/default', {
    schema: {
      tags: ['operations'],
      summary: 'Make an active printer the default of its kind (requires bo:admin)',
      params: printerIdParamsSchema,
      response: { 200: printerResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: admin,
  }, async (request, reply) => reply.status(200).send(await printers.setDefault(request.ctx!, request.params.businessId, request.params.printerId)));

  server.post('/v1/businesses/:businessId/printers/:printerId/retire', {
    schema: {
      tags: ['operations'],
      summary: 'Retire a printer; it is kept for history and is never the default again (requires bo:admin)',
      params: printerIdParamsSchema,
      response: { 200: printerResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: admin,
  }, async (request, reply) => reply.status(200).send(await printers.retire(request.ctx!, request.params.businessId, request.params.printerId)));
}
