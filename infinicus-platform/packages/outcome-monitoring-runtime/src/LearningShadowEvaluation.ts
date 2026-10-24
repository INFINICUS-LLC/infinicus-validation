/**
 * CL-ACT-02: offline, advisory-only rehearsal of the existing OM -> CL gate.
 *
 * This module has no database, publication, learning-sink, model, policy or BO
 * dependency. Its inputs are hypothetical test data; even an eligible result
 * is NOT a verified outcome, an authorized handoff, or permission to learn.
 * Production never constructs a learning release from this result.
 */
import { decideLearningRelease } from '@infinicus/handoff-contracts';
import type { LearningReleaseInput } from '@infinicus/handoff-contracts';

export type ShadowEvaluationResult = Readonly<{
  mode: 'SHADOW_ONLY';
  candidateEligible: boolean;
  releaseAuthorized: false;
  learningApplied: false;
  mutationsPermitted: false;
  reasons: readonly string[];
}>;

/** Pure gate rehearsal; does not receive or invoke a sink or a write port. */
export function evaluateLearningShadow(input: LearningReleaseInput): ShadowEvaluationResult {
  const decision = decideLearningRelease(input);
  return Object.freeze({
    mode: 'SHADOW_ONLY',
    candidateEligible: decision.released,
    releaseAuthorized: false,
    learningApplied: false,
    mutationsPermitted: false,
    reasons: Object.freeze([...decision.reasons]),
  });
}
