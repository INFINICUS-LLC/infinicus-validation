import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Rate limiting for the inbound webhook route.
 *
 * Two independent counters, both keyed on the real client address
 * (request.ip, which is only the real client when TRUST_PROXY matches the
 * deployment's proxy boundary — see packages/configuration parseTrustProxy):
 *
 *   1. per source IP, across every connector. Bounds unauthenticated spraying
 *      (for example many invented token prefixes), which would otherwise get a
 *      fresh per-connector counter each time.
 *   2. per source IP AND connector (token prefix). A burst or retry storm on
 *      one connector cannot exhaust the quota of another connector, and another
 *      source address cannot consume this source's quota, even if it knows or
 *      guesses the prefix, because the source address is part of the key.
 *
 * The global limiter is switched off for this route (config.rateLimit = false)
 * so webhook traffic neither consumes nor is throttled by the quota for the
 * rest of the API.
 */
export interface WebhookRateLimitSettings {
  ipMax: number;
  connectorMax: number;
  windowMs: number;
}

/** Caps the key size an unauthenticated caller can make us store. */
const MAX_PREFIX_LENGTH = 32;

export function connectorKeyOf(request: Pick<FastifyRequest, 'params'>): string {
  const token = (request.params as { token?: unknown } | undefined)?.token;
  const raw = typeof token === 'string' ? token : '';
  const dot = raw.indexOf('.');
  return (dot > 0 ? raw.slice(0, dot) : raw).slice(0, MAX_PREFIX_LENGTH);
}

type Limiter = (request: FastifyRequest) => Promise<{ isExceeded?: boolean; ttlInSeconds?: number }>;

export function createWebhookRateLimitHook(app: FastifyInstance, settings: WebhookRateLimitSettings) {
  const create = (app as unknown as { createRateLimit: (options: Record<string, unknown>) => Limiter }).createRateLimit;
  const perIp = create.call(app, {
    max: settings.ipMax,
    timeWindow: settings.windowMs,
    keyGenerator: (req: FastifyRequest) => `webhook:ip:${req.ip}`,
  });
  const perConnector = create.call(app, {
    max: settings.connectorMax,
    timeWindow: settings.windowMs,
    keyGenerator: (req: FastifyRequest) => `webhook:connector:${req.ip}:${connectorKeyOf(req)}`,
  });

  return async function webhookRateLimit(request: FastifyRequest, reply: FastifyReply) {
    for (const limiter of [perIp, perConnector]) {
      const result = await limiter(request);
      if (result.isExceeded) {
        // Retry-After lets a well-behaved sender back off instead of hammering.
        reply.header('retry-after', String(Math.max(1, result.ttlInSeconds ?? 1)));
        return reply.status(429).send({
          error: {
            code: 'rate_limited',
            message: 'Too many webhook deliveries from this source; retry after the interval in the Retry-After header.',
            correlationId: request.correlationId,
          },
        });
      }
    }
  };
}
