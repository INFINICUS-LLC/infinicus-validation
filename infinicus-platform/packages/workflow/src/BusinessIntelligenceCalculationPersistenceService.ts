/**
 * Durable BI-10 calculation runs and results (BI-2-DEV-07). The run is VERIFIED before it is stored and again when it is read back:
 *  - the run must account for itself (buildIntelligenceHandoff re-derives the run id and every result id and checks values and statuses);
 *  - the run must be REPRODUCIBLE: the BI-09 hand-off it names is rebuilt from the registry and the calculation is repeated over the sealed rows; a run whose values
 *    differ from that recalculation (an altered value, a registry that has since changed) is refused, so no stored number rests on trust;
 *  - every dataset the run read must be a sealed warehouse version, re-read now, whose seal digest, row count and rows fingerprint are exactly those the run states
 *    (the stored result is therefore bound to governed evidence, not to whatever rows a caller supplied);
 *  - the database refuses what it cannot tie to a stored definition version, a sealed input and its own scope.
 * Persistence is atomic and idempotent on the deterministic run id. The persisted time is the database clock; the run keeps its source timestamp separately.
 * No route, no permission and no event: this is the persistence layer the execution API (a later block) will call.
 */
import { createHash } from 'node:crypto';
import {
  BiCalculationRunRepository, BiConflictError, BiNotFoundError, BiValidationError, BiWarehouseRowRepository, type CalculationRunInputRecord, type CalculationRunRecord, type MetricResultRecord, type StoredCalculationRun,
  type TenantContext,
} from '@infinicus/database';
import { canonicalJson } from './bi/metricDefinition.js';
import { buildIntelligenceHandoff, type IntelligenceHandoffErrorCode } from './bi10/intelligenceHandoff.js';
import { MAX_DATASET_ROWS, calculateMetrics, fingerprintRows, type CalculationRun, type MetricResult, type WarehouseRow } from './bi10/metricCalculation.js';
import { BusinessIntelligenceCalculationHandoffService } from './BusinessIntelligenceCalculationHandoffService.js';
import type { SealedDatasetInput } from './PostgresWarehouseRowSource.js';

export type PersistRunErrorCode = IntelligenceHandoffErrorCode | 'INPUT_MISMATCH' | 'RUN_NOT_REPRODUCIBLE' | 'RUN_CONFLICT' | 'PERSISTENCE_REJECTED' | 'STORED_RUN_INTEGRITY';
export type PersistRunResult =
  | { ok: true; run: CalculationRun; replayed: boolean; persistedAt: Date; inputs: CalculationRunInputRecord[] }
  | { ok: false; code: PersistRunErrorCode; detail: string };
export type StoredRunResult = { ok: true; run: CalculationRun; persistedAt: Date; inputs: CalculationRunInputRecord[] } | { ok: false; code: 'STORED_RUN_INTEGRITY'; detail: string };

const fail = (code: PersistRunErrorCode, detail: string): { ok: false; code: PersistRunErrorCode; detail: string } => ({ ok: false, code, detail });

/** What makes a replay recognisable: the whole run except the request's correlation id. */
export const runDigest = (run: CalculationRun): string => createHash('sha256').update(canonicalJson({ ...run, correlationId: '' })).digest('hex');

function toRecord(run: CalculationRun, inputs: ReadonlyMap<string, SealedDatasetInput>): CalculationRunRecord {
  return {
    id: run.calculationRunId, calculationHandoffId: run.calculationHandoffId, warehouseSnapshotId: run.warehouseSnapshotId, correlationId: run.correlationId,
    handoffSourceTimestamp: run.handoffSourceTimestamp, metricCount: run.metricCount, datasets: run.datasets.map((d) => ({ ...d })), runDigest: runDigest(run),
    inputs: run.datasets.map((d) => {
      const i = inputs.get(d.warehouseDatasetId)!;
      return { datasetId: d.warehouseDatasetId, datasetVersionId: i.datasetVersionId, rowCount: d.rowCount, rowsFingerprint: d.rowsFingerprint, sealDigest: i.sealDigest };
    }),
    results: run.results.map((r): MetricResultRecord => ({
      id: r.metricResultId, metricDefinitionId: r.metricId, metricVersion: r.metricVersion, metricCode: r.metricCode, metricType: r.metricType, metricContentHash: r.metricContentHash,
      warehouseDatasetId: r.warehouseDatasetId, groupKey: r.groupKey, groupDimensions: { ...r.group.dimensions }, timeBucket: r.group.timeBucket, value: r.value, unit: r.unit,
      currency: r.currency, target: r.target, thresholdStatus: r.threshold.status, targetMet: r.threshold.targetMet, sourceRowCount: r.sourceRowCount, calculationStatus: r.calculationStatus,
    })),
  };
}

function toRun(s: StoredCalculationRun): CalculationRun {
  const results: MetricResult[] = s.results.map((r) => ({
    metricResultId: r.id, calculationRunId: s.id, calculationHandoffId: s.calculationHandoffId, metricId: r.metricDefinitionId, metricCode: r.metricCode, metricVersion: r.metricVersion,
    metricContentHash: r.metricContentHash, warehouseDatasetId: r.warehouseDatasetId, metricType: r.metricType, group: { dimensions: r.groupDimensions as MetricResult['group']['dimensions'], timeBucket: r.timeBucket },
    groupKey: r.groupKey, value: r.value, unit: r.unit, currency: r.currency, target: r.target,
    threshold: { status: r.thresholdStatus as MetricResult['threshold']['status'], targetMet: r.targetMet }, sourceRowCount: r.sourceRowCount,
    calculationStatus: r.calculationStatus as MetricResult['calculationStatus'],
  }));
  // The calculation orders results by metric code and then group key, with JavaScript string comparison; restore exactly that order.
  results.sort((a, b) => (a.metricCode < b.metricCode ? -1 : a.metricCode > b.metricCode ? 1 : a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));
  return {
    calculationRunId: s.id, calculationHandoffId: s.calculationHandoffId, warehouseSnapshotId: s.warehouseSnapshotId, correlationId: s.correlationId,
    handoffSourceTimestamp: s.handoffSourceTimestamp, metricCount: s.metricCount, datasets: s.datasets.map((d) => ({ ...d })), results,
  };
}

export class BusinessIntelligenceCalculationPersistenceService {
  constructor(
    private readonly runs: BiCalculationRunRepository = new BiCalculationRunRepository(),
    private readonly warehouse: BiWarehouseRowRepository = new BiWarehouseRowRepository(),
    private readonly handoffs: BusinessIntelligenceCalculationHandoffService = new BusinessIntelligenceCalculationHandoffService(),
  ) {}

  async persist(ctx: TenantContext, businessId: string, run: CalculationRun, inputs: ReadonlyMap<string, SealedDatasetInput>): Promise<PersistRunResult> {
    const verified = buildIntelligenceHandoff(run);
    if (!verified.ok) return verified;
    if (run.datasets.length !== inputs.size || run.datasets.some((d) => !inputs.has(d.warehouseDatasetId))) return fail('INPUT_MISMATCH', 'the run and its sealed inputs do not name the same datasets.');
    const sealedRows = new Map<string, readonly WarehouseRow[]>();
    for (const d of run.datasets) {
      const claimed = inputs.get(d.warehouseDatasetId)!;
      if (claimed.rowCount !== d.rowCount) return fail('INPUT_MISMATCH', 'a dataset input states another row count than the run.');
      try {
        const sealed = await this.warehouse.readSealedVersion(ctx, businessId, claimed.datasetVersionId, MAX_DATASET_ROWS + 1);
        if (sealed.datasetId !== d.warehouseDatasetId || sealed.rowsDigest !== claimed.sealDigest || sealed.rowCount !== d.rowCount || sealed.truncated || fingerprintRows(sealed.rows) !== d.rowsFingerprint) {
          return fail('INPUT_MISMATCH', 'the run does not match the sealed warehouse rows it claims to have read.');
        }
        sealedRows.set(d.warehouseDatasetId, sealed.rows);
      } catch (error) {
        if (error instanceof BiNotFoundError || error instanceof BiConflictError) return fail('INPUT_MISMATCH', 'a dataset input is not a sealed, intact warehouse version of this business.');
        throw error;
      }
    }
    if (!(await this.reproduces(ctx, businessId, run, sealedRows))) return fail('RUN_NOT_REPRODUCIBLE', 'the run does not match a recalculation from the registry and the sealed warehouse rows; nothing was stored.');
    let outcome;
    try { outcome = await this.runs.persist(ctx, businessId, toRecord(run, inputs)); }
    catch (error) {
      if (error instanceof BiConflictError) return fail('RUN_CONFLICT', 'a different run already holds this identity.');
      if (error instanceof BiValidationError) return fail('PERSISTENCE_REJECTED', 'the run was refused by the calculation integrity rules; nothing was stored.');
      throw error;
    }
    // Return what is STORED (a replay keeps its first correlation id), verified.
    const stored = await this.get(ctx, businessId, run.calculationRunId);
    return stored.ok ? { ok: true, run: stored.run, replayed: outcome.replayed, persistedAt: stored.persistedAt, inputs: stored.inputs } : stored;
  }

  /**
   * Rebuilds the BI-09 hand-off the run names (every approved metric, or exactly the metrics the run holds results for - whichever has the run's hand-off id) and repeats
   * the calculation over the sealed rows. True only when the recalculated run equals the given one apart from the request correlation id.
   */
  private async reproduces(ctx: TenantContext, businessId: string, run: CalculationRun, rows: ReadonlyMap<string, readonly WarehouseRow[]>): Promise<boolean> {
    const ids = [...new Set(run.results.map((r) => r.metricId))];
    for (const metricIds of [undefined, ids]) {
      const built = await this.handoffs.calculationHandoff(ctx, businessId, { correlationId: run.correlationId, ...(metricIds ? { metricIds } : {}) });
      if (!built.ok || built.handoff.calculationHandoffId !== run.calculationHandoffId) continue;
      const again = calculateMetrics({ handoff: built.handoff, rows });
      return again.ok && runDigest(again.run) === runDigest(run);
    }
    return false;
  }

  /** A stored run, rebuilt and verified (ids re-derived, values and statuses consistent, digest equal to the stored one). NotFoundError for a run of another business or none. */
  async get(ctx: TenantContext, businessId: string, calculationRunId: string): Promise<StoredRunResult> {
    const stored = await this.runs.get(ctx, businessId, calculationRunId);
    const run = toRun(stored);
    const verified = buildIntelligenceHandoff(run);
    if (!verified.ok || runDigest(run) !== stored.runDigest) return { ok: false, code: 'STORED_RUN_INTEGRITY', detail: 'the stored run no longer matches its recorded identity and digest.' };
    return { ok: true, run, persistedAt: stored.persistedAt, inputs: stored.inputs };
  }
}
