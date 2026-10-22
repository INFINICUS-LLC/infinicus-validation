import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { InfinicusConfig } from '@infinicus/configuration';
import { OfflineSaleRepository, OfflineSaleRequestError, OFFLINE_MAX_AGE_SECONDS, type OfflineSaleConfig } from '@infinicus/database';
import { businessIdParamsSchema, offlineSaleBodySchema, offlineSaleResponseSchema } from '../schemas/offlineSales.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

export interface OfflineSalesRouteOptions {
  /** The owner-set inputs (InfinicusConfig.offlineSales). A null tolerance means offline selling is not enabled. */
  offlineSales: InfinicusConfig['offlineSales'];
  /** Test seam; production leaves it unset. */
  repository?: Pick<OfflineSaleRepository, 'process'>;
}

/** Raised while offline selling is not enabled (no owner-approved configuration). Mapped to 503 in errors.ts. */
class OfflineSalesDisabledError extends Error {
  constructor() {
    super('Offline selling is not enabled');
    this.name = 'OfflineSalesDisabledError';
  }
}

export default async function offlineSalesRoutes(app: FastifyInstance, options: OfflineSalesRouteOptions) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const repository = options.repository ?? new OfflineSaleRepository();
  const settings = options.offlineSales;
  const serviceConfig: OfflineSaleConfig | null = settings.futureToleranceSeconds === null ? null : {
    maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS,
    futureToleranceSeconds: settings.futureToleranceSeconds,
    driftLimitMinorByCurrency: settings.driftLimitMinorByCurrency,
  };

  /** After permission and workspace visibility (so an unauthorised caller learns nothing) and BEFORE idempotency (so a "not enabled" answer is never cached). */
  async function requireOfflineSalesEnabled(): Promise<void> {
    if (serviceConfig === null) throw new OfflineSalesDisabledError();
  }

  server.post('/v1/businesses/:businessId/offline-sales', {
    schema: {
      tags: ['operations'],
      summary: 'Process one offline sale from a device (OFF-1): the server recomputes it and either completes the order or keeps it for review',
      description:
        'Cash only. All amounts are whole minor units. The Idempotency-Key header must equal clientSaleId. 201 = processed now (any outcome); 200 = the first recorded answer returned again. ' +
        'needs_review creates no order. 503 = offline selling is not enabled for this deployment.',
      params: businessIdParamsSchema,
      body: offlineSaleBodySchema,
      response: {
        200: offlineSaleResponseSchema, 201: offlineSaleResponseSchema,
        400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema, 503: errorResponseSchema,
      },
    },
    preHandler: [
      app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), requireBusinessWorkspace,
      requireOfflineSalesEnabled, app.requireIdempotencyKey,
    ],
  }, async (request, reply) => {
    const body = request.body;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.toLowerCase() !== body.clientSaleId.toLowerCase()) {
      throw new OfflineSaleRequestError('the Idempotency-Key header must equal clientSaleId');
    }
    const result = await repository.process(request.ctx!, request.params.businessId, {
      clientSaleId: body.clientSaleId,
      deviceId: body.deviceId,
      registerSessionId: body.registerSessionId,
      deviceCreatedAt: new Date(body.deviceCreatedAt),
      catalogueSnapshotAt: new Date(body.catalogueSnapshotAt),
      currencyCode: body.currencyCode,
      lines: body.lines,
      provisionalTotalMinor: body.provisionalTotalMinor,
      tenders: body.tenders,
    }, serviceConfig as OfflineSaleConfig);
    return reply.status(result.replayed ? 200 : 201).send(result);
  });
}
