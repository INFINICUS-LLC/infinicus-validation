/**
 * Business Digital Twin -> Simulation hand-off of the published business performance state (NEW-BDT-SIM-01; corrected by SEC-01). The twin PUBLISHES; Simulation
 * receives and executes independently (its intake is Simulation's own act and is not performed here). This service reads the twin's own published state and
 * writes only twin-owned artifacts: a published scenario baseline, a DT insight package version, a Twin Confidence record, the persisted hand-off envelope and a
 * DISPATCHED DT publication package. It touches no Business Operations, Business Intelligence or Simulation table, derives no KPI and issues no recommendation.
 *
 *  - D1 Twin Confidence: the contract's `quality.confidence` is NEVER defaulted. It comes from an explicit `TwinConfidencePolicy` (owner-ratified methodology), must
 *    account for all seven BDT factors, must meet the platform minimum 0.75, and is recorded with its basis in `twin_confidence_scores`. The production policy is
 *    the unratified one, so the gate is closed (default deny) until the owner ratifies a methodology.
 *  - D2 Persistence: the COMPLETE validated envelope is persisted (with its digest, the confidence score and the revalidated source digest) while the package is still a
 *    draft; the database refuses to ready or dispatch the package otherwise.
 *  - D3 Freshness: immediately before committing, the BI evidence is re-derived and compared by digest with the evidence the twin state was published from; any change,
 *    or any failure to re-derive it, refuses the hand-off. No maximum age is invented. A replay is subject to the same gates (it never bypasses them).
 *  - Fail closed everywhere; atomic (one shared tenant transaction); idempotent per snapshot version (unique in the database), also under a concurrent race.
 */
import { randomUUID } from 'node:crypto';
import {
  DTHandoffEnvelopeRepository, DTPublicationPackageRepository, DigitalTwinSnapshotRepository, ScenarioBaselineRepository, TwinConfidenceScoreRepository,
  withSharedTenantTransaction, type TenantContext,
} from '@infinicus/database';
import type { LineageEntry } from '@infinicus/shared-types';
import { DT_TO_SIM_CONTRACT_VERSION, validateDTToSIMHandoff, type DTToSIMHandoff, type PerformancePeriod } from '@infinicus/handoff-contracts';
import { MAX_REPORT_DAYS } from '../financial/FinancialIntelligenceService.js';
import { isRealDate, rangeDays } from '../financial/periods.js';
import type { BusinessPerformanceTwinService } from './BusinessPerformanceTwinService.js';
import { assessSimulationReadiness, buildPerformanceBaseline } from './performanceBaseline.js';
import { handoffDigest, PERFORMANCE_HANDOFF_SCHEMA_VERSION, verifyPersistedHandoff } from './handoffEnvelope.js';
import { DT_TO_SIM_MIN_CONFIDENCE, evaluateConfidenceGate, UnratifiedTwinConfidencePolicy, type ConfidenceRefusalCode, type TwinConfidencePolicy } from './twinConfidencePolicy.js';

export const PERFORMANCE_SIM_SOURCE_BLOCK = 'BDT-PERFORMANCE-01';
export const PERFORMANCE_SIM_TARGET_BLOCK = 'SIM-01';

export type HandoffRefusalCode =
  | 'INVALID_REQUEST' | 'TWIN_STATE_MISSING' | 'TWIN_STATE_INTEGRITY_FAILED' | 'NOT_SIMULATION_READY' | 'HANDOFF_INVALID'
  | 'SOURCE_UNVERIFIABLE' | 'SOURCE_SUPERSEDED' | 'PERSISTED_HANDOFF_INVALID' | ConfidenceRefusalCode;
export type PerformanceSimulationHandoffResult =
  | {
      outcome: 'HANDED_OFF'; replay: false; publicationPackageId: string; scenarioBaselineId: string; scenarioBaselineVersionId: string; snapshotId: string;
      confidenceScoreId: string; envelopeDigest: string; handoff: DTToSIMHandoff;
    }
  | { outcome: 'HANDED_OFF'; replay: true; publicationPackageId: string; publicationStatus: string; snapshotId: string; confidenceScoreId: string; envelopeDigest: string }
  | { outcome: 'NOT_HANDED_OFF'; code: HandoffRefusalCode; detail: string };

export interface PerformanceSimulationHandoffDependencies {
  twin: Pick<BusinessPerformanceTwinService, 'getLatest' | 'currentEvidence'>;
  /** The ratified Twin Confidence methodology. Defaults to the UNRATIFIED policy, which keeps the hand-off closed. */
  confidence: TwinConfidencePolicy;
  /** The confidence threshold: the platform minimum (0.75) or a higher policy value; a lower value is refused at construction. */
  minimumConfidence: number;
  snapshots: Pick<DigitalTwinSnapshotRepository, 'getById' | 'getPublishedVersion'>;
  baselines: Pick<ScenarioBaselineRepository, 'createBaseline' | 'addInput' | 'validateBaseline' | 'publishBaseline'>;
  packages: Pick<DTPublicationPackageRepository, 'createInsightPackage' | 'createVersion' | 'createPackage' | 'markReady' | 'dispatch' | 'getByIdempotencyKey'>;
  scores: Pick<TwinConfidenceScoreRepository, 'record' | 'getById'>;
  envelopes: Pick<DTHandoffEnvelopeRepository, 'record' | 'getByPackage'>;
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
    const minimumConfidence = deps.minimumConfidence ?? DT_TO_SIM_MIN_CONFIDENCE;
    if (!(minimumConfidence >= DT_TO_SIM_MIN_CONFIDENCE && minimumConfidence <= 1)) throw new RangeError(`minimumConfidence must be from the platform minimum ${DT_TO_SIM_MIN_CONFIDENCE} to 1`);
    this.d = {
      twin: deps.twin,
      confidence: deps.confidence ?? new UnratifiedTwinConfidencePolicy(),
      minimumConfidence,
      snapshots: deps.snapshots ?? new DigitalTwinSnapshotRepository(),
      baselines: deps.baselines ?? new ScenarioBaselineRepository(),
      packages: deps.packages ?? new DTPublicationPackageRepository(),
      scores: deps.scores ?? new TwinConfidenceScoreRepository(),
      envelopes: deps.envelopes ?? new DTHandoffEnvelopeRepository(),
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
    const ready = assessSimulationReadiness(latest.state);
    if (!ready.ok) return refuse('NOT_SIMULATION_READY', ready.detail);
    const snapshotVersion = await this.d.snapshots.getPublishedVersion(ctx, latest.snapshotId);
    if (snapshotVersion === null) return refuse('TWIN_STATE_MISSING', 'the twin snapshot has no published version');
    const snapshot = await this.d.snapshots.getById(ctx, latest.snapshotId);

    // D3: the source BI evidence is re-derived NOW and must be exactly the evidence this twin state was published from. A replay is subject to the same check.
    const current = await this.d.twin.currentEvidence(ctx, { businessId: request.businessId, ...period });
    if (!current.ok) return refuse('SOURCE_UNVERIFIABLE', `the source BI evidence could not be re-derived (${current.code}): ${current.detail}`);
    const stored = latest.state.evidence;
    if (current.evidence.evidenceDigest !== stored.evidenceDigest) {
      return refuse('SOURCE_SUPERSEDED', `the BI evidence for ${period.from}..${period.to} changed after the twin state was published (published ${stored.evidenceDigest.slice(0, 12)}, now ${current.evidence.evidenceDigest.slice(0, 12)}); publish a new twin state first`);
    }
    const revalidatedAt = this.d.now();

    // D1: Twin Confidence must come from the ratified methodology, account for every factor and meet the threshold. Nothing is defaulted.
    const assessment = await this.d.confidence.assess(ctx, { businessId: request.businessId, snapshotId: latest.snapshotId, evidence: stored });
    const gate = evaluateConfidenceGate(assessment, this.d.minimumConfidence);
    if (!gate.ok) return refuse(gate.code, gate.detail);

    const idempotencyKey = `bdt-performance-sim:${snapshotVersion.id}`;
    const replay = async (): Promise<PerformanceSimulationHandoffResult | null> => {
      const existing = await this.d.packages.getByIdempotencyKey(ctx, request.businessId, idempotencyKey);
      if (existing === null) return null;
      const record = await this.d.envelopes.getByPackage(ctx, request.businessId, existing.id);
      if (record === null) return refuse('PERSISTED_HANDOFF_INVALID', 'the existing hand-off package has no persisted envelope');
      const score = await this.d.scores.getById(ctx, record.confidenceScoreId);
      const check = verifyPersistedHandoff(record, score, { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: request.businessId });
      if (!check.valid) return refuse('PERSISTED_HANDOFF_INVALID', `the persisted hand-off failed verification: ${check.reasons.join(',')}`);
      return { outcome: 'HANDED_OFF', replay: true, publicationPackageId: existing.id, publicationStatus: existing.publicationStatus, snapshotId: latest.snapshotId, confidenceScoreId: record.confidenceScoreId, envelopeDigest: record.envelopeDigest };
    };
    const prior = await replay();
    if (prior !== null) return prior;

    const now = this.d.now();
    const built = buildPerformanceBaseline({ state: latest.state, snapshotId: latest.snapshotId, now, confidence: gate.score });
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
          `Business performance baseline ${period.from}..${period.to} (evidence ${stored.evidenceDigest})`, { snapshotVersionId: snapshotVersion.id, scenarioBaselineVersionId: version.id });
        const { package: pkg } = await this.d.packages.createPackage(ctx, request.businessId, insightVersion.id, 'simulation', PERFORMANCE_SIM_TARGET_BLOCK, idempotencyKey);
        const score = await this.d.scores.record(ctx, { businessId: request.businessId, instanceId: snapshot.instanceId, snapshotVersionId: snapshotVersion.id, confidence: gate.score, basis: gate.basis });
        const handoff = envelope({ packageId: pkg.id, baselineId: baseline.id, baselineVersion: version.versionNumber, correlationId: version.correlationId });
        const check = validateDTToSIMHandoff(handoff);
        if (!check.valid) throw new HandoffInvalidError(check.reasons.join(','));          // rolls the whole transaction back
        // Persist-before-publication: the complete envelope is recorded while the package is still a draft (the database refuses ready/dispatched without it).
        const digest = handoffDigest(handoff);
        await this.d.envelopes.record(ctx, {
          businessId: request.businessId, dtPublicationPackageId: pkg.id, snapshotVersionId: snapshotVersion.id, confidenceScoreId: score.id,
          contractVersion: DT_TO_SIM_CONTRACT_VERSION, schemaVersion: PERFORMANCE_HANDOFF_SCHEMA_VERSION, correlationId: version.correlationId, causationId: snapshotVersion.id,
          envelope: handoff, envelopeDigest: digest, sourceEvidenceDigest: current.evidence.evidenceDigest, sourceRevalidatedAt: revalidatedAt,
        });
        await this.d.packages.markReady(ctx, pkg.id);
        await this.d.packages.dispatch(ctx, pkg.id);
        return { outcome: 'HANDED_OFF' as const, replay: false as const, publicationPackageId: pkg.id, scenarioBaselineId: baseline.id, scenarioBaselineVersionId: version.id, snapshotId: latest.snapshotId, confidenceScoreId: score.id, envelopeDigest: digest, handoff };
      });
    } catch (error) {
      if (error instanceof HandoffInvalidError) return refuse('HANDOFF_INVALID', `the hand-off does not satisfy the DT -> SIM contract: ${error.message}`);
      if (isUniqueViolation(error)) { const raced = await replay(); if (raced !== null) return raced; }   // a concurrent identical hand-off won the race
      throw error;
    }
  }
}

class HandoffInvalidError extends Error {}
