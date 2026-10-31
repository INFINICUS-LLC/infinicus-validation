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
import type { MetricRegistryErrorCode } from './bi/metricRegistry.js';

/** Supplies the rows of one warehouse dataset of one business, in the dataset's stable order. Called only with a scope and dataset id taken from the hand-off. */
export interface WarehouseRowSource { rows(scope: MetricScope, warehouseDatasetId: string): Promise<readonly WarehouseRow[]> }

export type MetricCalculationServiceResult =
  | { ok: true; run: CalculationRun }
  | { ok: false; code: CalculationErrorCode | MetricRegistryErrorCode; detail: string };

export class BusinessIntelligenceMetricCalculationService {
  constructor(private readonly handoffs: BusinessIntelligenceCalculationHandoffService = new BusinessIntelligenceCalculationHandoffService()) {}

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
}
