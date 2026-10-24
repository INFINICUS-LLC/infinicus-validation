/**
 * The single fail-closed boundary between Outcome Monitoring evidence and Control Loop (Continuous Learning) learning (CL-BOUNDARY-1).
 *
 * Nothing may reach Continuous Learning from OM except through {@link LearningReleaseBoundary.release}. It
 *   1. reads, itself and under the caller's tenant and workspace, the observation named by the hand-off and the OM execution verifications behind it
 *      (the caller supplies a hand-off, never the evidence, so evidence cannot be substituted);
 *   2. asks the ONE learning gate (`learningEligibility`, through `decideLearningRelease`) whether every one of those facts allows learning, and
 *      whether the hand-off is well formed, in scope, properly sourced, linked to the observation and free of conflicts;
 *   3. only then calls the injected sink. Any refusal, any lookup failure and any doubt means the sink is NOT called.
 *
 * It writes nothing, emits no event, creates no state and invents no gate: execution success alone never authorizes learning, because the gate
 * needs OUTCOME_VERIFIED, which Outcome Monitoring cannot yet assign (no governed measurement model exists). Nothing in production constructs this
 * class yet; learning is not activated.
 */
import { decideLearningRelease } from '@infinicus/handoff-contracts';
import type { LearningObservationRef, LearningSourceFact, OMToCLHandoff } from '@infinicus/handoff-contracts';
import type { LearningSourceLookup, TenantContext } from '@infinicus/database';

/** The release was refused. `reasons` are stable codes with no identifiers or values. */
export class LearningGateRefusedError extends Error {
  readonly code = 'LEARNING_GATE_REFUSED';
  constructor(readonly reasons: readonly string[]) {
    super(`learning release refused: ${reasons.join(', ')}`);
    this.name = 'LearningGateRefusedError';
  }
}

/** Read-only access to OM's own verification facts for an observation. */
export interface LearningSourceReader {
  learningSourcesForObservation(ctx: TenantContext, businessId: string, observationId: string): Promise<LearningSourceLookup>;
}

/** What the sink is told about the evidence that passed the gate (references only). */
export interface ReleasedEvidence {
  executions: readonly { executionId: string; evidenceDigest: string }[];
}

/** Where a released hand-off goes (a future OM publication / CL intake step). Called only after the gate passed. */
export type LearningSink = (handoff: OMToCLHandoff, evidence: ReleasedEvidence) => Promise<void>;

/** Explicit composition seam for an intake consumer. Only OM owns the source lookup and release decision; no production factory is wired by default. */
export type LearningReleaseFactory = (sink: LearningSink) => Pick<LearningReleaseBoundary, 'release'>;

export interface LearningReleaseBoundaryDependencies {
  sources: LearningSourceReader;
  sink: LearningSink;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class LearningReleaseBoundary {
  constructor(private readonly deps: LearningReleaseBoundaryDependencies) {}

  async release(ctx: TenantContext, handoff: unknown): Promise<{ released: true; executions: number }> {
    const payload = isRec(handoff) && isRec(handoff.payload) ? handoff.payload : null;
    const businessId = payload && typeof payload.businessId === 'string' ? payload.businessId : null;
    const observationId = payload && typeof payload.observationId === 'string' ? payload.observationId : null;

    // A hand-off for another tenant or workspace is refused without touching the database at all.
    const inScope = !!payload && payload.tenantId === ctx.tenantId && payload.workspaceId === ctx.workspaceId;
    let observation: LearningObservationRef | null = null;
    let sources: LearningSourceFact[] = [];
    const lookupFailed: string[] = [];
    if (businessId && observationId && inScope) {
      try {
        const found = await this.deps.sources.learningSourcesForObservation(ctx, businessId, observationId);
        observation = found.observation;
        sources = found.facts.map((f) => ({ ...f }));
      } catch {
        lookupFailed.push('SOURCE_LOOKUP_FAILED');
      }
    }

    const decision = decideLearningRelease({
      handoff, deliveryScope: { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }, observation, sources,
    });
    if (!decision.released || lookupFailed.length > 0) throw new LearningGateRefusedError([...lookupFailed, ...decision.reasons]);

    await this.deps.sink(handoff as OMToCLHandoff, { executions: sources.map((s) => ({ executionId: s.executionId, evidenceDigest: s.evidenceDigest })) });
    return { released: true, executions: sources.length };
  }
}
