import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { InfinicusConfig } from '@infinicus/configuration';
import { getPool, poolStats } from '@infinicus/database';
import { createLogger, logAuditEntry } from '@infinicus/observability';
import correlationIdPlugin from './plugins/correlationId.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import tenantContextPlugin from './plugins/tenantContext.js';
import permissionPlugin from './plugins/permission.js';
import billingPlugin from './plugins/billing.js';
import idempotencyPlugin from './plugins/idempotency.js';
import authRoutes from './routes/auth.js';
import onboardingRoutes from './routes/onboarding.js';
import businessRoutes from './routes/businesses.js';
import observabilityRoutes from './routes/observability.js';
import billingRoutes from './routes/billing.js';
import incidentRoutes from './routes/incidents.js';
import bizopsRoutes from './routes/bizops.js';
import businessOperationsRoutes from './routes/businessOperations.js';
import productsRoutes from './routes/products.js';
import registerSessionsRoutes from './routes/registerSessions.js';
import ordersRoutes from './routes/orders.js';
import twinRoutes from './routes/twin.js';
import decisionRecommendationsRoutes from './routes/decisionRecommendations.js';
import dataAcquisitionRoutes from './routes/dataAcquisition.js';
import './types.js';

export async function buildApp(config: InfinicusConfig): Promise<FastifyInstance> {
  // A separate observability-owned logger for structured audit entries
  // (below), decoupled from Fastify's own request/response logger — this
  // avoids depending on pino.Logger being structurally identical to
  // Fastify's internal logger type, and keeps @infinicus/observability
  // usable by any future non-Fastify caller too.
  const auditLogger = createLogger({ name: 'infinicus-api-audit', level: config.logLevel });

  const app = Fastify({ logger: { level: config.logLevel }, disableRequestLogging: true });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(correlationIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(tenantContextPlugin);
  await app.register(permissionPlugin);
  await app.register(billingPlugin);
  await app.register(idempotencyPlugin);

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
  });

  // Browser cross-origin access for the public site (see
  // packages/configuration's corsAllowedOrigins / CORS_ALLOWED_ORIGINS).
  // No CORS registration existed before this — a browser calling this API
  // cross-origin was blocked outright by same-origin policy. Explicit
  // allowlist (never "*"): this API accepts an Authorization bearer token
  // and tenant-scoping headers, which must never be readable by an
  // arbitrary origin. credentials:true + a wildcard origin is also
  // rejected by browsers themselves, so "*" was never a viable shortcut
  // here regardless.
  await app.register(cors, {
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Workspace-Id', 'Idempotency-Key'],
  });

  // BUILD-26 — standard security response headers (X-Content-Type-Options,
  // X-Frame-Options, Referrer-Policy, Strict-Transport-Security, etc.) on
  // every response. CSP is scoped off: this is a pure JSON API (no HTML
  // views of its own to protect against injected-script XSS), and a
  // default CSP would break /documentation's Swagger UI, which needs
  // inline scripts/styles to render.
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'INFINICUS Governed Application API', version: '1' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/documentation' });

  app.addHook('onResponse', async (request, reply) => {
    logAuditEntry(auditLogger, {
      correlationId: request.correlationId,
      tenantId: request.ctx?.tenantId ?? null,
      userId: request.session?.user.id ?? null,
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
  });

  // Liveness — the process is up and answering HTTP requests. Does not
  // touch the database, so it stays healthy even during a database outage
  // (an orchestrator should not restart a process for a downstream outage
  // it cannot fix by restarting).
  app.get('/v1/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  // Readiness — the process is additionally able to serve real traffic
  // right now, i.e. the database is reachable. An orchestrator should stop
  // routing traffic to an instance failing this check (but need not
  // restart it — see /v1/health above).
  app.get('/v1/ready', { schema: { hide: true } }, async (_request, reply) => {
    try {
      await getPool().query('SELECT 1');
      return reply.status(200).send({ status: 'ready', pool: poolStats() });
    } catch (err) {
      app.log.error({ err }, 'readiness check failed: database unreachable');
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  await app.register(authRoutes);
  await app.register(onboardingRoutes);
  await app.register(businessRoutes);
  await app.register(observabilityRoutes);
  await app.register(billingRoutes);
  await app.register(incidentRoutes);
  await app.register(bizopsRoutes);
  await app.register(businessOperationsRoutes);
  await app.register(productsRoutes);
  await app.register(registerSessionsRoutes);
  await app.register(ordersRoutes);
  await app.register(twinRoutes);
  await app.register(decisionRecommendationsRoutes);
  await app.register(dataAcquisitionRoutes);

  return app;
}
