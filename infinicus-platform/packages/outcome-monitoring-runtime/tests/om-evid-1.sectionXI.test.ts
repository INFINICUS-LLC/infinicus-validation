/**
 * OM-EVID-1 - Guardrail Section XI as a property over every possible execution fact (no database).
 * "The action executed" must never become "the action worked": whatever BO reports, OM's initial verdict is PENDING or INCONCLUSIVE, and the
 * learning gate stays closed for every state OM can assign, for every spelling of anything else, and for any missing input.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_OUTCOME_STATES, OUTCOME_STATES, learningEligibility } from '@infinicus/handoff-contracts';
import { deriveInitialOutcomeState } from '../src/initialOutcome.js';

const OUTCOMES = ['SUCCEEDED', 'REFUSED', 'FAILED'] as const;
const MUTATIONS = ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE'] as const;
const EXECUTION_FACTS = OUTCOMES.flatMap((outcome) => MUTATIONS.map((mutationResult) => ({ outcome, mutationResult })));

describe('Section XI - an execution is never an effect', () => {
  it('covers every outcome x mutation combination (9) and every outcome-state name OM knows (5)', () => {
    expect(EXECUTION_FACTS).toHaveLength(9);
    expect([...OUTCOME_STATES].sort()).toEqual(['OUTCOME_FAILED', 'OUTCOME_INCONCLUSIVE', 'OUTCOME_OBSERVED', 'OUTCOME_PENDING', 'OUTCOME_VERIFIED']);
    expect([...INITIAL_OUTCOME_STATES].sort()).toEqual(['OUTCOME_INCONCLUSIVE', 'OUTCOME_PENDING']);
  });

  it('for every execution fact (including impossible ones) the derived outcome is PENDING or INCONCLUSIVE, never observed, verified or failed', () => {
    for (const fact of EXECUTION_FACTS) {
      const verdict = deriveInitialOutcomeState(fact);
      expect(['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE'], JSON.stringify(fact)).toContain(verdict.state);
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.reason.length).toBeLessThanOrEqual(200); // the database column limit
    }
  });

  it('PENDING is reserved for a SUCCEEDED execution that APPLIED a change; every other fact is INCONCLUSIVE', () => {
    for (const fact of EXECUTION_FACTS) {
      const expected = fact.outcome === 'SUCCEEDED' && fact.mutationResult === 'APPLIED' ? 'OUTCOME_PENDING' : 'OUTCOME_INCONCLUSIVE';
      expect(deriveInitialOutcomeState(fact).state, JSON.stringify(fact)).toBe(expected);
    }
  });

  it('garbage input is never promoted: unknown outcome or mutation strings cannot yield anything better than INCONCLUSIVE', () => {
    for (const outcome of ['', 'succeeded', 'SUCCESS', 'OUTCOME_VERIFIED', 'WORKED', 'EFFECTIVE', 'null', ' SUCCEEDED']) {
      for (const mutationResult of ['', 'applied', 'APPLIED ', 'OUTCOME_VERIFIED', 'x']) {
        expect(deriveInitialOutcomeState({ outcome, mutationResult }).state, `${outcome}/${mutationResult}`).toBe('OUTCOME_INCONCLUSIVE');
      }
    }
  });

  it('no execution fact together with the state OM derives for it is ever eligible for learning', () => {
    for (const fact of EXECUTION_FACTS) {
      const { state } = deriveInitialOutcomeState(fact);
      const gate = learningEligibility({ executionState: 'EXECUTION_VERIFIED', outcomeState: state, executionOutcome: fact.outcome, mutationResult: fact.mutationResult });
      expect(gate.eligible, JSON.stringify(fact)).toBe(false);
      expect(gate.reasons.length).toBeGreaterThan(0);
    }
  });

  it('the learning gate is open for exactly one combination across the whole input space, and fails closed for every deviation', () => {
    const executionStates = ['EXECUTION_VERIFIED', 'EXECUTION_PENDING', 'verified', '', 'null'];
    const outcomeStates = [...OUTCOME_STATES, 'outcome_verified', 'VERIFIED', '', 'undefined'];
    const outcomes = [...OUTCOMES, 'SUCCESS', ''];
    const mutations = [...MUTATIONS, 'applied', ''];
    const open: string[] = [];
    for (const executionState of executionStates) for (const outcomeState of outcomeStates) for (const executionOutcome of outcomes) for (const mutationResult of mutations) {
      const r = learningEligibility({ executionState, outcomeState, executionOutcome, mutationResult });
      expect(r.eligible).toBe(r.reasons.length === 0);
      if (r.eligible) open.push(`${executionState}|${outcomeState}|${executionOutcome}|${mutationResult}`);
    }
    expect(open).toEqual(['EXECUTION_VERIFIED|OUTCOME_VERIFIED|SUCCEEDED|APPLIED']);
  });

  it('the one open combination needs OUTCOME_VERIFIED, which OM cannot assign (it is not an initial state)', () => {
    expect(INITIAL_OUTCOME_STATES as readonly string[]).not.toContain('OUTCOME_VERIFIED');
    expect(INITIAL_OUTCOME_STATES as readonly string[]).not.toContain('OUTCOME_OBSERVED');
    expect(INITIAL_OUTCOME_STATES as readonly string[]).not.toContain('OUTCOME_FAILED');
  });
});
