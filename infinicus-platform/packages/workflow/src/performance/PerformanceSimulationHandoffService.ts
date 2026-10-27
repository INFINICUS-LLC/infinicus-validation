/**
 * Business Digital Twin -> Simulation hand-off of the published business performance state (NEW-BDT-SIM-01). The twin PUBLISHES; Simulation receives and
 * executes independently (its intake is Simulation's own act and is not performed here). This service only reads the twin's own published state and writes the
 * twin-owned artifacts the frozen DT -> SIM contract describes: a published scenario baseline, a DT insight package version and a DISPATCHED DT publication
 * package. It touches no Business Operations, Business Intelligence or Simulation table, derives no KPI and issues no recommendation.
 *
 *  - Fail closed: an invalid request, a missing, integrity-failed or partial state, or a hand-off that does not satisfy `validateDTToSIMHandoff` publishes nothing.
 *  - Atomic: baseline, package and dispatch are created in ONE shared tenant transaction.
 *  - Idempotent: one hand-off per published snapshot version; the baseline code and the package idempotency key are derived from it and are unique in the
 *    database, so a repeat (or a concurrent duplicate) replays the existing package instead of creating a second one.
 */
import { randomUUID } from 'node:crypto';
import {
  DTPublicationPackageRepository, DigitalTwinSnapshotRepository, ScenarioBaselineRepository, withSharedTenantTransaction, type TenantContext,
} from '@infinicus/database';
import type { LineageEntry } from '@infinicus/shared-types';
import { DT_TO_SIM_CONTRACT_VERSION, validateDTToSIMHandoff, type DTToSIMHandoff, type PerformancePeriod } from '@infinicus/handoff-contracts';
import { MAX_REPORT_DAYS } from '../financial/FinancialIntelligenceService.js';
import { isRealDate, rangeDays } from '../financial/periods.js';
import type { BusinessPerformanceTwinService } from './BusinessPerformanceTwinService.js';
import { buildPerformanceBaseline } from './performanceBaseline.js';

export const PERFORMANCE_SIM_SOURCE_BLOCK = 'BDT-PERFORMANCE-01';
export const PERFORMANCE_SIM_TARGET_BLOCK = 'SIM-01';

export type HandoffRefusalCode = 'INVALID_REQUEST' | 'TWIN_STATE_MISSING' | 'TWIN_STATE_INTEGRITY_FAILED' | 'NOT_SIMULATION_READY' | 'HANDOFF_INVALID';
export type PerformanceSimulationHandoffResult =
  | {
      outcome: 'HANDED_OFF'; replay: false; publicationPackageId: string; scenarioBaselineId: string; scenarioBaselineVersionId: string; snapshotId: string;
      handoff: DTToSIMHandoff;
    }
  | { outcome: 'HANDED_OFF'; replay: true; publicationPackageId: string; publicationStatus: string; snapshotId: string }
  | { outcome: 'NOT_HANDED_OFF'; code: HandoffRefusalCode; detail: string };

export interface PerformanceSimulationHandoffDependencies {
  twin: Pick<BusinessPerformanceTwinService, 'getLatest'>;
  snapshots: Pick<DigitalTwinSnapshotRepository, 'getById' | 'getPublishedVersion'>;
  baselines: Pick<ScenarioBaselineRepository, 'createBaseline' | 'addInput' | 'validateBaseline' | 'publishBaseline'>;
  packages: Pick<DTPublicationPackageRepository, 'createInsightPackage' | 'createVersion' | 'createPackage' | 'markReady' | 'dispatch' | 'getByIdempotencyKey'>;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One lineage entry per piece of evidence: the twin snapshot (DT) first, then each BI source report / evidence digest it rests on (BI). */
const lineageOf = (snapshotId: string, references: readonly string[], at: string): LineageEntry[] =>
  references.map((ref) => ({ layer: ref === `twin-snapshot:${snapshotId}` ? 'DT' as const : 'BI' as const, block: ref.slice(0, ref.indexOf(':')), recordId: ref.slice(ref.indexOf(':') + 1), timestamp: at, action: 'evidence_referenced' }));
const isUniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

export class PerformanceSimulationHandoffService {
  private readonly d: PerformanceSimulationHandoffDependencies;
  constructor(deps: Pick<PerformanceSimulationHandoffDependencies, 'twin'> & Partial<PerformanceSimulationHandoffDependencies>) {
    this.d = {
      twin: deps.twin,
      snapshots: deps.snapshots ?? new DigitalTwinSnapshotRepository(),
      baselines: deps.baselines ?? new ScenarioBaselineRepository(),
      packages: deps.packages ?? new DTPublicationPackageRepository(),
      now: deps.now ?? (() => new Date()),
    };
  }

  async handOff(ctx: TenantContext, request: { businessId: string; from: string; to: string }): Promise<PerformanceSimulationHandoffResult> {
    const refuse = (code: HandoffRefusalCode, detail: string): PerformanceSimulationHandoffResult => ({ outcome: 'NOT_HANDED_OFF', code, detail });
    if (!UUID.test(request.businessId)) return refuse('INVALID_REQUEST', 'businessId must be a lowercase UUID');
    if (!isRealDate(request.from) || !isRealDate(request.to)) return refuse('INVALID_REQUEST', 'from and to must be real YYYY-MM-DD dates');
    if (request.from > request.to) return refuse('INVALID_REQUEST', 'from must not be after to');
    const period: PerformancePeriod = { from: request.from, to: request.to };
    if (rangeDays(period) > MAX_REPORT_DAYS) return refuse('INVALID_REQUEST', `the reporting period must not exceed ${MAX_REPORT_DAYS} days`);

    const latest = await this.d.twin.getLatest(ctx, request.businessId, period);
    if (latest === null) return refuse('TWIN_STATE_MISSING', 'no business performance twin state has been published for this period');
    if (!latest.integrity.valid) return refuse('TWIN_STATE_INTEGRITY_FAILED', `the published twin state failed its integrity check: ${latest.integrity.reasons.join(',')}`);
    const snapshotVersion = await this.d.snapshots.getPublishedVersion(ctx, latest.snapshotId);
    if (snapshotVersion === null) return refuse('TWIN_STATE_MISSING', 'the twin snapshot has no published version');
    const snapshot = await this.d.snapshots.getById(ctx, latest.snapshotId);

    const idempotencyKey = `bdt-performance-sim:${snapshotVersion.id}`;
    const replay = async (): Promise<PerformanceSimulationHandoffResult | null> => {
      const existing = await this.d.packages.getByIdempotencyKey(ctx, request.businessId, idempotencyKey);
      return existing === null ? null : { outcome: 'HANDED_OFF', replay: true, publicationPackageId: existing.id, publicationStatus: existing.publicationStatus, snapshotId: latest.snapshotId };
    };
    const prior = await replay();
    if (prior !== null) return prior;

    const now = this.d.now();
    const built = buildPerformanceBaseline({ state: latest.state, snapshotId: latest.snapshotId, now });
    if (!built.ok) return refuse('NOT_SIMULATION_READY', built.detail);

    const envelope = (ids: { packageId: string; baselineId: string; baselineVersion: number; correlationId: string }): DTToSIMHandoff => ({
      handoffId: ids.packageId, sourceLayer: 'DT', sourceBlock: PERFORMANCE_SIM_SOURCE_BLOCK, targetLayer: 'SIM', targetBlock: PERFORMANCE_SIM_TARGET_BLOCK,
      correlationId: ids.correlationId, lineage: lineageOf(latest.snapshotId, built.evidenceReferences, latest.effectiveAt), status: 'ready', createdAt: now.toISOString(),
      payload: {
        contractVersion: DT_TO_SIM_CONTRACT_VERSION, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: request.businessId,
        digitalTwinInstanceId: snapshot.instanceId, snapshotId: latest.snapshotId, snapshotVersion: snapshotVersion.versionNumber,
        scenarioBaselineId: ids.baselineId, scenarioBaselineVersion: ids.baselineVersion, objective: built.objective,
        variables: built.variables, assumptions: built.assumptions, constraints: [], uncertaintyAssignments: [],
        evidenceReferences: built.evidenceReferences, quality: built.quality, effectiveAt: latest.effectiveAt, idempotencyKey,
      },
    });
    // Fail closed BEFORE persisting: the frozen contract's own validator must accept the hand-off (placeholder ids stand in for the ones not yet created).
    const dry = validateDTToSIMHandoff(envelope({ packageId: randomUUID(), baselineId: randomUUID(), baselineVersion: 1, correlationId: randomUUID() }));
    if (!dry.valid) return refuse('HANDOFF_INVALID', `the hand-off does not satisfy the DT -> SIM contract: ${dry.reasons.join(',')}`);

    const code = `perf-${snapshotVersion.id}`;
    try {
      return await withSharedTenantTransaction(ctx, async () => {
        const { baseline, version } = await this.d.baselines.createBaseline(ctx, request.businessId, snapshot.instanceId, snapshotVersion.id, code, built.objective);
        for (const v of built.variables) await this.d.baselines.addInput(ctx, version.id, request.businessId, { variableCode: v.variableCode, value: v.value, unit: v.unit });
        await this.d.baselines.validateBaseline(ctx, baseline.id, version.id);
        await this.d.baselines.publishBaseline(ctx, baseline.id, version.id);
        const insight = await this.d.packages.createInsightPackage(ctx, request.businessId, code);
        const insightVersion = await this.d.packages.createVersion(ctx, insight.id, request.businessId,
          `Business performance baseline ${period.from}..${period.to} (evidence ${latest.state.evidence.evidenceDigest})`, { snapshotVersionId: snapshotVersion.id, scenarioBaselineVersionId: version.id });
        const { package: pkg } = await this.d.packages.createPackage(ctx, request.businessId, insightVersion.id, 'simulation', PERFORMANCE_SIM_TARGET_BLOCK, idempotencyKey);
        await this.d.packages.markReady(ctx, pkg.id);
        await this.d.packages.dispatch(ctx, pkg.id);
        const handoff = envelope({ packageId: pkg.id, baselineId: baseline.id, baselineVersion: version.versionNumber, correlationId: version.correlationId });
        const check = validateDTToSIMHandoff(handoff);
        if (!check.valid) throw new HandoffInvalidError(check.reasons.join(','));          // rolls the whole transaction back
        return { outcome: 'HANDED_OFF' as const, replay: false as const, publicationPackageId: pkg.id, scenarioBaselineId: baseline.id, scenarioBaselineVersionId: version.id, snapshotId: latest.snapshotId, handoff };
      });
    } catch (error) {
      if (error instanceof HandoffInvalidError) return refuse('HANDOFF_INVALID', `the hand-off does not satisfy the DT -> SIM contract: ${error.message}`);
      if (isUniqueViolation(error)) { const raced = await replay(); if (raced !== null) return raced; }   // a concurrent identical hand-off won the race
      throw error;
    }
  }
}

class HandoffInvalidError extends Error {}
