/**
 * ADI authoring of the risk and temporal-validity facts of a recommendation (P0-3 Block 2).
 *
 * Pure and database-free. Owner rulings applied:
 *  - Q1  ADI derives `risk_class` from persisted risk evidence; a classification is only ever
 *        the HIGHEST of its inputs (it can be raised, never lowered by another input).
 *  - Q2  vocabulary low | medium | high | critical; an unknown/unrecognised input makes the
 *        result UNCLASSIFIED (null), which consumers treat as high risk (P0-2). It is never
 *        ignored, because ignoring a bad input could silently lower the class.
 *  - Q5  time-sensitivity is an explicit, separate fact. It is TRUE when any authoritative
 *        signal says so, FALSE only when every signal source was evaluated and none applies,
 *        and unknown (null) when the sources were not evaluated. Risk alone never implies it.
 */

export const RISK_ORDER = ['low', 'medium', 'high', 'critical'] as const;
export type AuthoredRiskClass = (typeof RISK_ORDER)[number];

export interface RiskInputs {
  /** Risk level authored with the recommendation (e.g. the generator's risk_level). */
  authoredRiskLevel?: unknown;
  /** Severities of persisted `alternative_risk_profiles` rows for the chosen alternative. */
  persistedSeverities?: readonly unknown[];
}

export interface DerivedRisk {
  riskClass: AuthoredRiskClass | null;
  /** Why the class is what it is (audit text); includes why it is unclassified. */
  basis: string[];
}

function isRisk(value: unknown): value is AuthoredRiskClass {
  return typeof value === 'string' && (RISK_ORDER as readonly string[]).includes(value);
}

export function deriveRiskClass(inputs: RiskInputs): DerivedRisk {
  const basis: string[] = [];
  const values: unknown[] = [];
  if (inputs.authoredRiskLevel !== undefined && inputs.authoredRiskLevel !== null) {
    values.push(inputs.authoredRiskLevel);
    basis.push(`authored risk level: ${String(inputs.authoredRiskLevel)}`);
  }
  for (const severity of inputs.persistedSeverities ?? []) {
    values.push(severity);
    basis.push(`persisted risk profile severity: ${String(severity)}`);
  }
  if (values.length === 0) return { riskClass: null, basis: ['no risk evidence available: unclassified'] };
  if (!values.every(isRisk)) {
    return { riskClass: null, basis: [...basis, 'an input is outside the risk vocabulary: unclassified (never lowered by ignoring it)'] };
  }
  const highest = values.reduce<AuthoredRiskClass>(
    (max, v) => (RISK_ORDER.indexOf(v) > RISK_ORDER.indexOf(max) ? v : max),
    values[0] as AuthoredRiskClass,
  );
  return { riskClass: highest, basis: [...basis, `class is the highest input: ${highest}`] };
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
