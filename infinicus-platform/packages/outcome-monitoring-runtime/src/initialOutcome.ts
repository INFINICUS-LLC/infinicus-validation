/**
 * The only outcome verdict OM may assign when it VERIFIES AN EXECUTION (P0-6d). Pure; no I/O, no clock.
 *
 * EXECUTION_VERIFIED says the execution fact is real. It never implies an outcome, so this function returns only OUTCOME_PENDING (a change
 * was applied and its effect has not been established) or OUTCOME_INCONCLUSIVE (nothing was applied, so there is no effect to measure).
 * OUTCOME_OBSERVED / OUTCOME_VERIFIED / OUTCOME_FAILED are unreachable from here and refused by the database.
 */
import type { InitialOutcomeState } from '@infinicus/handoff-contracts';

export interface InitialOutcomeInput {
  outcome: string;
  mutationResult: string;
}

export interface InitialOutcome {
  state: InitialOutcomeState;
  reason: string;
}

export const REASON_NO_MEASUREMENT_MODEL = 'NO_AUTHORITATIVE_MEASUREMENT_MODEL: the change was applied but no governed observation window, baseline or causal attribution exists yet';
export const REASON_NOTHING_APPLIED = 'NOTHING_APPLIED: the execution applied no change, so there is no effect to measure';

export function deriveInitialOutcomeState(i: InitialOutcomeInput): InitialOutcome {
  if (i.outcome === 'SUCCEEDED' && i.mutationResult === 'APPLIED') return { state: 'OUTCOME_PENDING', reason: REASON_NO_MEASUREMENT_MODEL };
  return { state: 'OUTCOME_INCONCLUSIVE', reason: REASON_NOTHING_APPLIED };
}
