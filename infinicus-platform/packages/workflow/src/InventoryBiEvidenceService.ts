/**
 * Business Intelligence evidence for the first action (AC-2 Block 5): descriptive, immutable, referenced analytical facts about one inventory item,
 * derived from Business Operations truth and published as a versioned insight package so downstream layers (Digital Twin, ADI) consume BI evidence
 * instead of an ad-hoc BO snapshot.
 *
 *  - BI OWNS analytical evidence, not operational mutation: it reads BO only through the structural {@link InventoryEvidenceFactsPort} (read-only; joined
 *    at the API composition root, so this package never imports Business Operations) and writes ONLY BI tables through the existing BI repositories.
 *  - It uses the existing abstractions: metric definitions (once per business), append-only metric calculations (one per fact, with an evidence reference
 *    to the BO fact digest) and an insight package VERSION that references those calculations by id. No new table, no new store.
 *  - It is DESCRIPTIVE and never fabricates: a fact that does not exist (no receipt cost) produces no metric; demand with zero observations is published as
 *    exactly that. Whether the evidence is sufficient for a recommendation is ADI's decision, not BI's.
 *  - Every metric carries the BO fact-snapshot digest (the same digest the BO evaluation records and the ADI proposal cite), the BO capture time and the
 *    evidence expiry, so freshness and consistency can be verified later and a mismatch fails closed downstream.
 *  - All writes commit in ONE tenant transaction: a partial evidence set is never visible.
 */
import { randomUUID } from 'node:crypto';
import {
  InsightPackageRepository, MetricCalculationRepository, MetricDefinitionRepository, withSharedTenantTransaction,
  type MetricCalculatedValue, type TenantContext,
} from '@infinicus/database';

/** The read-only BO facts BI needs (structural: Business Operations' `InventoryEvidenceFactsService` satisfies it; this package never imports it). */
export interface InventoryEvidenceFactsView {
  businessId: string;
  itemId: string;
  ruleSetVersion: string;
  snapshotDigest: string;
  capturedAt: string;
  windowStartsAt: string;
  windowDays: number;
  evidenceMaxAgeMs: number;
  demandMovementTypes: string[];
  balance: { id: string; warehouseId: string; quantityOnHand: string; reorderPoint: string; reorderQuantity: string } | null;
  balanceCount: number;
  latestReceipt: { movementId: string; occurredAt: string; cost: string | null; costCurrency: string | null; costCurrencyMatchesBusinessCurrency: boolean | null } | null;
  demand: { count: number; sumOfMagnitudes: string };
}
export type InventoryEvidenceFactsResultView =
  | { outcome: 'FACTS'; facts: InventoryEvidenceFactsView }
  | { outcome: 'UNAVAILABLE'; code: string; detail: string };
export interface InventoryEvidenceFactsPort {
  load(ctx: TenantContext, request: { businessId: string; itemId: string; ruleSetVersion: string }): Promise<InventoryEvidenceFactsResultView>;
}

export const BI_INVENTORY_EVIDENCE_SOURCE = 'BO';
export const BI_INVENTORY_EVIDENCE_KIND = 'bo_inventory_policy_facts';
export const BI_INVENTORY_DOMAIN = 'inventory_supply';
export const BI_METRIC_DEMAND = 'inventory.demand.issued_units';
export const BI_METRIC_STOCK = 'inventory.stock.on_hand_units';
export const BI_METRIC_RECEIPT_COST = 'inventory.receipt.latest_cost_per_unit';
export const biEvidencePackageCode = (itemId: string): string => `inventory-evidence-${itemId}`;

const DEFINITIONS = [
  { metricCode: BI_METRIC_DEMAND, name: 'Units issued in the demand window', unit: 'unit', aggregationMethod: 'sum', timeGrain: 'day' },
  { metricCode: BI_METRIC_STOCK, name: 'Units on hand', unit: 'unit', aggregationMethod: 'last', timeGrain: 'day' },
  { metricCode: BI_METRIC_RECEIPT_COST, name: 'Cost per unit of the latest receipt', unit: 'cost_per_unit', aggregationMethod: 'last', timeGrain: 'day' },
] as const;

export type PublishInventoryBiEvidenceResult =
  | { outcome: 'PUBLISHED'; insightPackageId: string; insightPackageVersionId: string; versionNumber: number; metricValueIds: Record<string, string>; factsDigest: string; capturedAt: string; validUntil: string }
  | { outcome: 'NOT_PUBLISHED'; code: 'TARGET_NOT_FOUND' | 'BALANCE_UNAVAILABLE' | 'INVALID_REQUEST'; detail: string };

/** The BI evidence of one item as stored (read side, used by the Digital Twin and ADI blocks). */
export interface InventoryBiEvidence {
  insightPackageId: string;
  insightPackageVersionId: string;
  versionNumber: number;
  factsDigest: string;
  capturedAt: string;
  validUntil: string;
  ruleSetVersion: string;
  metrics: Record<string, { id: string; value: number; exact: string; unit: string; currencyCode: string | null; dimensions: Record<string, unknown> }>;
}

export interface InventoryBiEvidenceDependencies {
  facts: InventoryEvidenceFactsPort;
  definitions: Pick<MetricDefinitionRepository, 'findByCode' | 'create' | 'findLatestVersion' | 'findById'>;
  calculations: Pick<MetricCalculationRepository, 'recordCalculation' | 'findById'>;
  packages: Pick<InsightPackageRepository, 'findByCode' | 'create' | 'publishVersion' | 'findLatestVersion' | 'findVersionById'>;
}

export class InventoryBiEvidenceService {
  private readonly d: InventoryBiEvidenceDependencies;
  constructor(deps: Pick<InventoryBiEvidenceDependencies, 'facts'> & Partial<InventoryBiEvidenceDependencies>) {
    this.d = {
      facts: deps.facts,
      definitions: deps.definitions ?? new MetricDefinitionRepository(),
      calculations: deps.calculations ?? new MetricCalculationRepository(),
      packages: deps.packages ?? new InsightPackageRepository(),
    };
  }

  private async ensureDefinition(ctx: TenantContext, businessId: string, def: (typeof DEFINITIONS)[number]): Promise<{ definitionId: string; versionId: string }> {
    const definition = await this.d.definitions.findByCode(ctx, businessId, def.metricCode);
    if (definition === null) {
      const created = await this.d.definitions.create(ctx, { businessId, metricCode: def.metricCode, domain: BI_INVENTORY_DOMAIN, metricType: 'base', name: def.name, unit: def.unit, aggregationMethod: def.aggregationMethod, timeGrain: def.timeGrain });
      return { definitionId: created.definition.id, versionId: created.version.id };
    }
    return { definitionId: definition.id, versionId: (await this.d.definitions.findLatestVersion(ctx, definition.id)).id };
  }

  async publish(ctx: TenantContext, request: { businessId: string; itemId: string; ruleSetVersion: string; correlationId?: string }): Promise<PublishInventoryBiEvidenceResult> {
    const loaded = await this.d.facts.load(ctx, { businessId: request.businessId, itemId: request.itemId, ruleSetVersion: request.ruleSetVersion });
    if (loaded.outcome === 'UNAVAILABLE') {
      return { outcome: 'NOT_PUBLISHED', code: loaded.code === 'TARGET_NOT_FOUND' ? 'TARGET_NOT_FOUND' : 'INVALID_REQUEST', detail: loaded.detail };
    }
    const f = loaded.facts;
    if (f.balance === null) {
      return { outcome: 'NOT_PUBLISHED', code: 'BALANCE_UNAVAILABLE', detail: `the item has ${f.balanceCount} inventory balances; the evidence needs exactly one` };
    }
    const balance = f.balance;
    const validUntil = new Date(Date.parse(f.capturedAt) + f.evidenceMaxAgeMs).toISOString();
    const correlationId = request.correlationId ?? randomUUID();
    const periodStart = new Date(f.windowStartsAt);
    const periodEnd = new Date(f.capturedAt);
    const reference = (extra: Record<string, unknown>) => ({
      source: BI_INVENTORY_EVIDENCE_SOURCE, kind: BI_INVENTORY_EVIDENCE_KIND, factsDigest: f.snapshotDigest, capturedAt: f.capturedAt,
      ruleSetVersion: f.ruleSetVersion, validUntil, ...extra,
    });
    const common = { inventoryItemId: f.itemId, factsDigest: f.snapshotDigest, boCapturedAt: f.capturedAt, validUntil };

    return withSharedTenantTransaction(ctx, async () => {
      const metricValueIds: Record<string, string> = {};
      const record = async (def: (typeof DEFINITIONS)[number], input: { value: number; exact: string; currencyCode?: string; dimensions: Record<string, unknown>; periodStart: Date; periodEnd: Date; extraRef: Record<string, unknown> }): Promise<MetricCalculatedValue> => {
        const { definitionId, versionId } = await this.ensureDefinition(ctx, f.businessId, def);
        const row = await this.d.calculations.recordCalculation(ctx, {
          metricDefinitionId: definitionId, metricDefinitionVersionId: versionId, businessId: f.businessId, value: input.value, unit: def.unit,
          ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
          dimensions: { ...common, ...input.dimensions }, periodStart: input.periodStart, periodEnd: input.periodEnd,
          calculationStatus: 'completed', evidenceReference: reference({ exact: input.exact, ...input.extraRef }), correlationId,
        });
        metricValueIds[def.metricCode] = row.id;
        return row;
      };

      await record(DEFINITIONS[0], {
        value: Number(f.demand.sumOfMagnitudes), exact: f.demand.sumOfMagnitudes, periodStart, periodEnd, extraRef: {},
        dimensions: { observations: f.demand.count, windowDays: f.windowDays, windowStartsAt: f.windowStartsAt, demandMovementTypes: f.demandMovementTypes },
      });
      await record(DEFINITIONS[1], {
        value: Number(balance.quantityOnHand), exact: balance.quantityOnHand, periodStart, periodEnd, extraRef: {},
        dimensions: { balanceId: balance.id, warehouseId: balance.warehouseId, reorderPoint: balance.reorderPoint, reorderQuantity: balance.reorderQuantity },
      });
      // Cost evidence only when a receipt with a stated, finite, positive cost AND currency exists: a missing or unusable cost is not published, never invented.
      // Whether that currency matches the business's governed currency is a Business Operations fact carried through as-is (null = unknown); BI neither holds nor compares it.
      const r = f.latestReceipt;
      if (r !== null && r.cost !== null && r.costCurrency !== null && Number.isFinite(Number(r.cost)) && Number(r.cost) > 0) {
        await record(DEFINITIONS[2], {
          value: Number(r.cost), exact: r.cost, currencyCode: r.costCurrency, periodStart, periodEnd, extraRef: {},
          dimensions: { receiptMovementId: r.movementId, receiptOccurredAt: r.occurredAt, currencyConsistent: r.costCurrencyMatchesBusinessCurrency },
        });
      }

      const code = biEvidencePackageCode(f.itemId);
      const pkg = (await this.d.packages.findByCode(ctx, f.businessId, code)) ?? (await this.d.packages.create(ctx, f.businessId, code));
      const summary = `Inventory evidence for item ${f.itemId}: ${f.demand.count} demand observation(s) totalling ${f.demand.sumOfMagnitudes} unit(s) over ${f.windowDays} days, `
        + `${balance.quantityOnHand} unit(s) on hand${metricValueIds[BI_METRIC_RECEIPT_COST] ? ', latest receipt cost recorded' : ', no receipt cost recorded'}; `
        + `Business Operations facts ${f.snapshotDigest} captured ${f.capturedAt}, valid until ${validUntil}.`;
      const version = await this.d.packages.publishVersion(ctx, pkg.id, f.businessId, { summary, metricValueIds: Object.values(metricValueIds) });
      return { outcome: 'PUBLISHED' as const, insightPackageId: pkg.id, insightPackageVersionId: version.id, versionNumber: version.versionNumber, metricValueIds, factsDigest: f.snapshotDigest, capturedAt: f.capturedAt, validUntil };
    });
  }

  /** The newest published BI evidence of an item, or null when none exists. Read-only. */
  async getLatest(ctx: TenantContext, businessId: string, itemId: string): Promise<InventoryBiEvidence | null> {
    const pkg = await this.d.packages.findByCode(ctx, businessId, biEvidencePackageCode(itemId));
    if (pkg === null) return null;
    const version = await this.d.packages.findLatestVersion(ctx, pkg.id);
    if (version === null) return null;
    const metrics: InventoryBiEvidence['metrics'] = {};
    let ref: Record<string, unknown> | null = null;
    for (const id of version.metricValueIds) {
      const row = await this.d.calculations.findById(ctx, id);
      const definition = await this.d.definitions.findById(ctx, row.metricDefinitionId);
      metrics[definition.metricCode] = { id: row.id, value: row.value, exact: String(row.evidenceReference.exact ?? ''), unit: row.unit, currencyCode: row.currencyCode, dimensions: row.dimensions };
      ref = row.evidenceReference;
    }
    if (ref === null) return null;
    return {
      insightPackageId: pkg.id, insightPackageVersionId: version.id, versionNumber: version.versionNumber, factsDigest: String(ref.factsDigest), capturedAt: String(ref.capturedAt),
      validUntil: String(ref.validUntil), ruleSetVersion: String(ref.ruleSetVersion), metrics,
    };
  }
}
