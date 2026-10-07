import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyError } from 'fastify';
import { ErrorEventRepository } from '@infinicus/database';
import { EnvSecretProvider, redactSecretValues } from '@infinicus/configuration';
import { statusCodeFor } from '../errors.js';
import { redactUrl } from '../redactUrl.js';

const errorEventRepo = new ErrorEventRepository();
const secretProvider = new EnvSecretProvider();

/**
 * Every error response uses one envelope: { error: { code, message, correlationId } }.
 * Anything not recognized by errors.ts's status-code table is logged in
 * full server-side but returned to the client as a generic, redacted 500
 * — never the original message or stack trace (security baseline:
 * "controlled redacted errors", "no secrets in ... errors").
 *
 * BUILD-25 — every unhandled (500) error is additionally persisted to
 * observability.error_events via ErrorEventRepository, redacted through
 * redactSecretValues() first (defense-in-depth: a driver-level connection
 * error could otherwise embed a raw DATABASE_URL in its message). This is
 * fire-and-forget (not awaited) — error tracking must never slow down or
 * fail the actual error response, and a persistence failure is itself
 * logged, not thrown.
 */
export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError & { name?: string }, request, reply) => {
    const correlationId = request.correlationId;

    // Fastify/Zod schema validation failures.
    if (error.validation || error.code === 'FST_ERR_VALIDATION') {
      request.log.info({ err: error, correlationId }, 'request validation failed');
      return reply.status(400).send({
        error: { code: 'validation_error', message: error.message, correlationId },
      });
    }

    // BUILD-26 — a well-behaved Fastify plugin (e.g. @fastify/rate-limit)
    // throws a plain Error with `.statusCode` set to a legitimate 4xx
    // value but `.name` left as the generic "Error" — statusCodeFor()
    // alone can't see that and would previously fall through to the
    // catch-all 500 branch below, incorrectly redacting a real, intended
    // 429 into a generic "unexpected error" and persisting a false
    // error_events entry. Found live: a rate-limit test expected 429 and
    // got 500. Trust error.statusCode only for legitimate 4xx values
    // (never let a thrown error claim a false 2xx/3xx, and never treat a
    // claimed 5xx specially — that path already goes through the
    // redacted branch below).
    const nameBasedStatusCode = statusCodeFor(error.name);
    const trustedPluginStatusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : undefined;
    const statusCode = nameBasedStatusCode !== 500 ? nameBasedStatusCode : (trustedPluginStatusCode ?? 500);
    if (statusCode === 500) {
      request.log.error({ err: error, correlationId }, 'unhandled error');
      errorEventRepo
        .record({
          errorName: error.name ?? 'Error',
          message: redactSecretValues(error.message, secretProvider),
          correlationId,
          tenantId: request.ctx?.tenantId ?? null,
          route: request.routeOptions.url ?? redactUrl(request.url),
          statusCode: 500,
        })
        .catch((persistErr) => request.log.error({ err: persistErr }, 'failed to persist error event'));
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'An unexpected error occurred.', correlationId },
      });
    }

    request.log.info({ err: error, correlationId }, 'request failed');
    return reply.status(statusCode).send({
      error: { code: error.name ?? 'error', message: error.message, correlationId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: { code: 'route_not_found', message: `No route: ${request.method} ${redactUrl(request.url)}`, correlationId: request.correlationId },
    });
  });
});
