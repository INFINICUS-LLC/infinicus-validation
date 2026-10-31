/**
 * BI-09 -> BI-10 calculation hand-off, read side (BI-2-DEV-04). Read-only: it loads the governed registry through the SELECT-only read repository, applies
 * the frozen hand-off rules (only approved, active metrics at their latest version; dependencies inside the hand-off) and returns a hand-off whose identity
 * is derived from its content (buildDeterministicCalculationHandoff). Nothing is written, no id is generated, no clock is read, nothing is calculated (BI-10).
 *
 * Contract resolutions (BI-2-DEV-04): D-A the warehouse snapshot id is null - no snapshot record exists in the Stage 2D schema, so none is invented;
 * D-B the id is derived from scope + metric ids/versions/content hashes + snapshot; D-C `createdAt` is the stored creation time of the newest handed-over
 * version, so it is stable across replays; D-D the correlation id is the caller's request correlation id, carried unchanged.
 */
import { BiMetricRegistryReadRepository, type GovernedMetricView, type TenantContext } from '@infinicus/database';
import type { MetricDefinition, MetricDefinitionContent, MetricScope } from './bi/metricDefinition.js';
import { buildDeterministicCalculationHandoff, type CalculationHandoff, type MetricRegistryErrorCode } from './bi/metricRegistry.js';

export interface CalculationHandoffReadRequest {
  /** Metric ids to hand over; absent or empty means every approved active metric of the business. */
  metricIds?: readonly string[];
  /** The caller's request correlation id, carried into the hand-off unchanged. */
  correlationId: string;
}
export type CalculationHandoffReadResult = { ok: true; handoff: CalculationHandoff } | { ok: false; code: MetricRegistryErrorCode; detail: string };

/** A stored view as the rules see a definition. The stored header status and time grain are authoritative over the copy inside the content. */
function toDefinition(view: GovernedMetricView, scope: MetricScope): MetricDefinition {
  return {
    ...(view.content as unknown as MetricDefinitionContent),
    status: view.status,
    timeGrain: view.timeGrain,
    metricId: view.metricId,
    scope: { ...scope },
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

export class BusinessIntelligenceCalculationHandoffService {
  constructor(private readonly registry: BiMetricRegistryReadRepository = new BiMetricRegistryReadRepository()) {}

  async calculationHandoff(ctx: TenantContext, businessId: string, request: CalculationHandoffReadRequest): Promise<CalculationHandoffReadResult> {
    const views = await this.registry.listAllLatest(ctx, businessId);
    const scope: MetricScope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: businessId.toLowerCase() };
    return buildDeterministicCalculationHandoff({
      scope,
      registry: views.map((v) => toDefinition(v, scope)),
      ...(request.metricIds ? { metricIds: request.metricIds } : {}),
      warehouseSnapshotId: null,
      correlationId: request.correlationId,
    });
  }
}
