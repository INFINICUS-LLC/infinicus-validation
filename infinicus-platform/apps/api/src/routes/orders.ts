import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository, OrderRepository } from '@infinicus/database';
import {
  businessIdParamsSchema, orderIdParamsSchema, lineItemIdParamsSchema,
  createOrderBodySchema, addLineItemBodySchema, completeOrderBodySchema, voidOrderBodySchema,
  orderResponseSchema, listOrdersQuerySchema, listOrdersResponseSchema,
  updateLineQuantityBodySchema,
} from '../schemas/orders.js';
import { errorResponseSchema } from '../schemas/common.js';

const businesses = new BusinessRepository();
const orders = new OrderRepository();

export default async function ordersRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/orders', {
    schema: {
      tags: ['operations'],
      summary: 'Start a new order (cart) for a business',
      params: businessIdParamsSchema,
      body: createOrderBodySchema,
      response: { 201: orderResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.create(request.ctx!, { businessId, ...request.body });
    return reply.status(201).send(order);
  });

  server.get('/v1/businesses/:businessId/orders', {
    schema: {
      tags: ['operations'],
      summary: 'List orders for a business',
      params: businessIdParamsSchema,
      querystring: listOrdersQuerySchema,
      response: { 200: listOrdersResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await orders.list(request.ctx!, businessId, request.query);
    return reply.status(200).send({ orders: list });
  });

  server.get('/v1/businesses/:businessId/orders/:orderId', {
    schema: {
      tags: ['operations'],
      summary: 'Get an order with its line items',
      params: orderIdParamsSchema,
      response: { 200: orderResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    const { businessId, orderId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.getById(request.ctx!, orderId, businessId);
    return reply.status(200).send(order);
  });

  server.post('/v1/businesses/:businessId/orders/:orderId/line-items', {
    schema: {
      tags: ['operations'],
      summary: 'Add a line item to an open order',
      params: orderIdParamsSchema,
      body: addLineItemBodySchema,
      response: {
        200: orderResponseSchema,
        401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.addLineItem(request.ctx!, orderId, businessId, request.body);
    return reply.status(200).send(order);
  });

  server.delete('/v1/businesses/:businessId/orders/:orderId/line-items/:lineItemId', {
    schema: {
      tags: ['operations'],
      summary: 'Remove a line item from an open order',
      params: lineItemIdParamsSchema,
      response: {
        200: orderResponseSchema,
        401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId, lineItemId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.removeLineItem(request.ctx!, orderId, lineItemId, businessId);
    return reply.status(200).send(order);
  });

  server.post('/v1/businesses/:businessId/orders/:orderId/line-items/:lineItemId/quantity', {
    schema: {
      tags: ['operations'],
      summary: 'Set the quantity of a line in an open order',
      params: lineItemIdParamsSchema,
      body: updateLineQuantityBodySchema,
      response: { 200: orderResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId, lineItemId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.updateLineQuantity(request.ctx!, orderId, lineItemId, businessId, request.body.quantity);
    return reply.status(200).send(order);
  });

  server.post('/v1/businesses/:businessId/orders/:orderId/complete', {
    schema: {
      tags: ['operations'],
      summary: 'Complete an order with its tender — records the sale and the payments and locks the order for editing',
      params: orderIdParamsSchema,
      body: completeOrderBodySchema,
      response: {
        200: orderResponseSchema,
        400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.complete(request.ctx!, orderId, businessId, request.body.payments);
    return reply.status(200).send(order);
  });

  server.post('/v1/businesses/:businessId/orders/:orderId/void', {
    schema: {
      tags: ['operations'],
      summary: 'Void an order before it is completed',
      params: orderIdParamsSchema,
      body: voidOrderBodySchema,
      response: {
        200: orderResponseSchema,
        401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, orderId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const order = await orders.void(request.ctx!, orderId, businessId, request.body.reason);
    return reply.status(200).send(order);
  });
}
