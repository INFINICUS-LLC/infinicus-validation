/**
 * The BI-owned warehouse as a WarehouseRowSource (BI-2-DEV-07): the sealed rows of a dataset's latest published version, read through BiWarehouseRowRepository
 * (explicitly scoped, seal re-checked on every read). Fail closed: a scope other than the caller's, a dataset without a sealed version, or rows that no longer
 * match their seal is an error, never an empty or partial set. At most MAX_DATASET_ROWS + 1 rows are fetched so the calculation can REFUSE an oversize dataset
 * instead of silently truncating it. The version and seal each dataset was read from are recorded so a run can state exactly which sealed evidence it used.
 */
import { BiWarehouseRowRepository, type TenantContext } from '@infinicus/database';
import type { MetricScope } from './bi/metricDefinition.js';
import { MAX_DATASET_ROWS, type WarehouseRow } from './bi10/metricCalculation.js';
import type { WarehouseRowSource } from './BusinessIntelligenceMetricCalculationService.js';

export interface SealedDatasetInput { datasetVersionId: string; versionNumber: number; rowCount: number; sealDigest: string }

export class PostgresWarehouseRowSource implements WarehouseRowSource {
  /** The sealed version each dataset was read from, by dataset id. */
  readonly inputs = new Map<string, SealedDatasetInput>();

  constructor(private readonly ctx: TenantContext, private readonly warehouse: BiWarehouseRowRepository = new BiWarehouseRowRepository()) {}

  async rows(scope: MetricScope, warehouseDatasetId: string): Promise<readonly WarehouseRow[]> {
    if (scope.tenantId !== this.ctx.tenantId || scope.workspaceId !== this.ctx.workspaceId) throw new Error('the row source is bound to another tenant or workspace');
    const sealed = await this.warehouse.readLatestSealed(this.ctx, scope.businessId, warehouseDatasetId, MAX_DATASET_ROWS + 1);
    this.inputs.set(sealed.datasetId, { datasetVersionId: sealed.datasetVersionId, versionNumber: sealed.versionNumber, rowCount: sealed.rowCount, sealDigest: sealed.rowsDigest });
    return sealed.rows;
  }
}
