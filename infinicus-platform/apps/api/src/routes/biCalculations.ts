import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BiConflictError, BiMetricResultReadRepository, BiNotFoundError, type CalculationRunInputRecord } from '@infinicus/database';
import { BusinessIntelligenceCalculationPersistenceService, BusinessIntelligenceMetricCalculationService, type CalculationRun } from '@infinicus/workflow';
import {
  biCalcBusinessParamsSchema, biCalcExecuteBodySchema, biCalcExecuteResponseSchema, biCalcRunParamsSchema, biCalcRunResponseSchema, biMetricResultsQuerySchema, biMetricResultsResponseSchema,
} from '../schemas/biCalculations.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

/**
 * Governed BI-10 calculation API (BI-2-DEV-08): execute a calculation, retrieve a stored run, query stored metric results. Reuses, and does not duplicate, the merged
 * BI-10 foundation: the BI-09 hand-off, the exact calculation, the sealed BI warehouse rows (BI-2-DEV-07) and the verifying persistence service.
 *
 * Authority. Execution WRITES a calculation run and its results, so it is never authorised by bi:read alone: it requires bi:write (the existing permission for managing
 * business intelligence analyses and metrics, migration 0137) AND bi:read (the response returns the run), an active subscription and an Idempotency-Key. Retrieval
 * and querying require bi:read only and mutate nothing. No permission was added.
 *
 * Data. The execute body carries no rows: rows come only from the business's SEALED warehouse versions, and when none exist the request fails closed (409). Tenant and
 * workspace come from the authenticated context; the business must exist in the caller's workspace; a run, metric or result of another business is indistinguishable
 * from one that does not exist. Errors are fixed text drawn from a closed vocabulary; nothing of the underlying cause is returned.
 */
export const BI_CALCULATION_EXECUTE_PERMISSIONS = ['bi:write', 'bi:read'] as const;
export const BI_CALCULATION_READ_PERMISSION = 'bi:read';
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };

export interface BiCalculationRoutesOptions {
  calculation?: BusinessIntelligenceMetricCalculationService;
  persistence?: BusinessIntelligenceCalculationPersistenceService;
  results?: BiMetricResultReadRepository;
}

/** Failure codes of the BI-10 pipeline that mean "this request cannot be executed in the current state" (409). Every other code is a server-side fault (500, generic). */
const CONFLICT_CODES = new Set([
  'METRIC_NOT_APPROVED', 'NO_METRICS_SELECTED', 'HANDOFF_INVALID', 'HANDOFF_CHANGED', 'HANDOFF_NOT_APPROVED', 'DATASET_ROWS_UNAVAILABLE', 'DATASET_TOO_LARGE', 'DEPENDENCY_UNKNOWN',
  'DEPENDENCY_CYCLE', 'METRIC_UNSUPPORTED', 'FORMULA_INVALID', 'UNIT_MISMATCH', 'DIMENSION_MISMATCH', 'FILTER_INVALID', 'THRESHOLD_INVALID', 'TIME_GRAIN_UNSUPPORTED', 'SOURCE_FIELD_REQUIRED',
  'ROWS_INVALID', 'VALUE_NOT_NUMERIC', 'INPUT_MISMATCH', 'RUN_NOT_REPRODUCIBLE', 'RUN_CONFLICT', 'PERSISTENCE_REJECTED', 'RUN_HAS_NO_RESULTS',
]);

function refusal(code: string): Error {
  if (code === 'METRIC_NOT_FOUND') return new BiNotFoundError('Metric', 'in this business');
  if (CONFLICT_CODES.has(code)) return new BiConflictError('CalculationRun', 'cannot be executed (' + code + ')');
  return new Error('calculation could not be completed');
}

function runView(run: CalculationRun, persistedAt: Date, inputs: readonly CalculationRunInputRecord[]) {
  return {
    calculationRunId: run.calculationRunId,
    calculationHandoffId: run.calculationHandoffId,
    warehouseSnapshotId: run.warehouseSnapshotId,
    correlationId: run.correlationId,
    handoffSourceTimestamp: run.handoffSourceTimestamp,
    persistedAt: persistedAt.toISOString(),
    metricCount: run.metricCount,
    resultCount: run.results.length,
    status: 'completed' as const,
    datasets: run.datasets.map((d) => {
      const input = inputs.find((i) => i.datasetId === d.warehouseDatasetId);
      if (!input) throw new Error('a stored run lacks the sealed input of a dataset it read');
      return { warehouseDatasetId: d.warehouseDatasetId, datasetVersionId: input.datasetVersionId, rowCount: d.rowCount, rowsFingerprint: d.rowsFingerprint, sealDigest: input.sealDigest };
    }),
  };
}

export default async function biCalculationRoutes(app: FastifyInstance, options: BiCalculationRoutesOptions = {}) {
  const persistence = options.persistence ?? new BusinessIntelligenceCalculationPersistenceService();
  const calculation = options.calculation ?? new BusinessIntelligenceMetricCalculationService(undefined, persistence);
  const results = options.results ?? new BiMetricResultReadRepository();
  const server = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = [app.authenticate, app.resolveTenantContext, app.requirePermission(BI_CALCULATION_READ_PERMISSION), requireBusinessWorkspace];

  server.post('/v1/businesses/:businessId/bi/metric-calculations', {
    schema: { tags: ['business-intelligence'], summary: 'Execute a governed BI-10 calculation over the business\'s sealed warehouse rows and store the run (requires bi:write and bi:read; idempotent; accepts no data rows)',
      params: biCalcBusinessParamsSchema, body: biCalcExecuteBodySchema, response: { 200: biCalcExecuteResponseSchema, 201: biCalcExecuteResponseSchema, ...errors } },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requireAllPermissions(BI_CALCULATION_EXECUTE_PERMISSIONS), requireBusinessWorkspace, app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params; const body: { metricIds?: string[]; calculationHandoffId?: string } = request.body ?? {};
    const out = await calculation.calculateAndPersist(request.ctx!, businessId, {
      correlationId: request.correlationId,
      ...(body.metricIds ? { metricIds: body.metricIds } : {}),
      ...(body.calculationHandoffId ? { expectedCalculationHandoffId: body.calculationHandoffId } : {}),
    });
    if (!out.ok) throw refusal(out.code);
    return reply.status(out.replayed ? 200 : 201).send({ ...runView(out.run, out.persistedAt, out.inputs), replayed: out.replayed });
  });

  server.get('/v1/businesses/:businessId/bi/metric-calculations/:runId', {
    schema: { tags: ['business-intelligence'], summary: 'One stored BI-10 calculation run with the sealed dataset versions it read (requires bi:read; read-only)',
      params: biCalcRunParamsSchema, response: { 200: biCalcRunResponseSchema, ...errors } },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId, runId } = request.params;
    const stored = await persistence.get(request.ctx!, businessId, runId);
    if (!stored.ok) throw refusal(stored.code);
    return reply.status(200).send(runView(stored.run, stored.persistedAt, stored.inputs));
  });

  server.get('/v1/businesses/:businessId/bi/metric-results', {
    schema: { tags: ['business-intelligence'], summary: 'Stored governed BI-10 metric results of a business, newest run first; filter by run, metric, code, status or time bucket (requires bi:read; read-only)',
      params: biCalcBusinessParamsSchema, querystring: biMetricResultsQuerySchema, response: { 200: biMetricResultsResponseSchema, ...errors } },
    preHandler: readGuards,
  }, async (request, reply) => {
    const { businessId } = request.params; const { limit, offset, ...filter } = request.query;
    const rows = await results.list(request.ctx!, businessId, filter, { limit, offset });
    return reply.status(200).send({
      results: rows.map((r) => ({
        metricResultId: r.metricResultId, calculationRunId: r.calculationRunId, metricId: r.metricId, metricVersion: r.metricVersion, metricCode: r.metricCode, metricType: r.metricType,
        metricContentHash: r.metricContentHash, warehouseDatasetId: r.warehouseDatasetId, datasetVersionId: r.datasetVersionId, groupKey: r.groupKey,
        group: { dimensions: r.groupDimensions, timeBucket: r.timeBucket }, value: r.value, unit: r.unit, currency: r.currency, target: r.target,
        threshold: { status: r.thresholdStatus as 'no_data' | 'normal' | 'warning' | 'critical' | 'good', targetMet: r.targetMet }, sourceRowCount: r.sourceRowCount,
        calculationStatus: r.calculationStatus as 'completed' | 'no_data', persistedAt: r.persistedAt.toISOString(),
      })),
      limit, offset,
    });
  });
}
