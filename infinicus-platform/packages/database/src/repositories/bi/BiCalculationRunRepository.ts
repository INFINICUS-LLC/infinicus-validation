/**
 * Persistence of governed BI-10 calculation runs and metric results (BI-2-DEV-07, migration 0223). The repository stores exactly what it is given as plain data;
 * the workflow layer verifies the run (deterministic ids, hand-off integrity, dataset provenance) before calling it and re-verifies on read. The database adds
 * its own integrity: composite scope-aware keys, results that agree with the stored definition version they cite, runs that are complete or absent, sealed
 * inputs only, server-generated persisted time, append-only tables.
 *
 * A run is written in ONE transaction (run row, inputs, results) and is idempotent on its deterministic id: the same run again is a replay and writes nothing;
 * a different run under the same id is a ConflictError. A replay with another request correlation id returns the stored run: the first correlation is the provenance.
 */
import type { TenantContext } from '../../client.js';
import { canonicalUuid, inBusinessScope, pgCode } from './businessScope.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

export interface StoredDatasetFingerprint { warehouseDatasetId: string; rowCount: number; rowsFingerprint: string }
export interface CalculationRunInputRecord { datasetId: string; datasetVersionId: string; rowCount: number; rowsFingerprint: string; sealDigest: string }
export interface MetricResultRecord {
  id: string;
  metricDefinitionId: string;
  metricVersion: number;
  metricCode: string;
  metricType: string;
  metricContentHash: string;
  warehouseDatasetId: string;
  groupKey: string;
  groupDimensions: Record<string, unknown>;
  timeBucket: string | null;
  /** Canonical decimal text, or null. */
  value: string | null;
  unit: string;
  currency: string | null;
  target: string | null;
  thresholdStatus: string;
  targetMet: boolean | null;
  sourceRowCount: number | null;
  calculationStatus: string;
}
export interface CalculationRunRecord {
  id: string;
  calculationHandoffId: string;
  warehouseSnapshotId: string | null;
  correlationId: string;
  /** The stored creation time of the BI-09 hand-off source (ISO text). Not a persisted time. */
  handoffSourceTimestamp: string;
  metricCount: number;
  datasets: StoredDatasetFingerprint[];
  /** SHA-256 of the canonical run without its correlation id (what makes a replay recognisable). */
  runDigest: string;
  inputs: CalculationRunInputRecord[];
  results: MetricResultRecord[];
}
export interface StoredCalculationRun extends CalculationRunRecord { persistedAt: Date }
export interface PersistRunOutcome { replayed: boolean; persistedAt: Date }

function refusal(error: unknown): never {
  const code = pgCode(error);
  if (code === '23514' || code === '23505') throw new ValidationError('CalculationRun', ['the run violates the calculation integrity rules']);
  if (code === '23503') throw new ValidationError('CalculationRun', ['the run cites a record that is not in this business']);
  throw error;
}

export class BiCalculationRunRepository {
  async persist(ctx: TenantContext, businessId: string, run: CalculationRunRecord): Promise<PersistRunOutcome> {
    const id = canonicalUuid(run.id); const handoff = canonicalUuid(run.calculationHandoffId);
    if (id === null || handoff === null) throw new ValidationError('CalculationRun', ['run and hand-off ids must be UUIDs']);
    if (!Array.isArray(run.results) || run.results.length < 1) throw new ValidationError('CalculationRun', ['a run needs at least one result']);
    if (!Array.isArray(run.inputs) || !Array.isArray(run.datasets) || run.inputs.length !== run.datasets.length) throw new ValidationError('CalculationRun', ['inputs must match the run datasets']);
    const timestamp = Date.parse(run.handoffSourceTimestamp);
    if (Number.isNaN(timestamp)) throw new ValidationError('CalculationRun', ['handoffSourceTimestamp must be a timestamp']);

    return inBusinessScope(ctx, businessId, async (client, scope) => {
      try {
        const inserted = await client.query<{ persisted_at: Date }>(
          `INSERT INTO business_intelligence.metric_calculation_runs
             (id, tenant_id, workspace_id, business_id, calculation_handoff_id, warehouse_snapshot_id, correlation_id, handoff_source_timestamp, metric_count, result_count, input_count, datasets, run_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb,$13) ON CONFLICT (id) DO NOTHING RETURNING persisted_at`,
          [id, scope.tenantId, scope.workspaceId, scope.businessId, handoff, run.warehouseSnapshotId, run.correlationId, new Date(timestamp).toISOString(), run.metricCount, run.results.length,
            run.inputs.length, JSON.stringify(run.datasets), run.runDigest]);
        if (inserted.rowCount === 1) {
          if (run.inputs.length > 0) {
            await client.query(
              `INSERT INTO business_intelligence.metric_calculation_run_inputs (tenant_id, workspace_id, business_id, run_id, dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest)
               SELECT $1, $2, $3, $4, x.dataset_id, x.dataset_version_id, x.row_count, x.rows_fingerprint, x.seal_digest
                 FROM jsonb_to_recordset($5::jsonb) AS x(dataset_id uuid, dataset_version_id uuid, row_count integer, rows_fingerprint text, seal_digest text)`,
              [scope.tenantId, scope.workspaceId, scope.businessId, id, JSON.stringify(run.inputs.map((i) => ({
                dataset_id: i.datasetId, dataset_version_id: i.datasetVersionId, row_count: i.rowCount, rows_fingerprint: i.rowsFingerprint, seal_digest: i.sealDigest,
              })))]);
          }
          await client.query(
            `INSERT INTO business_intelligence.metric_results
               (id, tenant_id, workspace_id, business_id, run_id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key,
                group_dimensions, time_bucket, value, unit, currency, target, threshold_status, target_met, source_row_count, calculation_status)
             SELECT x.id, $1, $2, $3, $4, x.metric_definition_id, x.metric_version, x.metric_code, x.metric_type, x.metric_content_hash, x.warehouse_dataset_id, x.group_key,
                    x.group_dimensions, x.time_bucket, x.value::numeric, x.unit, x.currency, x.target::numeric, x.threshold_status, x.target_met, x.source_row_count, x.calculation_status
               FROM jsonb_to_recordset($5::jsonb) AS x(id uuid, metric_definition_id uuid, metric_version integer, metric_code text, metric_type text, metric_content_hash text,
                    warehouse_dataset_id uuid, group_key text, group_dimensions jsonb, time_bucket text, value text, unit text, currency text, target text, threshold_status text,
                    target_met boolean, source_row_count integer, calculation_status text)`,
            [scope.tenantId, scope.workspaceId, scope.businessId, id, JSON.stringify(run.results.map((r) => ({
              id: r.id, metric_definition_id: r.metricDefinitionId, metric_version: r.metricVersion, metric_code: r.metricCode, metric_type: r.metricType, metric_content_hash: r.metricContentHash,
              warehouse_dataset_id: r.warehouseDatasetId, group_key: r.groupKey, group_dimensions: r.groupDimensions, time_bucket: r.timeBucket, value: r.value, unit: r.unit,
              currency: r.currency, target: r.target, threshold_status: r.thresholdStatus, target_met: r.targetMet, source_row_count: r.sourceRowCount, calculation_status: r.calculationStatus,
            })))]);
          // The deferred completeness check runs at commit; a run that does not add up fails there and nothing is kept.
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          return { replayed: false, persistedAt: inserted.rows[0]!.persisted_at };
        }
      } catch (error) { refusal(error); }

      const existing = await client.query<{ run_digest: string; persisted_at: Date }>(
        `SELECT run_digest, persisted_at FROM business_intelligence.metric_calculation_runs WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (existing.rowCount !== 1 || existing.rows[0]!.run_digest !== run.runDigest) throw new ConflictError('CalculationRun', 'a different run already holds this identity');
      return { replayed: true, persistedAt: existing.rows[0]!.persisted_at };
    });
  }

  async get(ctx: TenantContext, businessId: string, runId: string): Promise<StoredCalculationRun> {
    const id = canonicalUuid(runId);
    if (id === null) throw new NotFoundError('CalculationRun', runId);
    return inBusinessScope(ctx, businessId, async (client, scope) => {
      const run = await client.query<Record<string, unknown>>(
        `SELECT id, calculation_handoff_id, warehouse_snapshot_id, correlation_id, handoff_source_timestamp, metric_count, datasets, run_digest, persisted_at
           FROM business_intelligence.metric_calculation_runs WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`,
        [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      if (run.rowCount !== 1) throw new NotFoundError('CalculationRun', runId);
      const inputs = await client.query<Record<string, unknown>>(
        `SELECT dataset_id, dataset_version_id, row_count, rows_fingerprint, seal_digest FROM business_intelligence.metric_calculation_run_inputs
          WHERE run_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4 ORDER BY dataset_id`, [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      const results = await client.query<Record<string, unknown>>(
        `SELECT id, metric_definition_id, metric_version, metric_code, metric_type, metric_content_hash, warehouse_dataset_id, group_key, group_dimensions, time_bucket,
                value::text AS value, unit, currency, target::text AS target, threshold_status, target_met, source_row_count, calculation_status
           FROM business_intelligence.metric_results WHERE run_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4
          ORDER BY metric_code COLLATE "C", group_key COLLATE "C"`, [id, scope.tenantId, scope.workspaceId, scope.businessId]);
      const r = run.rows[0]!;
      return {
        id: r.id as string, calculationHandoffId: r.calculation_handoff_id as string, warehouseSnapshotId: (r.warehouse_snapshot_id as string | null) ?? null,
        correlationId: r.correlation_id as string, handoffSourceTimestamp: (r.handoff_source_timestamp as Date).toISOString(), metricCount: r.metric_count as number,
        datasets: r.datasets as StoredDatasetFingerprint[], runDigest: r.run_digest as string, persistedAt: r.persisted_at as Date,
        inputs: inputs.rows.map((i) => ({ datasetId: i.dataset_id as string, datasetVersionId: i.dataset_version_id as string, rowCount: i.row_count as number, rowsFingerprint: i.rows_fingerprint as string, sealDigest: i.seal_digest as string })),
        results: results.rows.map((x) => ({
          id: x.id as string, metricDefinitionId: x.metric_definition_id as string, metricVersion: x.metric_version as number, metricCode: x.metric_code as string, metricType: x.metric_type as string,
          metricContentHash: x.metric_content_hash as string, warehouseDatasetId: x.warehouse_dataset_id as string, groupKey: x.group_key as string,
          groupDimensions: x.group_dimensions as Record<string, unknown>, timeBucket: (x.time_bucket as string | null) ?? null, value: (x.value as string | null) ?? null, unit: x.unit as string,
          currency: (x.currency as string | null) ?? null, target: (x.target as string | null) ?? null, thresholdStatus: x.threshold_status as string,
          targetMet: (x.target_met as boolean | null) ?? null, sourceRowCount: (x.source_row_count as number | null) ?? null, calculationStatus: x.calculation_status as string,
        })),
      };
    });
  }
}
