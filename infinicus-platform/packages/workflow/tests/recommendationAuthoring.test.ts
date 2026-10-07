import { describe, expect, it } from 'vitest';
import { deriveRiskClass, determineTimeValidity, type TimeValiditySignals } from '../src/recommendationAuthoring.js';
import { BusinessDecisionRecommendationService } from '../src/BusinessDecisionRecommendationService.js';
import type { TwinSnapshotResult } from '../src/TwinComputationService.js';

const ALL_EVALUATED: TimeValiditySignals['evaluated'] = {
  evidenceExpiry: true, forecastHorizon: true, actionWindow: true, policy: true, otherAuthoritativePeriod: true,
};
const d = (iso: string) => new Date(iso);

describe('deriveRiskClass (ADI authors the class; never lowered by another input)', () => {
  it('takes the highest of the authored level and persisted risk-profile severities', () => {
    expect(deriveRiskClass({ authoredRiskLevel: 'low', persistedSeverities: ['medium', 'critical', 'low'] }).riskClass).toBe('critical');
    expect(deriveRiskClass({ authoredRiskLevel: 'high', persistedSeverities: ['low'] }).riskClass).toBe('high');
    expect(deriveRiskClass({ authoredRiskLevel: 'medium' }).riskClass).toBe('medium');
  });

  it('is unclassified (null) when there is no evidence — never low', () => {
    expect(deriveRiskClass({}).riskClass).toBeNull();
    expect(deriveRiskClass({ authoredRiskLevel: null, persistedSeverities: [] }).riskClass).toBeNull();
  });

  it('an out-of-vocabulary input makes the result unclassified instead of being ignored', () => {
    for (const bad of ['catastrophic', '', 'LOW', 3, {}]) {
      const result = deriveRiskClass({ authoredRiskLevel: bad });
      expect(result.riskClass).toBeNull();
      expect(result.basis.join(' ')).toMatch(/vocabulary/);
    }
    expect(deriveRiskClass({ authoredRiskLevel: 'high', persistedSeverities: ['bogus'] }).riskClass).toBeNull();
  });
});

describe('determineTimeValidity (explicit fact; risk never implies it)', () => {
  it('is time-sensitive with valid_until = the earliest authoritative end date', () => {
    const result = determineTimeValidity({
      evaluated: ALL_EVALUATED,
      evidenceExpiries: [d('2026-12-01T00:00:00Z'), d('2026-11-01T00:00:00Z')],
      forecastHorizonEnd: d('2027-01-01T00:00:00Z'),
      actionWindowEnd: d('2026-11-15T00:00:00Z'),
    });
    expect(result.isTimeSensitive).toBe(true);
    expect(result.validUntil?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(result.error).toBeNull();
  });

  it('each signal source on its own makes it time-sensitive', () => {
    const base = { evaluated: ALL_EVALUATED };
    expect(determineTimeValidity({ ...base, evidenceExpiries: [d('2026-11-01T00:00:00Z')] }).isTimeSensitive).toBe(true);
    expect(determineTimeValidity({ ...base, forecastHorizonEnd: d('2026-11-01T00:00:00Z') }).isTimeSensitive).toBe(true);
    expect(determineTimeValidity({ ...base, actionWindowEnd: d('2026-11-01T00:00:00Z') }).isTimeSensitive).toBe(true);
    expect(determineTimeValidity({ ...base, otherAuthoritativeEnds: [d('2026-11-01T00:00:00Z')] }).isTimeSensitive).toBe(true);
  });

  it('a policy marking without any end date is an error, never a time-sensitive result without valid_until', () => {
    const result = determineTimeValidity({ evaluated: ALL_EVALUATED, policyTimeSensitive: true });
    expect(result.isTimeSensitive).toBe(true);
    expect(result.validUntil).toBeNull();
    expect(result.error).toMatch(/no authoritative end date/);
  });

  it('is false only when every source was evaluated and none applies', () => {
    const result = determineTimeValidity({ evaluated: ALL_EVALUATED });
    expect(result).toMatchObject({ isTimeSensitive: false, validUntil: null, error: null });
  });

  it('is unknown (null), not false, when a source was not evaluated', () => {
    for (const key of Object.keys(ALL_EVALUATED) as (keyof typeof ALL_EVALUATED)[]) {
      const result = determineTimeValidity({ evaluated: { ...ALL_EVALUATED, [key]: false } });
      expect(result.isTimeSensitive).toBeNull();
      expect(result.basis.join(' ')).toContain(key);
    }
  });

  it('rejects an invalid date in a signal', () => {
    const result = determineTimeValidity({ evaluated: ALL_EVALUATED, actionWindowEnd: new Date('nope') });
    expect(result.error).toMatch(/not a valid date/);
    expect(result.isTimeSensitive).toBeNull();
  });
});

function twinWithSales(): TwinSnapshotResult {
  return {
    businessId: 'b1', snapshotAt: '2026-10-07T00:00:00.000Z', windowDays: 30,
    financial: { revenue30d: 1200, expenses30d: 500, profit30d: 700, burnRatePerDay: 16, salesCount30d: 9 },
    customers: { new30d: 5, returning30d: 4, churned30d: 1, churnRatePct: 10 },
    operations: { netInventoryUnits30d: 10 },
    team: { hired30d: 0, terminated30d: 0, netHeadcountDelta: 0 },
  };
}

describe('BusinessDecisionRecommendationService.recommend — authors risk/validity facts (P0-3 Block 2)', () => {
  it('passes the derived class, an explicit is_time_sensitive and the Twin snapshot id to the recommendation, and records the basis', async () => {
    const SNAP = '66666666-0000-0000-0000-0000000000aa';
    const created: Array<{ riskValidity: unknown }> = [];
    const rationales: Array<{ code: string; ref: Record<string, unknown> }> = [];
    const llm = { complete: async () => JSON.stringify({ decisions: [
      { decision: 'Raise prices', rationale: 'r', expected_outcome: 'o', risk_level: 'high' },
      { decision: 'Odd risk label', rationale: 'r', expected_outcome: 'o', risk_level: 'catastrophic' },
    ] }) };
    const recommendations = {
      createRecommendation: async (...args: unknown[]) => {
        created.push({ riskValidity: args[6] });
        return { recommendation: { id: `rec-${created.length}` }, version: { id: `ver-${created.length}` } };
      },
      addRationale: async (_c: unknown, _v: unknown, _b: unknown, code: string, _s: string, ref: Record<string, unknown>) => { rationales.push({ code, ref }); },
      validateRecommendation: async () => undefined,
      publishRecommendation: async () => undefined,
    };
    const questions = { createQuestion: async () => ({ id: 'q' }) };
    const cases = { createCase: async () => ({ id: 'c' }), createVersion: async () => undefined, transitionStatus: async () => undefined };
    const twins = { getOrComputeTwin: async () => ({ twin: twinWithSales(), cached: true, snapshotId: SNAP }) };
    const service = new BusinessDecisionRecommendationService(
      questions as never, cases as never, recommendations as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      twins as never, undefined, llm as never,
    );
    await service.recommend({ tenantId: 't', workspaceId: 'w', userId: 'u' }, 'b1');

    expect(created).toHaveLength(2);
    expect(created[0].riskValidity).toEqual({ riskClass: 'high', isTimeSensitive: false, validUntil: null, twinSnapshotId: SNAP });
    // An out-of-vocabulary label is stored as unclassified (null), never guessed or lowered.
    expect(created[1].riskValidity).toEqual({ riskClass: null, isTimeSensitive: false, validUntil: null, twinSnapshotId: SNAP });
    const basis = rationales.filter((r) => r.code === 'risk_validity_basis');
    expect(basis).toHaveLength(2);
    expect(basis[0].ref).toMatchObject({ riskClass: 'high', isTimeSensitive: false, twinSnapshotId: SNAP });
  });
});
