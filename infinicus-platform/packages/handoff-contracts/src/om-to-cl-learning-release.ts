// The OM -> CL learning RELEASE decision (CL-BOUNDARY-1). Pure: no I/O, no clock, never throws.
//
// Guardrail Section XI/XII: an executed action is not a worked action, and Continuous Learning may learn only from a VERIFIED outcome of a SUCCEEDED,
// APPLIED execution. The one authority for that rule is `learningEligibility` (execution-evidence/states.ts). This module does not restate it: it
// CALLS it for every execution fact behind an OM -> CL hand-off, and adds only what the gate cannot know - that the hand-off is well formed, that its
// scope is the delivery scope, that the facts come from OM's own execution verification (the only authoritative source), that they belong to the
// observation the hand-off is about, and that they do not contradict each other. A release is possible only if ALL of that holds; any doubt refuses.
//
// Reasons are stable codes with no identifiers or values, so they are safe to log and to return.
import { learningEligibility } from './execution-evidence/states';
import { validateOMToCLHandoff } from './om-to-cl';
import type { OMToCLHandoffPayload } from './om-to-cl';

/** The only evidence source that can support learning: OM's verification of a Business Operations execution. */
export const LEARNING_SOURCE_KIND = 'om_execution_verification' as const;

/** One verified-execution fact as OM holds it. Read by OM from its own table; never supplied by the caller of the boundary. */
export interface LearningSourceFact {
  source: typeof LEARNING_SOURCE_KIND;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  executionId: string;
  evidenceDigest: string;
  monitoredActionId: string | null;
  approvedActionId: string | null;
  executionState: string;
  outcomeState: string;
  executionOutcome: string;
  mutationResult: string;
}

/** What OM knows about the observation the hand-off is about (read from OM's own tables), or null when it does not exist in the scope. */
export interface LearningObservationRef {
  businessId: string;
  monitoredActionId: string | null;
  approvedActionId: string | null;
}

export interface LearningReleaseInput {
  handoff: unknown;
  /** The authenticated delivery scope. */
  deliveryScope: { tenantId: string; workspaceId: string };
  observation: LearningObservationRef | null;
  sources: readonly LearningSourceFact[];
}

export interface LearningReleaseDecision {
  released: boolean;
  /** Empty only when released. */
  reasons: readonly string[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Decides whether an OM -> CL hand-off may be released to Continuous Learning. Fail closed: `released` is true only when no check produced a reason.
 */
export function decideLearningRelease(input: LearningReleaseInput): LearningReleaseDecision {
  const reasons = new Set<string>();
  try {
    const checked = validateOMToCLHandoff(input.handoff);
    for (const r of checked.reasons) reasons.add(`HANDOFF_INVALID:${r}`);
    const payload = (input.handoff as { payload?: OMToCLHandoffPayload } | null | undefined)?.payload;

    if (!payload || typeof payload !== 'object') {
      reasons.add('HANDOFF_PAYLOAD_MISSING');
    } else if (input.deliveryScope.tenantId !== payload.tenantId || input.deliveryScope.workspaceId !== payload.workspaceId) {
      reasons.add('SCOPE_MISMATCH');
    }

    const obs = input.observation;
    if (!obs) reasons.add('OBSERVATION_NOT_FOUND');
    else if (!payload || obs.businessId !== payload.businessId) reasons.add('OBSERVATION_BUSINESS_MISMATCH');

    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      // A human-entered observation with no OM-verified execution behind it is not evidence a system may learn from.
      reasons.add('NO_VERIFIED_EXECUTION_SOURCE');
    } else {
      const seen = new Map<string, LearningSourceFact>();
      for (const fact of input.sources) {
        if (!fact || typeof fact !== 'object') { reasons.add('SOURCE_INCOMPLETE'); continue; }
        if (fact.source !== LEARNING_SOURCE_KIND) reasons.add('SOURCE_KIND_UNSUPPORTED');
        const required = [fact.tenantId, fact.workspaceId, fact.businessId, fact.executionId, fact.evidenceDigest, fact.executionState, fact.outcomeState, fact.executionOutcome, fact.mutationResult];
        if (!required.every(isText)) reasons.add('SOURCE_INCOMPLETE');
        if (isText(fact.evidenceDigest) && !DIGEST.test(fact.evidenceDigest)) reasons.add('SOURCE_DIGEST_INVALID');
        if (payload && (fact.tenantId !== payload.tenantId || fact.workspaceId !== payload.workspaceId || fact.businessId !== payload.businessId)) reasons.add('SOURCE_SCOPE_MISMATCH');
        if (obs) {
          const byAction = isText(obs.monitoredActionId) && fact.monitoredActionId === obs.monitoredActionId;
          const byApproval = isText(obs.approvedActionId) && fact.approvedActionId === obs.approvedActionId;
          if (!byAction && !byApproval) reasons.add('SOURCE_NOT_LINKED_TO_OBSERVATION');
        }
        const prior = seen.get(fact.executionId);
        if (prior && (prior.evidenceDigest !== fact.evidenceDigest || prior.outcomeState !== fact.outcomeState
          || prior.executionOutcome !== fact.executionOutcome || prior.mutationResult !== fact.mutationResult)) reasons.add('SOURCE_CONFLICT');
        seen.set(fact.executionId, fact);
        // The ONE learning gate. Every fact must pass it; a single pending, inconclusive, failed or unverified fact closes the release.
        const gate = learningEligibility({ executionState: fact.executionState, outcomeState: fact.outcomeState, executionOutcome: fact.executionOutcome, mutationResult: fact.mutationResult });
        if (!gate.eligible) reasons.add('LEARNING_GATE_CLOSED');
      }
    }
  } catch {
    reasons.add('DECISION_ERROR');
  }
  return { released: reasons.size === 0, reasons: [...reasons] };
}
