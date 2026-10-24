import { describe, expect, it } from 'vitest';
import {
  REVENUE_POLICY_AUTHORIZATION_ENABLED, assessRevenuePolicyCandidate, proposedRevenuePeriods,
} from '../src/RevenuePolicyCandidate.js';

const midnight = '2026-10-10T00:00:00.000Z';
const midday = '2026-10-10T12:30:00.000Z';
const candidate = (effectiveAt = midnight) => ({
  effectiveAt, periods: proposedRevenuePeriods(effectiveAt)!, baselineMinor: '10000',
  observedMinor: '11000', baselineComplete: true, observationComplete: true,
});

describe('owner revenue policy v1, disabled authorization rehearsal', () => {
  it('aligns seven full UTC days at midnight with no gap', () => {
    expect(proposedRevenuePeriods(midnight)).toEqual({
      baselineOpenedAt: '2026-10-03T00:00:00.000Z', baselineClosedAt: midnight,
      observationOpenedAt: midnight, observationClosedAt: '2026-10-17T00:00:00.000Z',
      executionToObservationGapSeconds: 0,
    });
  });

  it('aligns mid-day execution to the next UTC day and records its gap', () => {
    expect(proposedRevenuePeriods(midday)).toEqual({
      baselineOpenedAt: '2026-10-03T00:00:00.000Z', baselineClosedAt: midnight,
      observationOpenedAt: '2026-10-11T00:00:00.000Z', observationClosedAt: '2026-10-18T00:00:00.000Z',
      executionToObservationGapSeconds: 41_400,
    });
    expect(proposedRevenuePeriods('2026-02-30T00:00:00.000Z')).toBeNull();
    expect(proposedRevenuePeriods('2026-10-10T12:30:00+03:00')).toBeNull();
  });

  it('uses exact signed minor-unit arithmetic and treats 10 percent as inclusive', () => {
    const exact = assessRevenuePolicyCandidate(candidate());
    expect(exact.criterionSignal).toBe('MEETS_10_PERCENT');
    expect(exact).toMatchObject({ authoritative: false, verdictAllowed: false, outcomeState: 'OUTCOME_INCONCLUSIVE' });
    expect(REVENUE_POLICY_AUTHORIZATION_ENABLED).toBe(false);
    expect(assessRevenuePolicyCandidate({ ...candidate(), observedMinor: '10999' }).criterionSignal).toBe('BELOW_10_PERCENT');
    expect(assessRevenuePolicyCandidate({ ...candidate(), baselineMinor: '1000000000000000000000000000000',
      observedMinor: '1099999999999999999999999999999' }).criterionSignal).toBe('BELOW_10_PERCENT');
  });

  it('returns inconclusive for nonpositive baseline, missing or fractional amounts, and incomplete evidence', () => {
    for (const baselineMinor of ['0', '-1']) {
      const result = assessRevenuePolicyCandidate({ ...candidate(), baselineMinor });
      expect(result.criterionSignal).toBe('UNDETERMINED');
      expect(result.reasons).toContain('BASELINE_NONPOSITIVE');
    }
    for (const observedMinor of [null, '110.00', '1e5']) {
      const result = assessRevenuePolicyCandidate({ ...candidate(), observedMinor });
      expect(result.criterionSignal).toBe('UNDETERMINED');
      expect(result.reasons).toContain('AMOUNT_INVALID');
    }
    const incomplete = assessRevenuePolicyCandidate({ ...candidate(), observationComplete: false });
    expect(incomplete.criterionSignal).toBe('UNDETERMINED');
    expect(incomplete.reasons).toContain('SOURCE_INCOMPLETE');
  });

  it('rejects changed boundaries and always retains all authority blockers', () => {
    const input = candidate(midday);
    const changed = assessRevenuePolicyCandidate({ ...input, periods: { ...input.periods,
      observationOpenedAt: '2026-10-10T12:30:00.000Z' } });
    expect(changed.reasons).toContain('INVALID_PERIODS');
    expect(changed.criterionSignal).toBe('UNDETERMINED');
    for (const assessment of [assessRevenuePolicyCandidate(input), changed]) {
      expect(assessment.reasons).toEqual(expect.arrayContaining([
        'BO_AUTHORITY_PENDING', 'OBSERVATION_AUTHORITY_PENDING', 'ATTRIBUTION_AUTHORITY_PENDING',
        'APPROVER_AUTHORITY_PENDING', 'FAILURE_CRITERION_UNAPPROVED',
      ]));
      expect(assessment.verdictAllowed).toBe(false);
    }
  });
});
