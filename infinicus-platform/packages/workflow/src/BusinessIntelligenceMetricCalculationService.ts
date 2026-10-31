/**
 * BI-10 metric calculation service (BI-2-DEV-05). Read-only composition: the scoped, approved BI-09 hand-off (BusinessIntelligenceCalculationHandoffService, which
 * reads the registry through the SELECT-only repository) + the warehouse rows of the datasets that hand-off names (a WarehouseRowSource the caller supplies) +
 * the pure calculation (calculateMetrics). Nothing is written and nothing is invented: the platform has no warehouse row store yet, so rows can only come from a
 * source that is authorised to provide them, and the source is asked only for datasets that belong to the hand-off, in the hand-off's own scope.
 */
import type { TenantContext } from '@infinicus/database';
import { BusinessIntelligenceCalculationHandoffService, type CalculationHandoffReadRequest } from './BusinessIntelligenceCalculationHandoffService.js';
import type { MetricScope } from './bi/metricDefinition.js';
import { calculateMetrics, type CalculationErrorCode, type CalculationRun, type WarehouseRow } from './bi10/metricCalculation.js';
import { buildIntelligenceHandoff, type IntelligenceHandoff, type IntelligenceHandoffErrorCode } from './bi10/intelligenceHandoff.js';
import { BusinessIntelligenceCalculationPersistenceService, type PersistRunErrorCode } from './BusinessIntelligenceCalculationPersistenceService.js';
import { PostgresWarehouseRowSource } from './PostgresWarehouseRowSource.js';
import type { MetricRegistryErrorCode } from './bi/metricRegistry.js';

/** Supplies the rows of one warehouse dataset of one business, in the dataset's stable order. Called only with a scope and dataset id taken from the hand-off. */
export interface WarehouseRowSource { rows(scope: MetricScope, warehouseDatasetId: string): Promise<readonly WarehouseRow[]> }

export type MetricCalculationServiceResult =
  | { ok: true; run: CalculationRun }
  | { ok: false; code: CalculationErrorCode | MetricRegistryErrorCode; detail: string };

export type MetricCalculationWithHandoffResult =
  | { ok: true; run: CalculationRun; intelligenceHandoff: IntelligenceHandoff }
  | { ok: false; code: CalculationErrorCode | MetricRegistryErrorCode | IntelligenceHandoffErrorCode; detail: string };

export type MetricCalculationPersistedResult =
  | { ok: true; run: CalculationRun; replayed: boolean; persistedAt: Date }
  | { ok: false; code: CalculationErrorCode | MetricRegistryErrorCode | PersistRunErrorCode; detail: string };

export class BusinessIntelligenceMetricCalculationService {
  constructor(
    private readonly handoffs: BusinessIntelligenceCalculationHandoffService = new BusinessIntelligenceCalculationHandoffService(),
    private readonly persistence: BusinessIntelligenceCalculationPersistenceService = new BusinessIntelligenceCalculationPersistenceService(),
  ) {}

  async calculate(ctx: TenantContext, businessId: string, request: CalculationHandoffReadRequest, source: WarehouseRowSource): Promise<MetricCalculationServiceResult> {
    const built = await this.handoffs.calculationHandoff(ctx, businessId, request);
    if (!built.ok) return built;
    const handoff = built.handoff;
    const rows = new Map<string, readonly WarehouseRow[]>();
    for (const id of [...new Set(handoff.metrics.filter((m) => m.metricType === 'base').map((m) => m.warehouseDatasetId))].sort()) {
      try { rows.set(id, await source.rows({ ...handoff.scope }, id)); }
      catch { return { ok: false, code: 'DATASET_ROWS_UNAVAILABLE', detail: 'the rows of a dataset named by the hand-off could not be read.' }; }
    }
    return calculateMetrics({ handoff, rows });
  }

  /** The calculation and the BI-10 -> BI-11..BI-18 intelligence hand-off built from it (BI-2-DEV-06). Neither is stored or published here. */
  async calculateForIntelligence(ctx: TenantContext, businessId: string, request: CalculationHandoffReadRequest, source: WarehouseRowSource): Promise<MetricCalculationWithHandoffResult> {
    const calculated = await this.calculate(ctx, businessId, request, source);
    if (!calculated.ok) return calculated;
    const handed = buildIntelligenceHandoff(calculated.run);
    return handed.ok ? { ok: true, run: calculated.run, intelligenceHandoff: handed.handoff } : handed;
  }

  /**
   * The calculation over the business's SEALED warehouse rows, persisted (BI-2-DEV-07). Rows come only from the BI warehouse (PostgresWarehouseRowSource); the run is
   * verified against the sealed evidence, stored atomically and idempotently, and returned as stored. No route and no permission: the execution API is a later block.
   */
  async calculateAndPersist(ctx: TenantContext, businessId: string, request: CalculationHandoffReadRequest): Promise<MetricCalculationPersistedResult> {
    const source = new PostgresWarehouseRowSource(ctx);
    const calculated = await this.calculate(ctx, businessId, request, source);
    if (!calculated.ok) return calculated;
    return this.persistence.persist(ctx, businessId, calculated.run, source.inputs);
  }
}
