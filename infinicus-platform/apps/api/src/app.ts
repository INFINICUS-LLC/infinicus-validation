import Fastify, { type FastifyInstance, LogController } from 'fastify';
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
import identityExchangeRoutes from './routes/identityExchange.js';
import { resolveIdentityVerifier, type IdentityVerifier } from './identityVerifier.js';
import onboardingRoutes from './routes/onboarding.js';
import businessRoutes from './routes/businesses.js';
import abaAuthoringRoutes from './routes/abaAuthoring.js';
import businessAdministrationRoutes from './routes/businessAdministration.js';
import inventoryPolicyEvaluationRoutes from './routes/inventoryPolicyEvaluations.js';
import executionActivationRoutes from './routes/executionActivations.js';
import claimRecoveryRoutes from './routes/claimRecovery.js';
import executionHealthRoutes from './routes/executionHealth.js';
import outcomeMonitoringHealthRoutes from './routes/outcomeMonitoringHealth.js';
import governedMeasurementDefinitionRoutes from './routes/governedMeasurementDefinitions.js';
import { buildClaimRecoveryOperator } from './claimRecoveryComposition.js';
import type { ClaimRecoveryCompositionOptions } from './claimRecoveryComposition.js';
import { BoGovernanceEvidenceVerifier, ExecutionHealthService } from '@infinicus/business-operations-runtime';
import type { ExecutionHealthDependencies } from '@infinicus/business-operations-runtime';
import { buildAbaPackageIssuer } from './abaPackageAnnouncement.js';
import { resolveBuildVersion } from './buildVersion.js';
import type { AbaAnnouncementCompositionOptions } from './abaPackageAnnouncement.js';
import type { AbaAuthoringRouteOptions } from './routes/abaAuthoring.js';
import observabilityRoutes from './routes/observability.js';
import billingRoutes from './routes/billing.js';
import incidentRoutes from './routes/incidents.js';
import bizopsRoutes from './routes/bizops.js';
import businessOperationsRoutes from './routes/businessOperations.js';
import productsRoutes from './routes/products.js';
import registerSessionsRoutes from './routes/registerSessions.js';
import printersRoutes from './routes/printers.js';
import printJobsRoutes from './routes/printJobs.js';
import ordersRoutes from './routes/orders.js';
import offlineSalesRoutes from './routes/offlineSales.js';
import twinRoutes from './routes/twin.js';
import decisionRecommendationsRoutes from './routes/decisionRecommendations.js';
import reorderPolicyRecommendationRoutes from './routes/reorderPolicyRecommendation.js';
import inventoryReorderPolicyBaselineRoutes from './routes/inventoryReorderPolicyBaseline.js';
import inventoryBiEvidenceRoutes from './routes/inventoryBiEvidence.js';
import financialIntelligenceRoutes from './routes/financialIntelligence.js';
import inventoryItemTwinRoutes from './routes/inventoryItemTwin.js';
import biMetricRoutes, { type BiMetricRoutesOptions } from './routes/biMetrics.js';
import biMetricHandoffRoutes, { type BiMetricHandoffRoutesOptions } from './routes/biMetricHandoff.js';
import businessPerformanceTwinRoutes from './routes/businessPerformanceTwin.js';
import performanceSimulationHandoffRoutes from './routes/performanceSimulationHandoff.js';
import type { InventoryItemTwinCompositionOptions } from './inventoryItemTwinComposition.js';
import type { BusinessPerformanceTwinCompositionOptions } from './businessPerformanceTwinComposition.js';
import type { PerformanceSimulationHandoffCompositionOptions } from './performanceSimulationHandoffComposition.js';
import type { InventoryBiEvidenceCompositionOptions } from './inventoryBiEvidenceComposition.js';
import type { FinancialIntelligenceCompositionOptions } from './financialIntelligenceComposition.js';
import biSalesReportRoutes from './routes/biSalesReport.js';
import biDatasetRoutes, { type BiDatasetRoutesOptions } from './routes/biDatasets.js';
import type { BiSalesReportCompositionOptions } from './biSalesReportComposition.js';
import type { ReorderRecommendationCompositionOptions } from './reorderPolicyRecommendationComposition.js';
import dataAcquisitionRoutes from './routes/dataAcquisition.js';
import webhooksRoutes from './routes/webhooks.js';
import { redactUrl } from './redactUrl.js';
import { resolveTrustProxy } from './trustProxy.js';
import './types.js';

export interface BuildAppOptions {
  /** J-3: identity-provider verifier for POST /v1/auth/identity-exchange (test seam; production resolves it from SUPABASE_URL / SUPABASE_ANON_KEY, unset = closed). */
  identityVerifier?: IdentityVerifier;
  /** Composition-root dependency overrides for the ABA authoring surface (for example the authoritative evidence verifier). */
  abaAuthoring?: AbaAuthoringRouteOptions['dependencies'];
  /** Composition-root overrides for the ABA announcement edge (registry, kill switch). Production leaves it unset. */
  abaAnnouncement?: AbaAnnouncementCompositionOptions;
  /** Composition-root overrides for the interim operator recovery control (registry, kill switch, scripted ABA status port). Production leaves it unset. */
  claimRecovery?: ClaimRecoveryCompositionOptions;
  /** L-OBS-1: overrides for the read-only execution-health view (test seam for the due thresholds; production leaves it unset and uses the engine's constants). */
  executionHealth?: ExecutionHealthDependencies;
  /** AC-1: the ADI reorder-policy recommendation producer's composition (test seam; production uses the BO read-only derivation). */
  reorderRecommendation?: ReorderRecommendationCompositionOptions;
  /** AC-2 Block 5: the BI inventory evidence service composition (test seam; production joins BI to the read-only BO facts service). */
  inventoryBiEvidence?: InventoryBiEvidenceCompositionOptions;
  /** NEW-BI-01: test seam for the read-only financial report (production leaves it unset). */
  financialIntelligence?: FinancialIntelligenceCompositionOptions;
  biSalesReport?: BiSalesReportCompositionOptions;
  biDatasets?: BiDatasetRoutesOptions;
  /** AC-2 Block 6: the BDT inventory item state composition (test seam; production feeds the twin from the BI evidence service). */
  inventoryItemTwin?: InventoryItemTwinCompositionOptions;
  /** BI-2-DEV-03: test seam for the read-only governed metric registry (production leaves it unset). */
  biMetrics?: BiMetricRoutesOptions;
  /** BI-2-DEV-04: test seam for the read-only BI-09 -> BI-10 calculation hand-off (production leaves it unset). */
  biMetricHandoff?: BiMetricHandoffRoutesOptions;
  /** NEW-BDT-01: test seam for the business performance twin (production leaves it unset). */
  businessPerformanceTwin?: BusinessPerformanceTwinCompositionOptions;
  /** NEW-BDT-SIM-01: test seam for the performance state hand-off to Simulation (production leaves it unset). */
  performanceSimulationHandoff?: PerformanceSimulationHandoffCompositionOptions;
}

export async function buildApp(config: InfinicusConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // A separate observability-owned logger for structured audit entries
  // (below), decoupled from Fastify's own request/response logger — this
  // avoids depending on pino.Logger being structurally identical to
  // Fastify's internal logger type, and keeps @infinicus/observability
  // usable by any future non-Fastify caller too.
  const auditLogger = createLogger({ name: 'infinicus-api-audit', level: config.logLevel });

  // trustProxy comes from TRUST_PROXY (hop count or explicit proxy list, never
  // "trust everything"). Behind Caddy it must be set, otherwise request.ip is
  // the proxy's address for every client and all clients share one rate-limit
  // bucket; set too wide, a client could forge its address.
  // Per-request log lines stay off (the correlation-id plugin and the audit logger carry the request record). Fastify 5.12 deprecates the top-level
  // `disableRequestLogging` option (FSTDEP023, removed in Fastify 6); the same setting now lives on the LogController. Behaviour is unchanged.
  const app = Fastify({ logger: { level: config.logLevel }, logController: new LogController({ disableRequestLogging: true }), trustProxy: resolveTrustProxy(config.trustProxy) });

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
    // PUT is used by three routes (execution activations, declared currency, initial reorder-policy baseline); without it a browser on an allowed origin
    // fails the preflight. cors.test.ts derives the list from the registered routes so a new method cannot be forgotten.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
      route: request.routeOptions.url ?? redactUrl(request.url),
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
  });

  // Liveness — the process is up and answering HTTP requests. Does not
  // touch the database, so it stays healthy even during a database outage
  // (an orchestrator should not restart a process for a downstream outage
  // it cannot fix by restarting).
  // `version` is the git commit the image was built from (INFINICUS_BUILD_SHA, set at image build; 'unknown' when not injected), so an operator can
  // tell which code is deployed. It is a build identifier only - no configuration, host or secret is ever reported.
  const buildVersion = resolveBuildVersion();
  app.get('/v1/health', { schema: { hide: true } }, async () => ({ status: 'ok', version: buildVersion }));

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
  await app.register(identityExchangeRoutes, { verifier: options.identityVerifier ?? resolveIdentityVerifier() });
  await app.register(onboardingRoutes);
  await app.register(businessRoutes);
  // Composition root: the ONLY place the Business Operations evidence adapter is connected to the ABA verification port. ABA depends on the
  // GovernanceEvidenceVerifier interface alone; a test may override the verifier through options.abaAuthoring.
  // P0-6f: the same root also joins the ABA issuer's announcer to BO's governed activation gate (abaPackageAnnouncement.ts).
  await app.register(abaAuthoringRoutes, { dependencies: { evidenceVerifier: new BoGovernanceEvidenceVerifier(), issuer: buildAbaPackageIssuer(options.abaAnnouncement), ...options.abaAuthoring } });
  await app.register(inventoryPolicyEvaluationRoutes);
  await app.register(executionActivationRoutes);
  // P0-6h: the interim operator recovery control; the engine is joined to the ABA status provider in claimRecoveryComposition.ts only.
  await app.register(claimRecoveryRoutes, { operator: buildClaimRecoveryOperator(options.claimRecovery) });
  // L-OBS-1: read-only execution health for one business (bo:admin); it acts on nothing.
  await app.register(executionHealthRoutes, { service: new ExecutionHealthService(options.executionHealth) });
  // OM-OBS-1: read-only Outcome Monitoring health for one business (bo:admin), separate from execution health; it verifies, replays and acts on nothing.
  await app.register(outcomeMonitoringHealthRoutes);
  await app.register(governedMeasurementDefinitionRoutes);
  await app.register(businessAdministrationRoutes);
  await app.register(observabilityRoutes);
  await app.register(billingRoutes);
  await app.register(incidentRoutes);
  await app.register(bizopsRoutes);
  await app.register(businessOperationsRoutes);
  await app.register(productsRoutes);
  await app.register(registerSessionsRoutes);
  await app.register(printersRoutes);
  await app.register(printJobsRoutes);
  await app.register(ordersRoutes);
  // OFF-1: closed (503) unless the owner-set OFFLINE_SALES_* configuration is present.
  await app.register(offlineSalesRoutes, { offlineSales: config.offlineSales });
  await app.register(twinRoutes);
  await app.register(decisionRecommendationsRoutes);
  await app.register(reorderPolicyRecommendationRoutes, options.reorderRecommendation ?? {});
  await app.register(inventoryReorderPolicyBaselineRoutes);
  await app.register(inventoryBiEvidenceRoutes, options.inventoryBiEvidence ?? {});
  // NEW-BI-01: read-only financial report (bi:read); Business Intelligence derives every figure from read-only Business Operations facts.
  await app.register(financialIntelligenceRoutes, options.financialIntelligence ?? {});
  await app.register(biSalesReportRoutes, options.biSalesReport ?? {});
  // BI-1-DEV-03: read-only view of what BI took in from BO and the versioned analytical datasets built from it (bi:read); four GETs, no mutation.
  await app.register(biDatasetRoutes, options.biDatasets ?? {});
  await app.register(inventoryItemTwinRoutes, options.inventoryItemTwin ?? {});
  // BI-2-DEV-03: read-only view of the governed BI-09 metric registry (bi:read); two GETs, no mutation.
  await app.register(biMetricRoutes, options.biMetrics ?? {});
  // BI-2-DEV-04: read-only BI-09 -> BI-10 calculation hand-off of the approved governed metrics (bi:read); one GET, nothing stored.
  await app.register(biMetricHandoffRoutes, options.biMetricHandoff ?? {});
  // NEW-BDT-01: the twin's representation of governed BI financial and sales evidence (dt:write / dt:read); derives no KPI.
  await app.register(businessPerformanceTwinRoutes, options.businessPerformanceTwin ?? {});
  // NEW-BDT-SIM-01: hand-off of the published performance state to Simulation as a scenario baseline (dt:write); writes only twin tables.
  await app.register(performanceSimulationHandoffRoutes, options.performanceSimulationHandoff ?? {});
  await app.register(dataAcquisitionRoutes);
  await app.register(webhooksRoutes, {
    rateLimit: {
      ipMax: config.webhookRateLimitIpMax,
      connectorMax: config.webhookRateLimitConnectorMax,
      windowMs: config.webhookRateLimitWindowMs,
    },
  });

  return app;
}
