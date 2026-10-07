import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BusinessRepository } from '@infinicus/database';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import {
  businessIdParamsSchema, sourceIdParamsSchema, connectorIdParamsSchema,
  runIdParamsSchema, packageIdParamsSchema,
  createDataSourceBodySchema, updateSourceStatusBodySchema,
  createConnectorBodySchema, healthCheckBodySchema, updateConnectorStatusBodySchema,
  manualIntakeBodySchema, preparePublicationPackageBodySchema,
  listSourcesQuerySchema, pageQuerySchema, listPublicationPackagesQuerySchema,
  dataSourceResponseSchema, listDataSourcesResponseSchema,
  connectorResponseSchema, listConnectorsResponseSchema,
  collectionRunResponseSchema, listCollectionRunsResponseSchema,
  manualIntakeResponseSchema,
  webhookTokenResponseSchema,
  listValidationResultsResponseSchema, qualityScoreResponseSchema,
  listProvenanceResponseSchema,
  publicationPackageResponseSchema, listPublicationPackagesResponseSchema,
} from '../schemas/dataAcquisition.js';
import { errorResponseSchema } from '../schemas/common.js';

const businesses = new BusinessRepository();
const dataAcquisition = new DataAcquisitionService();

export default async function dataAcquisitionRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // ── Sources (§4.3) ──────────────────────────────────────────────────────────

  server.post('/v1/businesses/:businessId/data-sources', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Register a new data source for a business',
      params: businessIdParamsSchema,
      body: createDataSourceBodySchema,
      response: { 201: dataSourceResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const source = await dataAcquisition.registerSource(request.ctx!, { businessId, ...request.body });
    return reply.status(201).send(source);
  });

  server.get('/v1/businesses/:businessId/data-sources', {
    schema: {
      tags: ['data-acquisition'],
      summary: "List a business's registered data sources",
      params: businessIdParamsSchema,
      querystring: listSourcesQuerySchema,
      response: { 200: listDataSourcesResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const { status, limit, offset } = request.query;
    const list = await dataAcquisition.listSources(request.ctx!, businessId, { status, limit, offset });
    return reply.status(200).send({ dataSources: list });
  });

  server.get('/v1/businesses/:businessId/data-sources/:sourceId', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Get a data source',
      params: sourceIdParamsSchema,
      response: { 200: dataSourceResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const source = await dataAcquisition.getSource(request.ctx!, businessId, sourceId);
    return reply.status(200).send(source);
  });

  server.patch('/v1/businesses/:businessId/data-sources/:sourceId/status', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Change a data source\'s status',
      params: sourceIdParamsSchema,
      body: updateSourceStatusBodySchema,
      response: { 200: dataSourceResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const source = await dataAcquisition.updateSourceStatus(request.ctx!, businessId, sourceId, request.body.status);
    return reply.status(200).send(source);
  });

  server.delete('/v1/businesses/:businessId/data-sources/:sourceId', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Retire (soft-delete) a data source',
      params: sourceIdParamsSchema,
      response: { 204: z.null().describe('No Content'), 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    await dataAcquisition.deleteSource(request.ctx!, businessId, sourceId);
    return reply.status(204).send(null);
  });

  // ── Connectors (§4.4) ───────────────────────────────────────────────────────

  server.post('/v1/businesses/:businessId/data-sources/:sourceId/connectors', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Register a connector for a data source',
      params: sourceIdParamsSchema,
      body: createConnectorBodySchema,
      response: { 201: connectorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const connector = await dataAcquisition.registerConnector(request.ctx!, businessId, sourceId, request.body);
    return reply.status(201).send(connector);
  });

  server.get('/v1/businesses/:businessId/data-sources/:sourceId/connectors', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'List connectors for a data source',
      params: sourceIdParamsSchema,
      querystring: pageQuerySchema,
      response: { 200: listConnectorsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await dataAcquisition.listConnectors(request.ctx!, businessId, sourceId, request.query);
    return reply.status(200).send({ connectors: list });
  });

  server.get('/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Get a connector',
      params: connectorIdParamsSchema,
      response: { 200: connectorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, sourceId, connectorId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const connector = await dataAcquisition.getConnector(request.ctx!, businessId, sourceId, connectorId);
    return reply.status(200).send(connector);
  });

  server.post('/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/health-check', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Record a connector health check result',
      params: connectorIdParamsSchema,
      body: healthCheckBodySchema,
      response: { 200: connectorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId, connectorId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const connector = await dataAcquisition.healthCheckConnector(request.ctx!, businessId, sourceId, connectorId, request.body.healthStatus);
    return reply.status(200).send(connector);
  });

  server.patch('/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/status', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Change a connector\'s status',
      params: connectorIdParamsSchema,
      body: updateConnectorStatusBodySchema,
      response: { 200: connectorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId, connectorId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const connector = await dataAcquisition.updateConnectorStatus(request.ctx!, businessId, sourceId, connectorId, request.body.status);
    return reply.status(200).send(connector);
  });

  server.post('/v1/businesses/:businessId/data-sources/:sourceId/connectors/:connectorId/webhook-token', {
    schema: {
      tags: ['data-acquisition'],
      summary: '(Re)generate a webhook connector\'s bearer token — shown exactly once here, never retrievable again',
      params: connectorIdParamsSchema,
      response: { 201: webhookTokenResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 400: errorResponseSchema },
    },
    // Deliberately NO requireIdempotencyKey: the idempotency layer persists
    // every completed response body in api.idempotency_keys and replays it on
    // a retry. This response carries the raw bearer token, which must exist
    // only in the single response to the caller (only its SHA-256 hash is
    // stored, see docs/webhook-token-lifecycle.md). Regeneration is naturally
    // "last call wins": a client that lost the response simply calls again,
    // and the previous token is invalidated.
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:admin'), app.requireActiveSubscription()],
  }, async (request, reply) => {
    const { businessId, sourceId, connectorId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const token = await dataAcquisition.generateConnectorWebhookToken(request.ctx!, businessId, sourceId, connectorId);
    return reply.status(201).send({ token, webhookUrl: `/v1/webhooks/data-acquisition/${token}` });
  });

  // ── Manual JSON intake (§4.5) ───────────────────────────────────────────────

  server.post('/v1/businesses/:businessId/data-sources/:sourceId/manual-intake', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Submit a batch of records for manual JSON intake',
      params: sourceIdParamsSchema,
      body: manualIntakeBodySchema,
      response: { 201: manualIntakeResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema, 413: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sourceId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const result = await dataAcquisition.submitManualIntake(request.ctx!, {
      businessId,
      dataSourceId: sourceId,
      submittedBy: request.ctx!.userId,
      correlationId: request.correlationId,
      ...request.body,
    });
    return reply.status(201).send(result);
  });

  // ── Collection runs and their read-only sub-resources (§4.14) ──────────────

  server.get('/v1/businesses/:businessId/collection-runs', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'List collection runs for a business',
      params: businessIdParamsSchema,
      querystring: pageQuerySchema,
      response: { 200: listCollectionRunsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await dataAcquisition.listRuns(request.ctx!, businessId, request.query);
    return reply.status(200).send({ runs: list });
  });

  server.get('/v1/businesses/:businessId/collection-runs/:runId', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Get a collection run',
      params: runIdParamsSchema,
      response: { 200: collectionRunResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const run = await dataAcquisition.getRun(request.ctx!, businessId, runId);
    return reply.status(200).send(run);
  });

  server.get('/v1/businesses/:businessId/collection-runs/:runId/validation-results', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'List validation results (with issues) for a collection run',
      params: runIdParamsSchema,
      querystring: pageQuerySchema,
      response: { 200: listValidationResultsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await dataAcquisition.listValidationResults(request.ctx!, businessId, runId, request.query);
    return reply.status(200).send({ validationResults: list });
  });

  server.get('/v1/businesses/:businessId/collection-runs/:runId/quality-score', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Get the quality score for a collection run',
      params: runIdParamsSchema,
      response: { 200: qualityScoreResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const score = await dataAcquisition.getQualityScore(request.ctx!, businessId, runId);
    return reply.status(200).send({ qualityScore: score });
  });

  server.get('/v1/businesses/:businessId/collection-runs/:runId/provenance', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'List provenance records for a collection run',
      params: runIdParamsSchema,
      querystring: pageQuerySchema,
      response: { 200: listProvenanceResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const list = await dataAcquisition.listProvenance(request.ctx!, businessId, runId, request.query);
    return reply.status(200).send({ provenance: list });
  });

  // ── Publication (§4.12/§4.13) ───────────────────────────────────────────────

  server.post('/v1/businesses/:businessId/collection-runs/:runId/publication-package', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Prepare a publication package from a validated collection run',
      params: runIdParamsSchema,
      body: preparePublicationPackageBodySchema,
      response: { 201: publicationPackageResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const pkg = await dataAcquisition.preparePublicationPackage(request.ctx!, businessId, runId, request.body);
    return reply.status(201).send(pkg);
  });

  server.post('/v1/businesses/:businessId/publication-packages/:packageId/publish', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Publish a ready publication package',
      params: packageIdParamsSchema,
      response: { 200: publicationPackageResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, packageId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const pkg = await dataAcquisition.publishPackage(request.ctx!, businessId, packageId);
    return reply.status(200).send(pkg);
  });

  server.get('/v1/businesses/:businessId/publication-packages', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'List publication packages for a business',
      params: businessIdParamsSchema,
      querystring: listPublicationPackagesQuerySchema,
      response: { 200: listPublicationPackagesResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const { status, limit, offset } = request.query;
    const list = await dataAcquisition.listPublicationPackages(request.ctx!, businessId, { status, limit, offset });
    return reply.status(200).send({ publicationPackages: list });
  });

  server.get('/v1/businesses/:businessId/publication-packages/:packageId', {
    schema: {
      tags: ['data-acquisition'],
      summary: 'Get a publication package',
      params: packageIdParamsSchema,
      response: { 200: publicationPackageResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('da:read')],
  }, async (request, reply) => {
    const { businessId, packageId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const pkg = await dataAcquisition.getPublicationPackage(request.ctx!, businessId, packageId);
    return reply.status(200).send(pkg);
  });
}
