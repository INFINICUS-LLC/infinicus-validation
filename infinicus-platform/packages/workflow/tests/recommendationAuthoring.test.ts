import { describe, expect, it } from 'vitest';
import { deriveRiskClass, determineTimeValidity, type TimeValiditySignals } from '../src/recommendationAuthoring.js';
import { BusinessDecisionRecommendationService } from '../src/BusinessDecisionRecommendationService.js';
import type { TwinSnapshotResult } from '../src/TwinComputationService.js';

const ALL_EVALUATED: TimeValiditySignals['evaluated'] = {
  evidenceExpiry: true, forecastHorizon: true, actionWindow: true, policy: true, otherAuthoritativePeriod: true,
};
const d = (iso: string) => new Date(iso);

describe('deriveRiskClass = MAX(deterministic floor, validated generator level, authorised human raise)', () => {
  it('takes the highest of the floor, the generator level and a human raise', () => {
    expect(deriveRiskClass({ authoredRiskLevel: 'low', persistedSeverities: ['medium', 'critical', 'low'] }).riskClass).toBe('critical');
    expect(deriveRiskClass({ authoredRiskLevel: 'high', persistedSeverities: ['low'] }).riskClass).toBe('high');
    expect(deriveRiskClass({ authoredRiskLevel: 'medium' }).riskClass).toBe('medium');
    expect(deriveRiskClass({ authoredRiskLevel: 'low', humanAdjustment: 'high' }).riskClass).toBe('high');
  });

  it('model output can never lower the structured floor (LOW/MEDIUM cannot reduce HIGH/CRITICAL)', () => {
    for (const model of ['low', 'medium']) {
      expect(deriveRiskClass({ authoredRiskLevel: model, persistedSeverities: ['high'] }).riskClass).toBe('high');
      expect(deriveRiskClass({ authoredRiskLevel: model, persistedSeverities: ['critical'] }).riskClass).toBe('critical');
    }
  });

  it('a human adjustment can only raise: a lower human value has no effect', () => {
    expect(deriveRiskClass({ authoredRiskLevel: 'high', persistedSeverities: ['critical'], humanAdjustment: 'low' }).riskClass).toBe('critical');
    expect(deriveRiskClass({ authoredRiskLevel: 'high', humanAdjustment: 'medium' }).riskClass).toBe('high');
  });

  it('invalid or missing model output is ignored when a deterministic floor exists, and never lowers it', () => {
    for (const bad of ['catastrophic', '', 'LOW', 3, {}, undefined, null]) {
      expect(deriveRiskClass({ authoredRiskLevel: bad, persistedSeverities: ['high'] }).riskClass).toBe('high');
    }
  });

  it('is unclassified (null) when there is no deterministic evidence and the model output is missing or invalid — never low', () => {
    expect(deriveRiskClass({}).riskClass).toBeNull();
    expect(deriveRiskClass({ authoredRiskLevel: null, persistedSeverities: [] }).riskClass).toBeNull();
    for (const bad of ['catastrophic', '', 'LOW', 3, {}]) {
      const result = deriveRiskClass({ authoredRiskLevel: bad });
      expect(result.riskClass).toBeNull();
      expect(result.basis.join(' ')).toMatch(/unclassified/);
    }
  });

  it('an invalid human adjustment is ignored, not applied', () => {
    expect(deriveRiskClass({ authoredRiskLevel: 'medium', humanAdjustment: 'extreme' }).riskClass).toBe('medium');
  });

  it('a persisted severity outside the vocabulary yields unclassified rather than a guess', () => {
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

  it('an evaluation error leaves the fact unknown (null) — never false', () => {
    const result = determineTimeValidity({ evaluated: ALL_EVALUATED, evaluationError: 'source unavailable' });
    expect(result).toMatchObject({ isTimeSensitive: null, validUntil: null, error: null });
    expect(result.basis.join(' ')).toMatch(/unknown, not false/);
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

  async function recommendWith(evaluator?: (...args: never[]) => Promise<TimeValiditySignals>) {
    const created: Array<{ riskValidity: Record<string, unknown> }> = [];
    const rationales: Array<{ code: string; ref: Record<string, unknown> }> = [];
    const llm = { complete: async () => JSON.stringify({ decisions: [{ decision: 'Hold prices', rationale: 'r', expected_outcome: 'o', risk_level: 'low' }] }) };
    const recommendations = {
      createRecommendation: async (...args: unknown[]) => { created.push({ riskValidity: args[6] as Record<string, unknown> }); return { recommendation: { id: 'rec' }, version: { id: 'ver' } }; },
      addRationale: async (_c: unknown, _v: unknown, _b: unknown, code: string, _s: string, ref: Record<string, unknown>) => { rationales.push({ code, ref }); },
      validateRecommendation: async () => undefined,
      publishRecommendation: async () => undefined,
    };
    const service = new BusinessDecisionRecommendationService(
      { createQuestion: async () => ({ id: 'q' }) } as never,
      { createCase: async () => ({ id: 'c' }), createVersion: async () => undefined, transitionStatus: async () => undefined } as never,
      recommendations as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { getOrComputeTwin: async () => ({ twin: twinWithSales(), cached: true, snapshotId: '66666666-0000-0000-0000-0000000000bb' }) } as never,
      undefined, llm as never, evaluator as never,
    );
    await service.recommend({ tenantId: 't', workspaceId: 'w', userId: 'u' }, 'b1');
    return { created, rationales };
  }

  it('is_time_sensitive = false only after a COMPLETE evaluation; a failing evaluator leaves it unknown (null), not false', async () => {
    const complete = await recommendWith();
    expect(complete.created[0].riskValidity.isTimeSensitive).toBe(false);

    const failed = await recommendWith(async () => { throw new Error('policy store unreachable'); });
    expect(failed.created[0].riskValidity.isTimeSensitive).toBeNull();
    expect(failed.created[0].riskValidity.validUntil).toBeNull();
    expect(JSON.stringify(failed.rationales)).toMatch(/policy store unreachable/);

    const incomplete = await recommendWith(async () => ({ evaluated: { ...ALL_EVALUATED, forecastHorizon: false } }));
    expect(incomplete.created[0].riskValidity.isTimeSensitive).toBeNull();
  });

  it('is_time_sensitive = true with the earliest end date when a source applies', async () => {
    const end = new Date('2026-11-01T00:00:00Z');
    const result = await recommendWith(async () => ({ evaluated: ALL_EVALUATED, actionWindowEnd: end }));
    expect(result.created[0].riskValidity.isTimeSensitive).toBe(true);
    expect((result.created[0].riskValidity.validUntil as Date).getTime()).toBe(end.getTime());
  });

  it('a policy-marked time-sensitive decision with no end date is refused rather than stored without valid_until', async () => {
    await expect(recommendWith(async () => ({ evaluated: ALL_EVALUATED, policyTimeSensitive: true }))).rejects.toThrow(/validity could not be determined/);
  });
});
