/**
 * Business Digital Twin representation of governed Business Intelligence performance evidence (NEW-BDT-01). BDT models the PRESENT state needed for decision
 * modeling; it is not a second operational source of truth, derives no KPI and mutates nothing real.
 *
 *  - Input boundary: it consumes BI REPORTS only (the financial and sales report services, structurally), never Business Operations: BO -> BI -> BDT.
 *  - The figures are the BI figures VERBATIM per currency, with provenance (contract, period, source digest) and an integrity digest; see `biPerformanceEvidence`.
 *  - It reuses the existing twin lifecycle exactly as `InventoryItemTwinService` does (definition -> instance -> snapshot -> value + evidence -> validate -> publish),
 *    in ONE shared tenant transaction so a half-built twin is never visible. Published snapshots are immutable; a newer published snapshot supersedes older ones
 *    under the existing P0-3 freshness rule.
 *  - Fail closed: invalid requests, unavailable, insufficient or inconsistent (business, period, currency, cross-report revenue) evidence publish nothing. A single
 *    unavailable domain is represented as MISSING with its code, never as zeros.
 */
import { randomUUID } from 'node:crypto';
import {
  DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository, DigitalTwinSnapshotRepository, withSharedTenantTransaction,
  type DigitalTwinInstance, type TenantContext,
} from '@infinicus/database';
import {
  BUSINESS_PERFORMANCE_TWIN_MODEL, BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA, type BiPerformanceEvidence, type BusinessPerformanceTwinState, type PerformancePeriod,
} from '@infinicus/handoff-contracts';
import type { FinancialReportOutcome, FinancialReportRequest } from '../financial/FinancialIntelligenceService.js';
import { MAX_REPORT_DAYS } from '../financial/FinancialIntelligenceService.js';
import { isRealDate, rangeDays } from '../financial/periods.js';
import type { SalesReportResult } from '../SalesReportService.js';
import { assembleBiPerformanceEvidence, verifyBiPerformanceEvidence, type PerformanceRefusalCode } from './biPerformanceEvidence.js';

export const BUSINESS_PERFORMANCE_TWIN_CODE = 'business-performance-twin';
export const BUSINESS_PERFORMANCE_TWIN_VARIABLE = 'business_performance_state';
export const TWIN_EVIDENCE_BI_FINANCIAL_REPORT = 'bi_financial_report';
export const TWIN_EVIDENCE_BI_SALES_REPORT = 'bi_sales_report';
export const TWIN_EVIDENCE_BI_PERFORMANCE = 'bi_performance_evidence';

/** The BI read sides the twin consumes (structural: `FinancialIntelligenceService.report` and `SalesReportService.report` satisfy them). */
export interface FinancialReportReader { report(ctx: TenantContext, request: FinancialReportRequest): Promise<FinancialReportOutcome> }
export interface SalesReportReader { report(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<SalesReportResult> }

export type PublishPerformanceTwinResult =
  | { outcome: 'PUBLISHED'; snapshotId: string; snapshotVersionId: string; instanceId: string; effectiveAt: string; evidenceDigest: string; state: BusinessPerformanceTwinState }
  | { outcome: 'NOT_PUBLISHED'; code: 'INVALID_REQUEST' | PerformanceRefusalCode; detail: string };

export interface LatestPerformanceTwin {
  snapshotId: string; effectiveAt: string; state: BusinessPerformanceTwinState;
  /** Re-verified on every read: the stored evidence still matches its integrity digest. */
  integrity: { valid: boolean; reasons: string[] };
}

export interface BusinessPerformanceTwinDependencies {
  financial: FinancialReportReader;
  sales: SalesReportReader;
  definitions: Pick<DigitalTwinDefinitionRepository, 'createDefinition' | 'createVersion' | 'validateVersion' | 'activateVersion'>;
  instances: Pick<DigitalTwinInstanceRepository, 'createInstance' | 'createVersion' | 'transitionStatus' | 'getActiveForBusiness'>;
  snapshots: Pick<DigitalTwinSnapshotRepository, 'createSnapshot' | 'addValue' | 'addEvidence' | 'validateSnapshot' | 'publishSnapshot' | 'getPublishedForInstance' | 'getValuesForPublishedSnapshot' | 'assessFreshness'>;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BusinessPerformanceTwinService {
  private readonly d: BusinessPerformanceTwinDependencies;
  constructor(deps: Pick<BusinessPerformanceTwinDependencies, 'financial' | 'sales'> & Partial<BusinessPerformanceTwinDependencies>) {
    this.d = {
      financial: deps.financial, sales: deps.sales,
      definitions: deps.definitions ?? new DigitalTwinDefinitionRepository(),
      instances: deps.instances ?? new DigitalTwinInstanceRepository(),
      snapshots: deps.snapshots ?? new DigitalTwinSnapshotRepository(),
      now: deps.now ?? (() => new Date()),
    };
  }

  private async ensureInstance(ctx: TenantContext, businessId: string): Promise<DigitalTwinInstance> {
    const existing = (await this.d.instances.getActiveForBusiness(ctx, businessId)).find((i) => i.instanceCode === BUSINESS_PERFORMANCE_TWIN_CODE);
    if (existing) return existing;
    const definition = await this.d.definitions.createDefinition(ctx, businessId, BUSINESS_PERFORMANCE_TWIN_CODE, 'Business performance twin');
    const version = await this.d.definitions.createVersion(ctx, definition.id, businessId, {
      description: 'Representation of the governed Business Intelligence financial and sales evidence of a reporting period, per currency, with provenance and integrity digests. Derives no KPI.',
      stateSchema: BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA,
    });
    await this.d.definitions.validateVersion(ctx, version.id);
    await this.d.definitions.activateVersion(ctx, version.id);
    const instance = await this.d.instances.createInstance(ctx, businessId, definition.id, BUSINESS_PERFORMANCE_TWIN_CODE);
    await this.d.instances.createVersion(ctx, instance.id, businessId, version.id);
    return this.d.instances.transitionStatus(ctx, instance.id, 'active', 'initial provisioning');
  }

  /**
   * Re-derives the performance evidence of a period from the BI reports AS THEY ARE NOW, without persisting anything (read-only). It is the one place the request
   * is validated and the two BI reports are read and assembled, shared by `publish` and by the hand-off's source revalidation (NEW-BDT-SIM-01.SEC-01, D3).
   */
  async currentEvidence(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<{ ok: true; evidence: BiPerformanceEvidence } | { ok: false; code: 'INVALID_REQUEST' | PerformanceRefusalCode; detail: string }> {
    if (!UUID.test(request.businessId)) return { ok: false, code: 'INVALID_REQUEST', detail: 'businessId must be a lowercase UUID' };
    if (!isRealDate(request.from) || !isRealDate(request.to)) return { ok: false, code: 'INVALID_REQUEST', detail: 'from and to must be real YYYY-MM-DD dates' };
    if (request.from > request.to) return { ok: false, code: 'INVALID_REQUEST', detail: 'from must not be after to' };
    const period: PerformancePeriod = { from: request.from, to: request.to };
    if (rangeDays(period) > MAX_REPORT_DAYS) return { ok: false, code: 'INVALID_REQUEST', detail: `the reporting period must not exceed ${MAX_REPORT_DAYS} days` };
    // BI derives; the twin only reads. Both reports are asked for exactly the same reporting period.
    const financial = await this.d.financial.report(ctx, { businessId: request.businessId, ...period, granularity: 'month', compare: 'none' });
    const sales = await this.d.sales.report(ctx, { businessId: request.businessId, ...period });
    const assembled = assembleBiPerformanceEvidence({ businessId: request.businessId, period, financial, sales });
    return assembled.ok ? { ok: true, evidence: assembled.evidence } : { ok: false, code: assembled.code, detail: assembled.detail };
  }

  async publish(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<PublishPerformanceTwinResult> {
    const period: PerformancePeriod = { from: request.from, to: request.to };
    const current = await this.currentEvidence(ctx, request);
    if (!current.ok) return { outcome: 'NOT_PUBLISHED', code: current.code, detail: current.detail };
    const evidence: BiPerformanceEvidence = current.evidence;

    const observedAt = this.d.now();
    const state: BusinessPerformanceTwinState = { schema: BUSINESS_PERFORMANCE_TWIN_STATE_SCHEMA, model: BUSINESS_PERFORMANCE_TWIN_MODEL, observedAt: observedAt.toISOString(), evidence };
    const summary = `Business performance ${period.from}..${period.to}: financial ${evidence.financial.status}, sales ${evidence.sales.status}`;
    return withSharedTenantTransaction(ctx, async () => {
      const instance = await this.ensureInstance(ctx, request.businessId);
      const { snapshot, version } = await this.d.snapshots.createSnapshot(ctx, request.businessId, instance.id, `business-performance-${period.from}-${period.to}-${randomUUID().slice(0, 8)}`, observedAt, summary);
      await this.d.snapshots.addValue(ctx, version.id, BUSINESS_PERFORMANCE_TWIN_VARIABLE, state);
      if (evidence.financial.status === 'PROVIDED') await this.d.snapshots.addEvidence(ctx, version.id, TWIN_EVIDENCE_BI_FINANCIAL_REPORT, { ...evidence.financial.provenance });
      if (evidence.sales.status === 'PROVIDED') await this.d.snapshots.addEvidence(ctx, version.id, TWIN_EVIDENCE_BI_SALES_REPORT, { ...evidence.sales.provenance });
      await this.d.snapshots.addEvidence(ctx, version.id, TWIN_EVIDENCE_BI_PERFORMANCE, { contract: evidence.contract, evidenceDigest: evidence.evidenceDigest, period });
      await this.d.snapshots.validateSnapshot(ctx, snapshot.id, version.id);
      await this.d.snapshots.publishSnapshot(ctx, snapshot.id, version.id);
      return { outcome: 'PUBLISHED' as const, snapshotId: snapshot.id, snapshotVersionId: version.id, instanceId: instance.id, effectiveAt: observedAt.toISOString(), evidenceDigest: evidence.evidenceDigest, state };
    });
  }

  /** The existing P0-3 freshness rule for a twin snapshot. Read-only. */
  async assessFreshness(ctx: TenantContext, businessId: string, snapshotId: string): Promise<{ usable: boolean; newerPublishedExists: boolean }> {
    return this.d.snapshots.assessFreshness(ctx, businessId, snapshotId);
  }

  /** The newest published performance state of a business (optionally of exactly one reporting period), or null. Read-only; the integrity is re-verified. */
  async getLatest(ctx: TenantContext, businessId: string, period?: PerformancePeriod): Promise<LatestPerformanceTwin | null> {
    const instance = (await this.d.instances.getActiveForBusiness(ctx, businessId)).find((i) => i.instanceCode === BUSINESS_PERFORMANCE_TWIN_CODE);
    if (!instance) return null;
    // Snapshots come newest first by effective time (microsecond resolution; the effective time is the moment the evidence was read), so the first match is the newest.
    for (const snap of await this.d.snapshots.getPublishedForInstance(ctx, instance.id)) {
      const value = (await this.d.snapshots.getValuesForPublishedSnapshot(ctx, snap.id)).find((v) => v.variableCode === BUSINESS_PERFORMANCE_TWIN_VARIABLE);
      const state = value?.valueJson as BusinessPerformanceTwinState | undefined;
      if (!state?.evidence || state.evidence.businessId !== businessId) continue;
      if (period && (state.evidence.period?.from !== period.from || state.evidence.period?.to !== period.to)) continue;
      return { snapshotId: snap.id, effectiveAt: snap.effectiveAt.toISOString(), state, integrity: verifyBiPerformanceEvidence(state.evidence) };
    }
    return null;
  }
}
