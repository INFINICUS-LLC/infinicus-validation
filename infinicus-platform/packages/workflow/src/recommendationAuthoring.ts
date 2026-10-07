/**
 * ADI authoring of the risk and temporal-validity facts of a recommendation (P0-3 Block 2).
 *
 * Pure and database-free. Owner rulings applied:
 *  - Q1/Q2  risk_class = MAX(deterministic persisted floor, validated generator level, authorised human
 *        upward adjustment); model output alone is never trusted and can never lower the floor. Vocabulary
 *        low | medium | high | critical; with no valid evidence the result is UNCLASSIFIED (null), which
 *        consumers treat as high risk (P0-2).
 *  - Q5  time-sensitivity is an explicit, separate fact. It is TRUE when any authoritative
 *        signal says so, FALSE only when every signal source was evaluated and none applies,
 *        and unknown (null) when the sources were not evaluated. Risk alone never implies it.
 */

export const RISK_ORDER = ['low', 'medium', 'high', 'critical'] as const;
export type AuthoredRiskClass = (typeof RISK_ORDER)[number];

export interface RiskInputs {
  /** Risk level proposed by the generator (model output). An input/proposal only; it can never lower the floor. */
  authoredRiskLevel?: unknown;
  /** Severities of persisted `alternative_risk_profiles` rows for the chosen alternative: the deterministic floor. */
  persistedSeverities?: readonly unknown[];
  /** Authorised human upward adjustment. Raise-only: a value below the other inputs has no effect. */
  humanAdjustment?: unknown;
}

export interface DerivedRisk {
  riskClass: AuthoredRiskClass | null;
  /** Why the class is what it is (audit text); includes why it is unclassified. */
  basis: string[];
}

function isRisk(value: unknown): value is AuthoredRiskClass {
  return typeof value === 'string' && (RISK_ORDER as readonly string[]).includes(value);
}

/**
 * risk_class = MAX(deterministic persisted floor, validated generator level, authorised human upward adjustment).
 *  - Invalid/missing generator output is ignored when other valid evidence exists; it can never reduce the result.
 *  - With no valid input at all the recommendation stays UNCLASSIFIED (null), which P0-2 treats as high risk.
 *  - A persisted severity outside the vocabulary cannot occur (database CHECK); if one is supplied the result is
 *    unclassified rather than guessed.
 */
export function deriveRiskClass(inputs: RiskInputs): DerivedRisk {
  const basis: string[] = [];
  const persisted = inputs.persistedSeverities ?? [];
  if (!persisted.every(isRisk)) {
    return { riskClass: null, basis: ['a persisted risk severity is outside the vocabulary: unclassified'] };
  }
  const valid: AuthoredRiskClass[] = [];
  for (const severity of persisted as AuthoredRiskClass[]) {
    valid.push(severity);
    basis.push(`persisted risk profile severity (deterministic floor input): ${severity}`);
  }
  if (inputs.authoredRiskLevel !== undefined && inputs.authoredRiskLevel !== null) {
    if (isRisk(inputs.authoredRiskLevel)) {
      valid.push(inputs.authoredRiskLevel);
      basis.push(`generator risk level (proposal): ${inputs.authoredRiskLevel}`);
    } else {
      basis.push(`generator risk level ignored (outside the vocabulary): ${String(inputs.authoredRiskLevel)}`);
    }
  } else {
    basis.push('generator risk level missing');
  }
  if (inputs.humanAdjustment !== undefined && inputs.humanAdjustment !== null) {
    if (isRisk(inputs.humanAdjustment)) {
      valid.push(inputs.humanAdjustment);
      basis.push(`authorised human adjustment (raise-only): ${inputs.humanAdjustment}`);
    } else {
      basis.push(`human adjustment ignored (outside the vocabulary): ${String(inputs.humanAdjustment)}`);
    }
  }
  if (valid.length === 0) return { riskClass: null, basis: [...basis, 'no valid risk evidence: unclassified'] };
  const highest = valid.reduce((max, v) => (RISK_ORDER.indexOf(v) > RISK_ORDER.indexOf(max) ? v : max), valid[0]);
  return { riskClass: highest, basis: [...basis, `class is the highest valid input: ${highest}`] };
}

/**
 * Signals that make a recommendation time-sensitive (owner ruling Q5). Each is an end date;
 * `policyTimeSensitive` marks the decision class as time-sensitive by policy and, because a
 * time-sensitive recommendation MUST carry valid_until, needs a date from one of the others.
 */
export interface TimeValiditySignals {
  /** Which signal sources were actually evaluated. Anything not evaluated is unknown, not "no". */
  evaluated: {
    evidenceExpiry: boolean;
    forecastHorizon: boolean;
    actionWindow: boolean;
    policy: boolean;
    otherAuthoritativePeriod: boolean;
  };
  evidenceExpiries?: readonly Date[];
  forecastHorizonEnd?: Date | null;
  actionWindowEnd?: Date | null;
  policyTimeSensitive?: boolean;
  otherAuthoritativeEnds?: readonly Date[];
  /** Set when evaluating a source threw or was unavailable: the fact is unknown, never false. */
  evaluationError?: string;
}

export interface TimeValidity {
  isTimeSensitive: boolean | null;
  validUntil: Date | null;
  /** Set when the signals cannot produce a valid result (author must not publish). */
  error: string | null;
  basis: string[];
}

function finiteDates(values: readonly (Date | null | undefined)[]): Date[] {
  return values.filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
}

export function determineTimeValidity(signals: TimeValiditySignals): TimeValidity {
  const basis: string[] = [];
  if (signals.evaluationError) {
    return { isTimeSensitive: null, validUntil: null, error: null, basis: [`validity signal evaluation failed (${signals.evaluationError}): time-sensitivity is unknown, not false`] };
  }
  const ends = finiteDates([
    ...(signals.evidenceExpiries ?? []),
    signals.forecastHorizonEnd,
    signals.actionWindowEnd,
    ...(signals.otherAuthoritativeEnds ?? []),
  ]);
  const malformed =
    (signals.evidenceExpiries ?? []).length + (signals.otherAuthoritativeEnds ?? []).length +
      (signals.forecastHorizonEnd ? 1 : 0) + (signals.actionWindowEnd ? 1 : 0) !== ends.length;
  if (malformed) {
    return { isTimeSensitive: null, validUntil: null, error: 'a validity signal is not a valid date', basis: ['invalid date in a validity signal'] };
  }

  if (ends.length > 0) {
    // Valid only until the first authoritative input expires.
    const earliest = new Date(Math.min(...ends.map((d) => d.getTime())));
    basis.push(`authoritative end date(s) present; valid until the earliest: ${earliest.toISOString()}`);
    return { isTimeSensitive: true, validUntil: earliest, error: null, basis };
  }

  if (signals.policyTimeSensitive === true) {
    return {
      isTimeSensitive: true,
      validUntil: null,
      error: 'policy marks this decision class time-sensitive but no authoritative end date is available',
      basis: ['policy marks the decision class time-sensitive'],
    };
  }

  const allEvaluated = Object.values(signals.evaluated).every(Boolean);
  if (!allEvaluated) {
    const missing = Object.entries(signals.evaluated).filter(([, v]) => !v).map(([k]) => k);
    return { isTimeSensitive: null, validUntil: null, error: null, basis: [`not all validity signal sources were evaluated (${missing.join(', ')}): time-sensitivity is unknown`] };
  }
  return { isTimeSensitive: false, validUntil: null, error: null, basis: ['every validity signal source was evaluated and none applies'] };
}
