// Outcome Monitoring's verification vocabulary and the learning gate (P0-6d). Pure.
//
// EXECUTION VERIFIED  = OM proved that the execution fact Business Operations reported is real, in scope and untampered.
// OUTCOME *           = what OM has (or has not) established about the EFFECT of that execution.
// The two are different questions. Verifying an execution says nothing about whether it worked; no outcome state is ever derived from
// the execution fact alone, and Continuous Learning may learn only from a VERIFIED outcome of a SUCCEEDED, APPLIED execution.
import type { ExecutionMutationResult, ExecutionOutcomeValue } from './types';

export const EXECUTION_STATES = ['EXECUTION_VERIFIED'] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const OUTCOME_STATES = ['OUTCOME_PENDING', 'OUTCOME_OBSERVED', 'OUTCOME_VERIFIED', 'OUTCOME_INCONCLUSIVE', 'OUTCOME_FAILED'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/**
 * The only outcome states OM may assign when it VERIFIES AN EXECUTION. Observation (OUTCOME_OBSERVED / OUTCOME_VERIFIED / OUTCOME_FAILED)
 * needs an authoritative measurement model that does not exist yet (see P0-6d_OUTCOME_MEASUREMENT_AUTHORITY.md); until it does, no
 * code path can produce them and the database refuses them.
 */
export const INITIAL_OUTCOME_STATES = ['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE'] as const;
export type InitialOutcomeState = (typeof INITIAL_OUTCOME_STATES)[number];

export interface LearningEligibilityInput {
  executionState: string;
  outcomeState: string;
  executionOutcome: string;
  mutationResult: string;
}

export interface LearningEligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * The learning gate. Fail closed: eligible ONLY when OM has VERIFIED the outcome of an execution that SUCCEEDED and APPLIED a change.
 * A merely verified execution, a pending/inconclusive/observed/failed outcome, a no-op, a refusal or a failure is never eligible.
 */
export function learningEligibility(i: LearningEligibilityInput): LearningEligibility {
  const reasons: string[] = [];
  if (i.executionState !== 'EXECUTION_VERIFIED') reasons.push('the execution is not verified');
  if (i.outcomeState !== 'OUTCOME_VERIFIED') reasons.push(`the outcome is ${i.outcomeState}, not OUTCOME_VERIFIED`);
  if ((i.executionOutcome as ExecutionOutcomeValue) !== 'SUCCEEDED') reasons.push(`the execution was ${i.executionOutcome}, not SUCCEEDED`);
  if ((i.mutationResult as ExecutionMutationResult) !== 'APPLIED') reasons.push(`the mutation result was ${i.mutationResult}, not APPLIED`);
  return { eligible: reasons.length === 0, reasons };
}
