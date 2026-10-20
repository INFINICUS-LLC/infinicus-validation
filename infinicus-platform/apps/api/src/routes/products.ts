import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository, ProductRepository } from '@infinicus/database';
import {
  businessIdParamsSchema, productIdParamsSchema,
  createProductBodySchema, updateProductBodySchema,
  productResponseSchema, listProductsQuerySchema, listProductsResponseSchema,
} from '../schemas/products.js';
import { errorResponseSchema } from '../schemas/common.js';

const businesses = new BusinessRepository();
const products = new ProductRepository();

export default async function productsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/products', {
    schema: {
      tags: ['operations'],
      summary: 'Add a product/service to a business\'s catalog',
      params: businessIdParamsSchema,
      body: createProductBodySchema,
      response: { 201: productResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const product = await products.create(request.ctx!, { businessId, ...request.body });
    return reply.status(201).send(product);
  });

  server.get('/v1/businesses/:businessId/products', {
    schema: {
      tags: ['operations'],
      summary: 'List a business\'s catalog, grouped by category',
      params: businessIdParamsSchema,
      querystring: listProductsQuerySchema,
      response: { 200: listProductsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await products.list(request.ctx!, businessId, !request.query.includeInactive);
    return reply.status(200).send({ products: list });
  });

  server.patch('/v1/businesses/:businessId/products/:productId', {
    schema: {
      tags: ['operations'],
      summary: 'Update a catalog product (price, name, category, icon, active)',
      params: productIdParamsSchema,
      body: updateProductBodySchema,
      response: { 200: productResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, productId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const product = await products.update(request.ctx!, productId, request.body, businessId);
    return reply.status(200).send(product);
  });
}
