/**
 * Business Digital Twin current state of one inventory item (AC-2 Block 6). BDT models the PRESENT state needed for decision modeling; it is not a second
 * operational source of truth and mutates nothing real.
 *
 *  - Input boundary: it consumes BI evidence ONLY (the BI service's read side, structurally), never Business Operations: BO -> BI -> BDT.
 *  - It reuses the existing twin lifecycle exactly as `TwinComputationService` does (definition -> instance -> snapshot -> value + evidence -> validate -> publish),
 *    with its own definition/instance (`inventory-item-twin`), in ONE shared tenant transaction so a half-built twin is never visible.
 *  - The state is DERIVED (average daily demand, days of cover, policy position) and carries REFERENCES (BI insight package version and metric ids, the BO fact
 *    digest) rather than copies of operational facts; the snapshot's effective time is the BO capture time of the evidence it was derived from.
 *  - Fail closed: missing, expired, incomplete or internally inconsistent BI evidence publishes nothing.
 *  - Published snapshots are immutable; a newer published snapshot of the business supersedes older ones under the existing P0-3 freshness rule.
 */
import { randomUUID } from 'node:crypto';
import {
  DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository, DigitalTwinSnapshotRepository, withSharedTenantTransaction,
  type DigitalTwinInstance, type TenantContext,
} from '@infinicus/database';
import { BI_METRIC_DEMAND, BI_METRIC_STOCK, type InventoryBiEvidence } from './InventoryBiEvidenceService.js';
import { INVENTORY_ITEM_TWIN_MODEL, INVENTORY_ITEM_TWIN_STATE_SCHEMA, deriveInventoryItemTwinState, type InventoryItemTwinDerived } from './inventoryItemTwinState.js';

export const INVENTORY_ITEM_TWIN_CODE = 'inventory-item-twin';
export const INVENTORY_ITEM_TWIN_VARIABLE = 'inventory_item_state';
export const TWIN_EVIDENCE_BI_VERSION = 'bi_insight_package_version';
export const TWIN_EVIDENCE_BO_FACTS = 'bo_inventory_policy_facts';

/** The BI read side the twin consumes (structural: `InventoryBiEvidenceService.getLatest` satisfies it). */
export interface InventoryBiEvidenceReader {
  getLatest(ctx: TenantContext, businessId: string, itemId: string): Promise<InventoryBiEvidence | null>;
}

export interface InventoryItemTwinState {
  schema: typeof INVENTORY_ITEM_TWIN_STATE_SCHEMA;
  model: typeof INVENTORY_ITEM_TWIN_MODEL;
  inventoryItemId: string;
  observedAt: string;
  validUntil: string;
  factsDigest: string;
  derived: InventoryItemTwinDerived;
  references: { biInsightPackageId: string; biInsightPackageVersionId: string; biVersionNumber: number; biMetricValueIds: Record<string, string>; boBalanceId: string; ruleSetVersion: string };
}

export type PublishInventoryItemTwinResult =
  | { outcome: 'PUBLISHED'; snapshotId: string; snapshotVersionId: string; instanceId: string; effectiveAt: string; validUntil: string; factsDigest: string; state: InventoryItemTwinState }
  | { outcome: 'NOT_PUBLISHED'; code: 'BI_EVIDENCE_MISSING' | 'BI_EVIDENCE_EXPIRED' | 'BI_EVIDENCE_INCOMPLETE' | 'BI_EVIDENCE_INCONSISTENT'; detail: string };

export interface InventoryItemTwinDependencies {
  bi: InventoryBiEvidenceReader;
  definitions: Pick<DigitalTwinDefinitionRepository, 'createDefinition' | 'createVersion' | 'validateVersion' | 'activateVersion'>;
  instances: Pick<DigitalTwinInstanceRepository, 'createInstance' | 'createVersion' | 'transitionStatus' | 'getActiveForBusiness'>;
  snapshots: Pick<DigitalTwinSnapshotRepository, 'createSnapshot' | 'addValue' | 'addEvidence' | 'validateSnapshot' | 'publishSnapshot' | 'getPublishedForInstance' | 'getValuesForPublishedSnapshot' | 'assessFreshness'>;
  now: () => Date;
}

export class InventoryItemTwinService {
  private readonly d: InventoryItemTwinDependencies;
  constructor(deps: Pick<InventoryItemTwinDependencies, 'bi'> & Partial<InventoryItemTwinDependencies>) {
    this.d = {
      bi: deps.bi,
      definitions: deps.definitions ?? new DigitalTwinDefinitionRepository(),
      instances: deps.instances ?? new DigitalTwinInstanceRepository(),
      snapshots: deps.snapshots ?? new DigitalTwinSnapshotRepository(),
      now: deps.now ?? (() => new Date()),
    };
  }

  private async ensureInstance(ctx: TenantContext, businessId: string): Promise<DigitalTwinInstance> {
    const existing = (await this.d.instances.getActiveForBusiness(ctx, businessId)).find((i) => i.instanceCode === INVENTORY_ITEM_TWIN_CODE);
    if (existing) return existing;
    const definition = await this.d.definitions.createDefinition(ctx, businessId, INVENTORY_ITEM_TWIN_CODE, 'Inventory item twin');
    const version = await this.d.definitions.createVersion(ctx, definition.id, businessId, {
      description: 'Modeled present state of an inventory item (average daily demand, days of cover, policy position), derived from Business Intelligence evidence.',
      stateSchema: INVENTORY_ITEM_TWIN_STATE_SCHEMA,
    });
    await this.d.definitions.validateVersion(ctx, version.id);
    await this.d.definitions.activateVersion(ctx, version.id);
    const instance = await this.d.instances.createInstance(ctx, businessId, definition.id, INVENTORY_ITEM_TWIN_CODE);
    await this.d.instances.createVersion(ctx, instance.id, businessId, version.id);
    return this.d.instances.transitionStatus(ctx, instance.id, 'active', 'initial provisioning');
  }

  async publish(ctx: TenantContext, request: { businessId: string; itemId: string }): Promise<PublishInventoryItemTwinResult> {
    const ev = await this.d.bi.getLatest(ctx, request.businessId, request.itemId);
    const none = (code: Extract<PublishInventoryItemTwinResult, { outcome: 'NOT_PUBLISHED' }>['code'], detail: string): PublishInventoryItemTwinResult => ({ outcome: 'NOT_PUBLISHED', code, detail });
    if (ev === null) return none('BI_EVIDENCE_MISSING', 'no BI evidence has been published for this item');
    if (this.d.now().getTime() >= Date.parse(ev.validUntil)) return none('BI_EVIDENCE_EXPIRED', `the BI evidence expired at ${ev.validUntil}`);
    const demand = ev.metrics[BI_METRIC_DEMAND]; const stock = ev.metrics[BI_METRIC_STOCK];
    if (!demand || !stock) return none('BI_EVIDENCE_INCOMPLETE', 'the BI evidence lacks the demand or the stock metric');
    for (const m of [demand, stock]) {
      if (m.dimensions.factsDigest !== ev.factsDigest || m.dimensions.inventoryItemId !== request.itemId) return none('BI_EVIDENCE_INCONSISTENT', 'a BI metric does not describe the same item and fact digest as its evidence version');
    }
    const num = (v: unknown): number => Number(v);
    const derivation = deriveInventoryItemTwinState({
      demandUnits: num(demand.exact), demandObservations: num(demand.dimensions.observations), windowDays: num(demand.dimensions.windowDays),
      onHandUnits: num(stock.exact), reorderPoint: num(stock.dimensions.reorderPoint), reorderQuantity: num(stock.dimensions.reorderQuantity),
    });
    if (!derivation.ok) return none('BI_EVIDENCE_INCOMPLETE', derivation.problem);
    const balanceId = stock.dimensions.balanceId;
    if (typeof balanceId !== 'string') return none('BI_EVIDENCE_INCOMPLETE', 'the stock metric does not identify its balance');

    const state: InventoryItemTwinState = {
      schema: INVENTORY_ITEM_TWIN_STATE_SCHEMA, model: INVENTORY_ITEM_TWIN_MODEL, inventoryItemId: request.itemId, observedAt: ev.capturedAt, validUntil: ev.validUntil, factsDigest: ev.factsDigest,
      derived: derivation.derived,
      references: {
        biInsightPackageId: ev.insightPackageId, biInsightPackageVersionId: ev.insightPackageVersionId, biVersionNumber: ev.versionNumber,
        biMetricValueIds: Object.fromEntries(Object.entries(ev.metrics).map(([code, m]) => [code, m.id])), boBalanceId: balanceId, ruleSetVersion: ev.ruleSetVersion,
      },
    };
    return withSharedTenantTransaction(ctx, async () => {
      const instance = await this.ensureInstance(ctx, request.businessId);
      const { snapshot, version } = await this.d.snapshots.createSnapshot(
        ctx, request.businessId, instance.id, `inventory-item-${request.itemId}-${randomUUID().slice(0, 8)}`, new Date(ev.capturedAt),
        `Inventory item state: ${derivation.derived.daysOfCover === null ? 'no demand in the window' : `${derivation.derived.daysOfCover} days of cover`}, ${derivation.derived.policyPosition}`,
      );
      await this.d.snapshots.addValue(ctx, version.id, INVENTORY_ITEM_TWIN_VARIABLE, state);
      await this.d.snapshots.addEvidence(ctx, version.id, TWIN_EVIDENCE_BI_VERSION, { insightPackageId: ev.insightPackageId, insightPackageVersionId: ev.insightPackageVersionId, versionNumber: ev.versionNumber, factsDigest: ev.factsDigest, validUntil: ev.validUntil });
      await this.d.snapshots.addEvidence(ctx, version.id, TWIN_EVIDENCE_BO_FACTS, { digest: ev.factsDigest, capturedAt: ev.capturedAt, balanceId, ruleSetVersion: ev.ruleSetVersion });
      await this.d.snapshots.validateSnapshot(ctx, snapshot.id, version.id);
      await this.d.snapshots.publishSnapshot(ctx, snapshot.id, version.id);
      return { outcome: 'PUBLISHED' as const, snapshotId: snapshot.id, snapshotVersionId: version.id, instanceId: instance.id, effectiveAt: ev.capturedAt, validUntil: ev.validUntil, factsDigest: ev.factsDigest, state };
    });
  }

  /** The existing P0-3 freshness rule for a twin snapshot: `usable` when it was published; `newerPublishedExists` when a newer snapshot of the business has been published since. Read-only. */
  async assessFreshness(ctx: TenantContext, businessId: string, snapshotId: string): Promise<{ usable: boolean; newerPublishedExists: boolean }> {
    return this.d.snapshots.assessFreshness(ctx, businessId, snapshotId);
  }

  /** The newest published twin state of an item (its snapshot id, effective time and state), or null. Read-only. */
  async getLatest(ctx: TenantContext, businessId: string, itemId: string): Promise<{ snapshotId: string; effectiveAt: string; state: InventoryItemTwinState } | null> {
    const instance = (await this.d.instances.getActiveForBusiness(ctx, businessId)).find((i) => i.instanceCode === INVENTORY_ITEM_TWIN_CODE);
    if (!instance) return null;
    // Snapshots come newest first by effective time, which has one-second resolution: two states published within the same second tie, so the tie is broken
    // deterministically by the BI evidence version each was derived from (the later evidence wins). The scan stops once an older effective time is reached.
    let best: { snapshotId: string; effectiveAt: string; state: InventoryItemTwinState } | null = null;
    for (const snap of await this.d.snapshots.getPublishedForInstance(ctx, instance.id)) {
      if (best !== null && snap.effectiveAt.toISOString() < best.effectiveAt) break;
      const value = (await this.d.snapshots.getValuesForPublishedSnapshot(ctx, snap.id)).find((v) => v.variableCode === INVENTORY_ITEM_TWIN_VARIABLE);
      const state = value?.valueJson as InventoryItemTwinState | undefined;
      if (!state || state.inventoryItemId !== itemId) continue;
      if (best === null || state.references.biVersionNumber > best.state.references.biVersionNumber) best = { snapshotId: snap.id, effectiveAt: snap.effectiveAt.toISOString(), state };
    }
    return best;
  }
}

