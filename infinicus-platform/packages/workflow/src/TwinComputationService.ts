import {
  DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository, DigitalTwinSnapshotRepository,
  BusinessEventRepository, type TenantContext,
} from '@infinicus/database';
import { assessTwinEvidence } from './twinEvidence.js';

const TWIN_DEFINITION_CODE = 'operational-twin';
const TWIN_INSTANCE_CODE = 'operational-twin';
const TWIN_METRIC_CODE = 'twin_snapshot';
const TWIN_TTL_MS = 60 * 60 * 1000; // 1 hour — matches the legacy KV cache TTL this replaces.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30-day lookback window, matching legacy twin.js.

export interface TwinFinancial {
  profit30d: number;
  revenue30d: number;
  salesCount30d: number;
  expenses30d: number;
  burnRatePerDay: number;
}
export interface TwinCustomers {
  new30d: number;
  returning30d: number;
  churned30d: number;
  churnRatePct: number;
}
export interface TwinOperations {
  netInventoryUnits30d: number;
}
export interface TwinTeam {
  hired30d: number;
  terminated30d: number;
  netHeadcountDelta: number;
}

export interface TwinSnapshotResult {
  businessId: string;
  snapshotAt: string;
  windowDays: number;
  financial: TwinFinancial;
  customers: TwinCustomers;
  operations: TwinOperations;
  team: TwinTeam;
}

/**
 * Computes and persists Digital Twin snapshots from the business_events
 * ledger (packages/database's BusinessEventRepository), through the real
 * DT create -> validate -> publish lifecycle — not a shortcut around it.
 * Replaces the legacy functions/api/business/twin.js's rebuild-from-D1 +
 * 1-hour-KV-cache behavior: "cache" here means checking the latest
 * published snapshot's age, no separate cache infrastructure needed.
 */
export class TwinComputationService {
  constructor(
    private readonly definitions: DigitalTwinDefinitionRepository = new DigitalTwinDefinitionRepository(),
    private readonly instances: DigitalTwinInstanceRepository = new DigitalTwinInstanceRepository(),
    private readonly snapshots: DigitalTwinSnapshotRepository = new DigitalTwinSnapshotRepository(),
    private readonly events: BusinessEventRepository = new BusinessEventRepository()
  ) {}

  async getOrComputeTwin(
    ctx: TenantContext,
    businessId: string,
    opts: { forceRefresh?: boolean } = {}
  ): Promise<{ twin: TwinSnapshotResult; cached: boolean }> {
    const instance = await this.ensureInstance(ctx, businessId);

    if (!opts.forceRefresh) {
      const published = await this.snapshots.getPublishedForInstance(ctx, instance.id);
      const latest = published[0]; // ordered by effectiveAt DESC
      if (latest && Date.now() - latest.effectiveAt.getTime() < TWIN_TTL_MS) {
        const values = await this.snapshots.getValuesForPublishedSnapshot(ctx, latest.id);
        const stored = values.find((v) => v.variableCode === TWIN_METRIC_CODE);
        if (stored) return { twin: stored.valueJson as TwinSnapshotResult, cached: true };
      }
    }

    return { twin: await this.computeAndPublish(ctx, businessId, instance.id), cached: false };
  }

  private async ensureInstance(ctx: TenantContext, businessId: string) {
    const existing = await this.instances.getActiveForBusiness(ctx, businessId);
    if (existing[0]) return existing[0];

    const definition = await this.definitions.createDefinition(ctx, businessId, TWIN_DEFINITION_CODE, 'Operational Digital Twin');
    const definitionVersion = await this.definitions.createVersion(ctx, definition.id, businessId, {
      description: 'Financial, customer, operations, and team KPIs derived from the business_events ledger.',
    });
    await this.definitions.validateVersion(ctx, definitionVersion.id);
    await this.definitions.activateVersion(ctx, definitionVersion.id);

    const instance = await this.instances.createInstance(ctx, businessId, definition.id, TWIN_INSTANCE_CODE);
    await this.instances.createVersion(ctx, instance.id, businessId, definitionVersion.id);
    return this.instances.transitionStatus(ctx, instance.id, 'active', 'initial provisioning');
  }

  private async computeAndPublish(ctx: TenantContext, businessId: string, instanceId: string): Promise<TwinSnapshotResult> {
    const now = new Date();
    const from = new Date(now.getTime() - WINDOW_MS);

    const [sales, expenses, customers, inventory, team] = await Promise.all([
      this.events.aggregateSales(ctx, businessId, from, now),
      this.events.aggregateExpenses(ctx, businessId, from, now),
      this.events.aggregateCustomers(ctx, businessId, from, now),
      this.events.aggregateInventory(ctx, businessId, from, now),
      this.events.aggregateTeam(ctx, businessId, from, now),
    ]);

    const twin: TwinSnapshotResult = {
      businessId,
      snapshotAt: now.toISOString(),
      windowDays: 30,
      financial: {
        revenue30d: sales.totalRevenue,
        expenses30d: expenses.totalSpend,
        profit30d: Math.round((sales.totalRevenue - expenses.totalSpend) * 100) / 100,
        burnRatePerDay: expenses.burnRatePerDay,
        salesCount30d: sales.transactionCount,
      },
      customers: {
        new30d: customers.newCustomers,
        returning30d: customers.returning,
        churned30d: customers.churned,
        churnRatePct: customers.churnRatePct,
      },
      operations: { netInventoryUnits30d: inventory.netUnitsDelta },
      team: {
        hired30d: team.hired,
        terminated30d: team.fired,
        netHeadcountDelta: team.netHeadcountDelta,
      },
    };

    const stamp = Date.now().toString(36);
    const { snapshot, version } = await this.snapshots.createSnapshot(
      ctx, businessId, instanceId, `twin-${stamp}`, now,
      assessTwinEvidence(twin).overall === 'insufficient'
        ? `Twin recomputed: insufficient data (no activity recorded in the last ${twin.windowDays} days)`
        : `Twin recomputed: profit30d=${twin.financial.profit30d}, churn=${twin.customers.churnRatePct}%`
    );
    await this.snapshots.addValue(ctx, version.id, TWIN_METRIC_CODE, twin);
    await this.snapshots.validateSnapshot(ctx, snapshot.id, version.id);
    await this.snapshots.publishSnapshot(ctx, snapshot.id, version.id);

    return twin;
  }
}
