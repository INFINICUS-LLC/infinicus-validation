import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BiIntakeDatasetReadRepository } from '@infinicus/database';
import {
  biBusinessParamsSchema, biIntakeParamsSchema, biDatasetParamsSchema, biIntakeListQuerySchema, biDatasetListQuerySchema, biDatasetQuerySchema,
  biIntakeListResponseSchema, biIntakeDetailResponseSchema, biDatasetListResponseSchema, biDatasetDetailResponseSchema,
} from '../schemas/biDatasets.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

/**
 * BI-1 read API (BI-1-DEV-03): what Business Intelligence has taken in from Business Operations, and the versioned analytical datasets built from it.
 *
 * Four GET routes and nothing else: there is no mutation endpoint (intake and materialization stay services). Existing permission `bi:read` only (held by
 * owner, admin, member and viewer). Tenant and workspace come from the authenticated context; the business must exist in the caller's workspace (404
 * otherwise); every identifier is then looked up inside that business, so one that belongs to another business, workspace or tenant is a 404 exactly like one
 * that does not exist. Reads business_intelligence only, never business_operations. Scores are returned as stored: null = not assessed.
 */
export const BI_DATASET_READ_PERMISSION = 'bi:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export interface BiDatasetRoutesOptions { repository?: BiIntakeDatasetReadRepository }

export default async function biDatasetRoutes(app: FastifyInstance, options: BiDatasetRoutesOptions = {}) {
  const repository = options.repository ?? new BiIntakeDatasetReadRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [app.authenticate, app.resolveTenantContext, app.requirePermission(BI_DATASET_READ_PERMISSION), requireBusinessWorkspace];

  server.get('/v1/businesses/:businessId/bi/intake-packages', {
    schema: { tags: ['business-intelligence'], summary: 'List what BI has taken in from Business Operations for a business, newest first (requires bi:read; read-only)',
      params: biBusinessParamsSchema, querystring: biIntakeListQuerySchema, response: { 200: biIntakeListResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId } = request.params; const { status, domain, limit, offset } = request.query;
    const rows = await repository.listIntakePackages(request.ctx!, businessId, { status, domain }, { limit, offset });
    return reply.status(200).send({ intakePackages: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })), limit, offset });
  });

  server.get('/v1/businesses/:businessId/bi/intake-packages/:intakePackageId', {
    schema: { tags: ['business-intelligence'], summary: 'One intake package: status and history, the BO publication reference, provenance and the dataset versions built from it (requires bi:read; read-only)',
      params: biIntakeParamsSchema, response: { 200: biIntakeDetailResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId, intakePackageId } = request.params;
    const d = await repository.getIntakePackage(request.ctx!, businessId, intakePackageId);
    return reply.status(200).send({
      ...d, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
      statusHistory: d.statusHistory.map((h) => ({ ...h, occurredAt: h.occurredAt.toISOString() })),
      versions: d.versions.map((v) => ({ ...v, recordedAt: v.recordedAt.toISOString() })),
      sourceReferences: d.sourceReferences.map((s) => ({ ...s, recordedAt: s.recordedAt.toISOString() })),
    });
  });

  server.get('/v1/businesses/:businessId/bi/datasets', {
    schema: { tags: ['business-intelligence'], summary: 'List the analytical datasets of a business (requires bi:read; read-only)',
      params: biBusinessParamsSchema, querystring: biDatasetListQuerySchema, response: { 200: biDatasetListResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId } = request.params; const { domain, limit, offset } = request.query;
    const rows = await repository.listDatasets(request.ctx!, businessId, { domain }, { limit, offset });
    return reply.status(200).send({ datasets: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })), limit, offset });
  });

  server.get('/v1/businesses/:businessId/bi/datasets/:datasetId', {
    schema: { tags: ['business-intelligence'], summary: 'One analytical dataset with its newest versions: period, schema reference, BO publication data references, lineage and scores (null = not assessed) (requires bi:read; read-only)',
      params: biDatasetParamsSchema, querystring: biDatasetQuerySchema, response: { 200: biDatasetDetailResponseSchema, ...errors } },
    preHandler,
  }, async (request, reply) => {
    const { businessId, datasetId } = request.params;
    const d = await repository.getDataset(request.ctx!, businessId, datasetId, request.query.versionLimit);
    return reply.status(200).send({
      ...d, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
      versions: d.versions.map((v) => ({ ...v, effectiveStart: v.effectiveStart.toISOString(), effectiveEnd: iso(v.effectiveEnd), createdAt: v.createdAt.toISOString() })),
    });
  });
}
