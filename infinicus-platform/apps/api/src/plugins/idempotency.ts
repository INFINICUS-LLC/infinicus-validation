import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IdempotencyKeyRepository } from '@infinicus/database';

const idempotencyKeys = new IdempotencyKeyRepository();

export function idempotencyRequestHash(body: unknown, params: Record<string, unknown>): string {
  const entries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  // Keep parameterless requests compatible. Resource-bound hashes cannot match legacy body-only hashes.
  const input = entries.length === 0 ? JSON.stringify(body ?? null)
    : `resource:v1:${JSON.stringify({ params: entries, body: body ?? null })}`;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * app.requireIdempotencyKey is a preHandler for routes that create or
 * mutate state. It requires an Idempotency-Key header, scoped per tenant
 * + route (request.ctx must already be set — run after
 * resolveTenantContext). A replayed request (same key, same body) short-
 * circuits with the original response instead of re-executing the route
 * handler; the same key with different validated path parameters or body is rejected as a conflict
 * (IdempotencyConflictError, mapped to 409).
 *
 * Completion is recorded by a matching onSend hook registered by the
 * same plugin, so every route using this preHandler gets replay recording
 * "for free" without repeating the bookkeeping in each route handler.
 */
export default fp(async function idempotencyPlugin(app: FastifyInstance) {
  app.decorate('requireIdempotencyKey', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.ctx) {
      const err = new Error('requireIdempotencyKey requires resolveTenantContext to run first');
      err.name = 'PermissionDeniedError';
      throw err;
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      const err = new Error('Missing required Idempotency-Key header');
      err.name = 'ValidationError';
      throw err;
    }
    const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
    const requestHash = idempotencyRequestHash(request.body, (request.params ?? {}) as Record<string, unknown>);

    const result = await idempotencyKeys.begin(request.ctx, key, route, requestHash);
    if (!result.claimed) {
      if (result.existing.status === 'completed') {
        return reply.status(result.existing.responseStatus ?? 200).send(result.existing.responseBody);
      }
      const err = new Error('A request with this Idempotency-Key is already being processed');
      err.name = 'IdempotencyInProgressError';
      throw err;
    }

    request.idempotency = { key, route };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.idempotency || !request.ctx) return payload;
    let body: unknown = payload;
    if (typeof payload === 'string') {
      try { body = JSON.parse(payload); } catch { body = payload; }
    }
    await idempotencyKeys.complete(request.ctx, request.idempotency.key, request.idempotency.route, reply.statusCode, body);
    return payload;
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    requireIdempotencyKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
