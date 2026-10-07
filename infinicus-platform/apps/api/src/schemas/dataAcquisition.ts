import { z } from 'zod';

// ── Params ────────────────────────────────────────────────────────────────────

export const businessIdParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const sourceIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  sourceId: z.string().uuid(),
});

export const connectorIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  sourceId: z.string().uuid(),
  connectorId: z.string().uuid(),
});

export const runIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  runId: z.string().uuid(),
});

export const packageIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  packageId: z.string().uuid(),
});

/** The full raw bearer token (`prefix.secret`) travels in the URL path — see routes/webhooks.ts for why. */
export const webhookTokenParamsSchema = z.object({
  token: z.string().min(1),
});

// ── Enums (mirroring packages/database/src/repositories/da/*) ─────────────────

const connectorTypeSchema = z.enum([
  'rest_api', 'graphql', 'webhook', 'postgres', 'mysql', 'mssql', 'sqlite',
  'sftp', 'object_storage', 'file_upload', 'event_stream', 'custom', 'manual_json',
]);

const connectorStatusSchema = z.enum(['draft', 'active', 'paused', 'suspended', 'retired', 'failed']);

const connectorHealthStatusSchema = z.enum(['unknown', 'healthy', 'degraded', 'unhealthy', 'offline']);

const publicationPackageStatusSchema = z.enum(['draft', 'ready', 'published', 'revoked']);

// ── Response shapes ─────────────────────────────────────────────────────────

const dataSourceSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid().nullable(),
  name: z.string(),
  sourceCode: z.string(),
  sourceType: z.string(),
  sensitivityLevel: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  version: z.number(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const connectorSchema = z.object({
  id: z.string().uuid(),
  dataSourceId: z.string().uuid(),
  name: z.string(),
  connectorType: z.string(),
  connectorVersion: z.string(),
  configurationReference: z.string().nullable(),
  healthStatus: z.string(),
  lastHealthCheckAt: z.coerce.date().nullable(),
  status: z.string(),
  version: z.number(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const collectionRunSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid().nullable(),
  dataSourceId: z.string().uuid(),
  connectorId: z.string().uuid().nullable(),
  collectionType: z.string(),
  state: z.string(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  recordsReceived: z.number(),
  recordsAccepted: z.number(),
  recordsRejected: z.number(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  attemptNumber: z.number(),
  correlationId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const manualIntakeResultSchema = z.object({
  collectionRunId: z.string().uuid(),
  state: z.string(),
  manualSubmissionId: z.string().uuid(),
  recordsReceived: z.number(),
  recordsAccepted: z.number(),
  recordsRejected: z.number(),
  validationResultId: z.string().uuid(),
  qualityScoreId: z.string().uuid().nullable(),
  provenanceIds: z.array(z.string().uuid()),
  correlationId: z.string().uuid(),
});

const validationIssueSchema = z.object({
  id: z.string().uuid(),
  ruleCode: z.string(),
  fieldPath: z.string().nullable(),
  severity: z.string(),
  issueType: z.string(),
  message: z.string(),
  resolutionStatus: z.string(),
  createdAt: z.coerce.date(),
});

const validationResultSchema = z.object({
  id: z.string().uuid(),
  collectionRunId: z.string().uuid(),
  recordReference: z.string().nullable(),
  isValid: z.boolean(),
  errorCount: z.number(),
  warningCount: z.number(),
  resultDetails: z.record(z.unknown()),
  validatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});

const dataQualityScoreSchema = z.object({
  id: z.string().uuid(),
  dataSourceId: z.string().uuid(),
  collectionRunId: z.string().uuid().nullable(),
  completeness: z.number(),
  validity: z.number(),
  consistency: z.number(),
  timeliness: z.number(),
  uniqueness: z.number(),
  conformity: z.number(),
  overallScore: z.number(),
  weights: z.record(z.unknown()),
  scoreDetails: z.record(z.unknown()),
  scoredAt: z.coerce.date(),
});

const provenanceRecordSchema = z.object({
  id: z.string().uuid(),
  dataSourceId: z.string().uuid(),
  collectionRunId: z.string().uuid().nullable(),
  recordReference: z.string(),
  sourceReference: z.string(),
  sourceHash: z.string().nullable(),
  parentProvenanceId: z.string().uuid().nullable(),
  lineageDepth: z.number(),
  createdAt: z.coerce.date(),
});

const publicationPackageSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid().nullable(),
  packageType: z.string(),
  packageVersion: z.string(),
  targetLayer: z.string(),
  targetBlock: z.string(),
  dataReference: z.record(z.unknown()),
  recordCount: z.number(),
  qualityScore: z.number().nullable(),
  status: z.string(),
  publishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ── Request bodies ───────────────────────────────────────────────────────────

export const createDataSourceBodySchema = z.object({
  name: z.string().min(1).max(255),
  sourceCode: z.string().min(1).max(255),
  sourceType: z.string().min(1).max(255),
  sensitivityLevel: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  configuration: z.record(z.unknown()).optional(),
});

export const updateSourceStatusBodySchema = z.object({
  status: z.string().min(1).max(50),
});

export const createConnectorBodySchema = z.object({
  name: z.string().min(1).max(255),
  connectorType: connectorTypeSchema,
  protocol: z.string().max(50).optional(),
  configurationReference: z.string().max(500).optional(),
});

export const healthCheckBodySchema = z.object({
  healthStatus: connectorHealthStatusSchema,
});

export const updateConnectorStatusBodySchema = z.object({
  status: connectorStatusSchema,
});

export const manualIntakeBodySchema = z.object({
  connectorId: z.string().uuid().optional(),
  submissionType: z.string().min(1).max(100),
  records: z.array(z.unknown()).min(1),
  submissionNotes: z.string().max(2000).optional(),
  sourceReference: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Externally-facing — deliberately permissive: an external system's raw delivery, not shaped to our conventions. A bare object is normalized to a one-element array by the route. */
export const webhookDeliveryBodySchema = z.union([
  z.record(z.unknown()),
  z.array(z.unknown()).min(1),
]);

export const preparePublicationPackageBodySchema = z.object({
  targetBlock: z.string().min(1).max(255),
  packageType: z.string().max(100).optional(),
  limitations: z.array(z.unknown()).optional(),
});

// ── Queries ───────────────────────────────────────────────────────────────────

export const listSourcesQuerySchema = z.object({
  status: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listPublicationPackagesQuerySchema = z.object({
  status: publicationPackageStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Response envelopes ────────────────────────────────────────────────────────

export const dataSourceResponseSchema = dataSourceSchema;
export const listDataSourcesResponseSchema = z.object({ dataSources: z.array(dataSourceSchema) });

export const connectorResponseSchema = connectorSchema;
export const listConnectorsResponseSchema = z.object({ connectors: z.array(connectorSchema) });

export const collectionRunResponseSchema = collectionRunSchema;
export const listCollectionRunsResponseSchema = z.object({ runs: z.array(collectionRunSchema) });

export const manualIntakeResponseSchema = manualIntakeResultSchema;

/** The raw token is returned exactly once, here — never retrievable again (only its hash is persisted). */
export const webhookTokenResponseSchema = z.object({
  token: z.string(),
  webhookUrl: z.string(),
});

export const webhookIntakeResponseSchema = z.object({
  collectionRunId: z.string().uuid(),
  state: z.string(),
  recordsReceived: z.number(),
  recordsAccepted: z.number(),
  recordsRejected: z.number(),
  correlationId: z.string().uuid(),
  replayed: z.boolean(),
});

export const listValidationResultsResponseSchema = z.object({
  validationResults: z.array(validationResultSchema.extend({ issues: z.array(validationIssueSchema) })),
});

export const qualityScoreResponseSchema = z.object({ qualityScore: dataQualityScoreSchema.nullable() });

export const listProvenanceResponseSchema = z.object({ provenance: z.array(provenanceRecordSchema) });

export const publicationPackageResponseSchema = publicationPackageSchema;
export const listPublicationPackagesResponseSchema = z.object({ publicationPackages: z.array(publicationPackageSchema) });
