import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProviderBillingService } from '@infinicus/billing';
import type { InfinicusConfig } from '@infinicus/configuration';
import { mapStripeEvent } from '../billing/stripe/StripeWebhookAdapter.js';
import { verifyStripeSignature } from '../billing/stripe/verifyStripeSignature.js';

/**
 * POST /webhooks/stripe - STRIPE-SBX-01 (SANDBOX ONLY).
 *
 * Path decision: provider-facing endpoints are registered in the provider's dashboard and must outlive the versioned user API, so this lives at /webhooks/stripe, not
 * under /v1 (the /v1 prefix is the authenticated, versioned application surface). It is unauthenticated in the INFINICUS user-auth sense: the Stripe signature IS the
 * authentication. Nothing in the user session / tenant-context machinery runs here.
 *
 * Raw body: the JSON content-type parser is replaced INSIDE THIS ENCAPSULATED PLUGIN ONLY (parseAs 'buffer'), so the exact delivered bytes reach the signature check and
 * no other route's body parsing changes. The buffer is never copied onto the request, logged, or echoed.
 *
 * Fail closed: unconfigured secret -> 503; missing / invalid signature, malformed or wrong-shaped payload, live-mode event -> 400 with a fixed code. Success answers carry
 * no internal detail. A thrown processing error becomes the platform's generic 500 (no exception text), and Stripe retries it.
 */
export interface StripeWebhookRouteOptions {
  stripe: InfinicusConfig['stripe'];
  /** Test seam: the provider-neutral billing service. Defaults to the production one. */
  service?: ProviderBillingService;
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,255}$/;
const BODY_LIMIT_BYTES = 1_048_576;

function reject(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, correlationId: request.correlationId } });
}

export default async function stripeWebhookRoutes(app: FastifyInstance, options: StripeWebhookRouteOptions) {
  const service = options.service ?? new ProviderBillingService();

  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES }, (_request, body, done) => done(null, body));

    scope.post('/webhooks/stripe', {
      bodyLimit: BODY_LIMIT_BYTES,
      schema: { tags: ['billing'], summary: 'Stripe sandbox webhook (signature-authenticated; six approved event types)', hide: true },
    }, async (request, reply) => {
      const signingKey = options.stripe.webhookSecret;
      if (signingKey === null) return reject(request, reply, 503, 'WEBHOOK_NOT_CONFIGURED', 'The webhook endpoint is not configured.');

      const raw = request.body;
      if (!Buffer.isBuffer(raw)) return reject(request, reply, 400, 'INVALID_PAYLOAD', 'The request body is not valid.');

      const verified = verifyStripeSignature(raw, request.headers['stripe-signature'], signingKey);
      if (!verified.ok) {
        return reject(request, reply, 400, verified.code, verified.code === 'INVALID_PAYLOAD' ? 'The request body is not valid.' : 'The webhook signature could not be verified.');
      }
      const event = verified.event;
      if (typeof event.id !== 'string' || !EVENT_ID.test(event.id) || typeof event.type !== 'string' || typeof event.data !== 'object' || event.data === null) {
        return reject(request, reply, 400, 'INVALID_EVENT', 'The event is not valid.');
      }
      // sandbox only: a live-mode event is never processed
      if (event.livemode !== false) return reject(request, reply, 400, 'LIVE_MODE_REJECTED', 'Only sandbox events are accepted.');

      const result = await service.process(mapStripeEvent(event, raw));
      if (result.outcome === 'IN_PROGRESS') return reject(request, reply, 409, 'EVENT_IN_PROGRESS', 'The event is being processed; retry later.');
      if (result.outcome === 'CONFLICT') return reject(request, reply, 409, 'EVENT_IDENTITY_CONFLICT', 'The event identity conflicts with a stored event.');
      return reply.status(200).send({ received: true, status: result.outcome === 'APPLIED' ? 'applied' : result.outcome === 'DUPLICATE' ? 'duplicate' : 'recorded' });
    });
  });
}
