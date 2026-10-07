import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import { webhookTokenParamsSchema, webhookDeliveryBodySchema, webhookIntakeResponseSchema } from '../schemas/dataAcquisition.js';
import { errorResponseSchema } from '../schemas/common.js';
import { createWebhookRateLimitHook, type WebhookRateLimitSettings } from '../plugins/webhookRateLimit.js';

const dataAcquisition = new DataAcquisitionService();

/**
 * Inbound webhook delivery — deliberately the one route in this API with no
 * app.authenticate/resolveTenantContext/requirePermission preHandler. An
 * external system posting to this endpoint has no INFINICUS session and no
 * tenant/workspace headers to send; the bearer token embedded in the URL
 * path is both its identity and its authorization, verified inside
 * DataAcquisitionService.receiveWebhook() (see that method's own doc
 * comment for why an unknown prefix and a wrong secret must be
 * indistinguishable to the caller).
 *
 * The full raw token travels in the URL path rather than an Authorization
 * header — some webhook-sending systems (Slack incoming webhooks is the
 * model this follows) only let a user configure a target URL, not custom
 * headers, so a header-only scheme would be unreachable for them.
 */
export interface WebhooksRouteOptions {
  rateLimit: WebhookRateLimitSettings;
}

export default async function webhooksRoutes(app: FastifyInstance, options: WebhooksRouteOptions) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const webhookRateLimit = createWebhookRateLimitHook(app, options.rateLimit);

  server.post('/v1/webhooks/data-acquisition/:token', {
    // The global per-IP limiter is replaced by the webhook-specific limiter
    // below (see plugins/webhookRateLimit.ts for why and how).
    config: { rateLimit: false },
    onRequest: webhookRateLimit,
    schema: {
      tags: ['data-acquisition'],
      summary: 'Receive a webhook delivery for a data-acquisition webhook connector',
      params: webhookTokenParamsSchema,
      body: webhookDeliveryBodySchema,
      response: {
        201: webhookIntakeResponseSchema,
        400: errorResponseSchema, 401: errorResponseSchema, 413: errorResponseSchema, 429: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { token } = request.params;
    const dot = token.indexOf('.');
    // No 'prefix.secret' structure at all — reject the same way a wrong
    // secret would be (see receiveWebhook's own note: never confirm or
    // deny that a prefix exists), rather than a schema-validation-shaped
    // error that would distinguish "malformed" from "wrong".
    const tokenPrefix = dot > 0 ? token.slice(0, dot) : token;

    // A bare JSON object (the common shape for a single-event webhook) is
    // normalized to a one-element batch; an array is passed through as-is.
    const records = Array.isArray(request.body) ? request.body : [request.body];

    const result = await dataAcquisition.receiveWebhook({
      tokenPrefix,
      rawToken: token,
      records,
      externalEventId: firstHeaderValue(request.headers['x-event-id'] ?? request.headers['x-delivery-id']),
      requestId: firstHeaderValue(request.headers['x-request-id']) ?? request.id,
      headers: request.headers as Record<string, unknown>,
      rawBody: JSON.stringify(records),
    });

    return reply.status(201).send(result);
  });
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
