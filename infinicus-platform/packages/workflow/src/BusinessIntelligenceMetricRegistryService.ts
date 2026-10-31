/**
 * BI-09 metric and KPI registry service (BI-2-DEV-02): the frozen registry rules (src/bi) applied to the persisted registry.
 *
 * Every call runs in ONE tenant transaction that holds the business's registry lock (BiMetricRegistryRepository.transaction): it loads the governed registry,
 * resolves the dataset the definition names (the business's own analytical dataset, or the definition is refused), runs the rules, and only then writes. A
 * rule failure writes nothing. The definition's domain is the domain of its dataset; nothing is guessed. Metrics are defined here, never calculated (BI-10),
 * and the BI -> BI-10 hand-off is built from the stored registry on request, with a derived identity, and is not itself stored. Writes metric_definitions / metric_definition_versions only.
 */
import { randomUUID } from 'node:crypto';
import {
  BiMetricRegistryRepository, type MetricHeaderWrite, type MetricRegistrySnapshot, type MetricRegistryTx, type TenantContext,
} from '@infinicus/database';
import {
  metricContentHash, type MetricDefinition, type MetricDefinitionContent, type MetricDefinitionInput, type MetricScope,
} from './bi/metricDefinition.js';
import {
  buildDeterministicCalculationHandoff, latestVersions, registerMetric, reviseMetric, type CalculationHandoff, type MetricLineage, type MetricRegistryErrorCode,
  type WarehouseDatasetRef,
} from './bi/metricRegistry.js';

/** Values the tables accept. The frozen model leaves time grain and status as free text; the persisted registry cannot, so anything else is refused. */
export const PERSISTABLE_TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year', 'all_time'] as const;
export const PERSISTABLE_STATUSES = ['active', 'deprecated', 'retired'] as const;

export type MetricRegistryServiceErrorCode = MetricRegistryErrorCode | 'METRIC_NOT_PERSISTABLE';
export interface MetricRegistryServiceFailure { ok: false; code: MetricRegistryServiceErrorCode; detail: string }
export type MetricWriteResult =
  | { ok: true; metric: MetricDefinition; lineage: MetricLineage; versionId: string }
  | MetricRegistryServiceFailure;
export type MetricHandoffResult = { ok: true; handoff: CalculationHandoff } | MetricRegistryServiceFailure;

const fail = (code: MetricRegistryServiceErrorCode, detail: string): MetricRegistryServiceFailure => ({ ok: false, code, detail });

/** The stored aggregation vocabulary differs from the frozen one in a single word. */
const toStoredAggregation = (a: string | null): string | null => (a === 'count_distinct' ? 'distinct_count' : a);

function contentOf(metric: MetricDefinition): MetricDefinitionContent {
  const { metricId: _id, scope: _scope, createdAt: _created, updatedAt: _updated, ...content } = metric;
  return content;
}

function toDefinitions(snapshot: MetricRegistrySnapshot, scope: MetricScope): MetricDefinition[] {
  return snapshot.versions.map((v) => ({
    ...(v.content as unknown as MetricDefinitionContent),
    metricId: v.metricId,
    scope: { ...scope },
    createdAt: v.definitionCreatedAt.toISOString(),
    updatedAt: v.versionCreatedAt.toISOString(),
  }));
}

function notPersistable(content: MetricDefinitionContent): MetricRegistryServiceFailure | null {
  if (!(PERSISTABLE_TIME_GRAINS as readonly string[]).includes(content.timeGrain)) return fail('METRIC_NOT_PERSISTABLE', `timeGrain must be one of ${PERSISTABLE_TIME_GRAINS.join(', ')}.`);
  if (!(PERSISTABLE_STATUSES as readonly string[]).includes(content.status)) return fail('METRIC_NOT_PERSISTABLE', `status must be one of ${PERSISTABLE_STATUSES.join(', ')}.`);
  return null;
}

export class BusinessIntelligenceMetricRegistryService {
  constructor(private readonly repository: BiMetricRegistryRepository = new BiMetricRegistryRepository()) {}

  /** Register a new metric (version 1). */
  async register(ctx: TenantContext, businessId: string, input: MetricDefinitionInput): Promise<MetricWriteResult> {
    const scope: MetricScope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId };
    return this.repository.transaction(ctx, businessId, async (tx) => {
      const snapshot = await tx.load();
      const dataset = await this.resolve(tx, scope, input);
      const result = registerMetric({ scope, registry: toDefinitions(snapshot, scope), dataset: dataset.ref, input, metricId: randomUUID(), now: new Date() });
      if (!result.ok) return result;
      if (snapshot.ungovernedCodes.includes(result.metric.code)) return fail('METRIC_CODE_DUPLICATE', `Metric code already exists: ${result.metric.code}`);
      return this.write(tx, result.metric, result.lineage, dataset.domain!, true);
    });
  }

  /** Add the next version of a registered metric. */
  async revise(ctx: TenantContext, businessId: string, metricId: string, input: MetricDefinitionInput): Promise<MetricWriteResult> {
    const scope: MetricScope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId };
    return this.repository.transaction(ctx, businessId, async (tx) => {
      const snapshot = await tx.load();
      const dataset = await this.resolve(tx, scope, input);
      const result = reviseMetric({ scope, registry: toDefinitions(snapshot, scope), dataset: dataset.ref, input, metricId, now: new Date() });
      if (!result.ok) return result;
      return this.write(tx, result.metric, result.lineage, dataset.domain!, false);
    });
  }

  /** The latest version of every governed metric of the business, by code. */
  async list(ctx: TenantContext, businessId: string): Promise<MetricDefinition[]> {
    const scope: MetricScope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId };
    const snapshot = await this.repository.load(ctx, businessId);
    return [...latestVersions(toDefinitions(snapshot, scope)).values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

  /** The BI-09 -> BI-10 calculation hand-off over the stored registry. Built on request; not stored. Its id and timestamp are derived from the registry state (BI-2-DEV-04). */
  async calculationHandoff(
    ctx: TenantContext, businessId: string, request: { metricIds?: readonly string[]; warehouseSnapshotId: string | null; correlationId: string },
  ): Promise<MetricHandoffResult> {
    const scope: MetricScope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId };
    const snapshot = await this.repository.load(ctx, businessId);
    return buildDeterministicCalculationHandoff({ scope, registry: toDefinitions(snapshot, scope), ...request });
  }

  /** The dataset the submitted definition names, as the business's own analytical dataset. Null when it is not one (the rules then refuse the definition). */
  private async resolve(tx: MetricRegistryTx, scope: MetricScope, input: MetricDefinitionInput): Promise<{ ref: WarehouseDatasetRef | null; domain: string | null }> {
    if (typeof input.warehouseDatasetId !== 'string') return { ref: null, domain: null };
    const id = input.warehouseDatasetId.trim();
    const found = await tx.resolveDataset(id);
    // The analytical dataset table carries no contract id, so none is invented.
    return found ? { ref: { warehouseDatasetId: found.id, datasetContractId: null, scope }, domain: found.domain } : { ref: null, domain: null };
  }

  private async write(tx: MetricRegistryTx, metric: MetricDefinition, lineage: MetricLineage, domain: string, first: boolean): Promise<MetricWriteResult> {
    const content = contentOf(metric);
    const problem = notPersistable(content);
    if (problem) return problem;
    const header: MetricHeaderWrite = {
      metricCode: content.code, domain, metricType: content.metricType, name: content.name, description: content.description, unit: content.unit,
      currencyCode: content.currency, status: content.status,
    };
    const version = {
      metricId: metric.metricId,
      versionNumber: content.version,
      warehouseDatasetId: content.warehouseDatasetId,
      content: content as unknown as Record<string, unknown>,
      contentHash: metricContentHash(content),
      aggregationMethod: toStoredAggregation(content.aggregation),
      timeGrain: content.timeGrain,
      dimensionalFilters: content.filters,
      calculationSpecification: {
        sourceField: content.sourceField, formula: content.formula, dependencies: content.dependencies, dimensions: content.dimensions, target: content.target,
        thresholds: content.thresholds,
      },
      correlationId: randomUUID(),
    };
    const stored = first ? await tx.insertFirstVersion(header, version) : await tx.insertNextVersion(header, version);
    // The timestamps are the database's, so the result is exactly what a later read returns.
    return { ok: true, metric: { ...metric, createdAt: stored.definitionCreatedAt.toISOString(), updatedAt: stored.versionCreatedAt.toISOString() }, lineage, versionId: stored.versionId };
  }
}
