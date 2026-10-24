/** Owner policy v1 arithmetic rehearsal. This module has no writer or verdict capability. */
export const REVENUE_POLICY_AUTHORIZATION_ENABLED = false as const;

const DAY_MS = 86_400_000;
const DAYS = 7;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;

export interface RevenuePolicyPeriods {
  baselineOpenedAt: string;
  baselineClosedAt: string;
  observationOpenedAt: string;
  observationClosedAt: string;
  executionToObservationGapSeconds: number;
}

export type RevenueCandidateReason =
  | 'INVALID_EFFECTIVE_TIME' | 'INVALID_PERIODS' | 'SOURCE_INCOMPLETE'
  | 'BASELINE_NONPOSITIVE' | 'AMOUNT_INVALID' | 'BO_AUTHORITY_PENDING'
  | 'OBSERVATION_AUTHORITY_PENDING' | 'ATTRIBUTION_AUTHORITY_PENDING'
  | 'APPROVER_AUTHORITY_PENDING' | 'FAILURE_CRITERION_UNAPPROVED';

export interface RevenuePolicyCandidateInput {
  effectiveAt: string;
  periods: RevenuePolicyPeriods;
  baselineMinor: string | null;
  observedMinor: string | null;
  baselineComplete: boolean;
  observationComplete: boolean;
}

export interface RevenuePolicyCandidateAssessment {
  readonly authoritative: false;
  readonly verdictAllowed: false;
  readonly outcomeState: 'OUTCOME_INCONCLUSIVE';
  readonly criterionSignal: 'MEETS_10_PERCENT' | 'BELOW_10_PERCENT' | 'UNDETERMINED';
  readonly reasons: readonly RevenueCandidateReason[];
}

function parseUtc(value: string): number | null {
  if (!UTC_INSTANT.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value ? instant : null;
}

/** Seven whole UTC days before and after the effective date; mid-day execution creates an explicit gap. */
export function proposedRevenuePeriods(effectiveAt: string): RevenuePolicyPeriods | null {
  const effective = parseUtc(effectiveAt);
  if (effective === null) return null;
  const dateStart = Math.floor(effective / DAY_MS) * DAY_MS;
  const observationOpen = effective === dateStart ? dateStart : dateStart + DAY_MS;
  const baselineClose = dateStart;
  return {
    baselineOpenedAt: new Date(baselineClose - DAYS * DAY_MS).toISOString(),
    baselineClosedAt: new Date(baselineClose).toISOString(),
    observationOpenedAt: new Date(observationOpen).toISOString(),
    observationClosedAt: new Date(observationOpen + DAYS * DAY_MS).toISOString(),
    executionToObservationGapSeconds: (observationOpen - effective) / 1000,
  };
}

/** Exact integer comparison: observed >= 110% of a strictly positive baseline. Never issues a verdict. */
export function assessRevenuePolicyCandidate(input: RevenuePolicyCandidateInput): RevenuePolicyCandidateAssessment {
  const reasons = new Set<RevenueCandidateReason>();
  const expected = proposedRevenuePeriods(input.effectiveAt);
  if (!expected) reasons.add('INVALID_EFFECTIVE_TIME');
  if (!expected || Object.keys(expected).some((key) =>
    input.periods[key as keyof RevenuePolicyPeriods] !== expected[key as keyof RevenuePolicyPeriods]))
    reasons.add('INVALID_PERIODS');
  if (!input.baselineComplete || !input.observationComplete) reasons.add('SOURCE_INCOMPLETE');
  if (input.baselineMinor === null || input.observedMinor === null ||
      !INTEGER.test(input.baselineMinor) || !INTEGER.test(input.observedMinor)) reasons.add('AMOUNT_INVALID');
  let signal: RevenuePolicyCandidateAssessment['criterionSignal'] = 'UNDETERMINED';
  if (!reasons.has('AMOUNT_INVALID')) {
    const baseline = BigInt(input.baselineMinor!);
    const observed = BigInt(input.observedMinor!);
    if (baseline <= 0n) reasons.add('BASELINE_NONPOSITIVE');
    else if (!reasons.has('SOURCE_INCOMPLETE') && !reasons.has('INVALID_PERIODS') && !reasons.has('INVALID_EFFECTIVE_TIME'))
      signal = observed * 100n >= baseline * 110n ? 'MEETS_10_PERCENT' : 'BELOW_10_PERCENT';
  }
  // Existing BO evidence, OM writer, attribution, and human approval cannot yet establish
  // the governed authority chain. No caller input can turn this candidate into a verdict.
  reasons.add('BO_AUTHORITY_PENDING');
  reasons.add('OBSERVATION_AUTHORITY_PENDING');
  reasons.add('ATTRIBUTION_AUTHORITY_PENDING');
  reasons.add('APPROVER_AUTHORITY_PENDING');
  reasons.add('FAILURE_CRITERION_UNAPPROVED');
  return { authoritative: false, verdictAllowed: false, outcomeState: 'OUTCOME_INCONCLUSIVE',
    criterionSignal: signal, reasons: [...reasons] };
}
