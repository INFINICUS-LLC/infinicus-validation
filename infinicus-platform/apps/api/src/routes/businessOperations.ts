import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessRepository } from '@infinicus/database';
import { BusinessOperationsService } from '@infinicus/business-operations-runtime';
import {
  assetsResponseSchema,
  inventoryResponseSchema,
  operationsBusinessParamsSchema,
  operationsIntakeParamsSchema,
  operationsIntakeResponseSchema,
  operationsListQuerySchema,
  operationsPeriodQuerySchema,
  operationsSummaryResponseSchema,
  procurementListQuerySchema,
  procurementResponseSchema,
  suppliersResponseSchema,
  workforceResponseSchema,
} from '../schemas/businessOperations.js';
import { errorResponseSchema } from '../schemas/common.js';

const businesses = new BusinessRepository();
const operations = new BusinessOperationsService();

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export default async function businessOperationsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')];

  server.post('/v1/businesses/:businessId/operations/intake/:publicationPackageId', {
    schema: {
      tags: ['operations'],
      summary: 'Consume a published Data Acquisition package into Business Operations',
      params: operationsIntakeParamsSchema,
      response: {
        200: operationsIntakeResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        402: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
      },
    },
    preHandler: [
      app.authenticate,
      app.resolveTenantContext,
      app.requirePermission('bo:write'),
      app.requireActiveSubscription(),
      app.requireIdempotencyKey,
    ],
  }, async (request, reply) => {
    const { businessId, publicationPackageId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const result = await operations.intake.processPublishedPackage(
      request.ctx!,
      businessId,
      publicationPackageId
    );
    return reply.status(200).send(result);
  });

  server.get('/v1/businesses/:businessId/operations/summary', {
    schema: {
      tags: ['operations'],
      summary: 'Canonical Business Operations summary for a date range',
      params: operationsBusinessParamsSchema,
      querystring: operationsPeriodQuerySchema,
      response: {
        200: operationsSummaryResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    const { from, to } = request.query;
    await businesses.getById(request.ctx!, businessId);
    const summary = await operations.getSummary(request.ctx!, businessId, from, to);
    return reply.status(200).send({
      businessId,
      period: {
        from: summary.period.from.toISOString(),
        to: summary.period.to.toISOString(),
        days: summary.period.days,
      },
      summary: {
        sales: summary.sales,
        expenses: summary.expenses,
        inventory: summary.inventory,
        customers: summary.customers,
        team: summary.team,
      },
    });
  });

  server.get('/v1/businesses/:businessId/operations/inventory', {
    schema: {
      tags: ['operations'],
      summary: 'List canonical operational inventory balances',
      params: operationsBusinessParamsSchema,
      querystring: operationsListQuerySchema,
      response: {
        200: inventoryResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const items = await operations.inventory.listBalances(request.ctx!, businessId, request.query.limit);
    return reply.status(200).send({
      items: items.map((item) => ({
        ...item,
        lastMovementAt: iso(item.lastMovementAt),
      })),
    });
  });

  server.get('/v1/businesses/:businessId/operations/procurement', {
    schema: {
      tags: ['operations'],
      summary: 'List operational purchase orders',
      params: operationsBusinessParamsSchema,
      querystring: procurementListQuerySchema,
      response: {
        200: procurementResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const purchaseOrders = await operations.procurement.listPurchaseOrders(
      request.ctx!,
      businessId,
      request.query
    );
    return reply.status(200).send({
      purchaseOrders: purchaseOrders.map((po) => ({
        ...po,
        orderDate: po.orderDate.toISOString(),
        expectedDate: iso(po.expectedDate),
        approvedAt: iso(po.approvedAt),
      })),
    });
  });

  server.get('/v1/businesses/:businessId/operations/suppliers', {
    schema: {
      tags: ['operations'],
      summary: 'List suppliers with latest operational performance',
      params: operationsBusinessParamsSchema,
      querystring: operationsListQuerySchema,
      response: {
        200: suppliersResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const suppliers = await operations.suppliers.listSuppliers(request.ctx!, businessId, request.query.limit);
    return reply.status(200).send({
      suppliers: suppliers.map((supplier) => ({
        ...supplier,
        latestPerformanceAt: iso(supplier.latestPerformanceAt),
      })),
    });
  });

  server.get('/v1/businesses/:businessId/operations/workforce', {
    schema: {
      tags: ['operations'],
      summary: 'List workforce operational assignments',
      params: operationsBusinessParamsSchema,
      querystring: operationsListQuerySchema,
      response: {
        200: workforceResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const assignments = await operations.workforce.listAssignments(request.ctx!, businessId, request.query.limit);
    return reply.status(200).send({
      assignments: assignments.map((assignment) => ({
        ...assignment,
        validFrom: assignment.validFrom.toISOString(),
        validTo: iso(assignment.validTo),
      })),
    });
  });

  server.get('/v1/businesses/:businessId/operations/assets', {
    schema: {
      tags: ['operations'],
      summary: 'List operational assets with latest inspection state',
      params: operationsBusinessParamsSchema,
      querystring: operationsListQuerySchema,
      response: {
        200: assetsResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const assets = await operations.assets.listAssets(request.ctx!, businessId, request.query.limit);
    return reply.status(200).send({
      assets: assets.map((asset) => ({
        ...asset,
        latestInspectedAt: iso(asset.latestInspectedAt),
      })),
    });
  });
}
