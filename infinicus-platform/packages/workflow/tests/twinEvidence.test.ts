import { describe, expect, it } from 'vitest';
import { assessTwinEvidence } from '../src/twinEvidence.js';
import { BusinessDecisionRecommendationService, deterministicRecommendations } from '../src/BusinessDecisionRecommendationService.js';
import type { TwinSnapshotResult } from '../src/TwinComputationService.js';

/** The exact snapshot the Twin produces for a business with an empty event ledger. */
function emptyTwin(): TwinSnapshotResult {
  return {
    businessId: 'b1', snapshotAt: '2026-10-07T00:00:00.000Z', windowDays: 30,
    financial: { revenue30d: 0, expenses30d: 0, profit30d: 0, burnRatePerDay: 0, salesCount30d: 0 },
    customers: { new30d: 0, returning30d: 0, churned30d: 0, churnRatePct: 0 },
    operations: { netInventoryUnits30d: 0 },
    team: { hired30d: 0, terminated30d: 0, netHeadcountDelta: 0 },
  };
}

function twinWith(patch: { financial?: Partial<TwinSnapshotResult['financial']>; customers?: Partial<TwinSnapshotResult['customers']>; team?: Partial<TwinSnapshotResult['team']> }): TwinSnapshotResult {
  const base = emptyTwin();
  return {
    ...base,
    financial: { ...base.financial, ...patch.financial },
    customers: { ...base.customers, ...patch.customers },
    team: { ...base.team, ...patch.team },
  };
}

const FORBIDDEN_CLAIMS = [/profitable/i, /healthy/i, /steady/i, /maintain current retention/i, /reinvest profit/i];

describe('assessTwinEvidence — absence of data is reported as absence, never as a result', () => {
  it('reports an all-zero snapshot as insufficient in every area, with a truthful message', () => {
    const result = assessTwinEvidence(emptyTwin());
    expect(result.overall).toBe('insufficient');
    expect([result.financial, result.customers, result.team]).toEqual(['insufficient', 'insufficient', 'insufficient']);
    expect(result.message).toMatch(/not enough real data/i);
    expect(result.message).toMatch(/confidence: low/i);
    for (const claim of FORBIDDEN_CLAIMS) expect(result.message).not.toMatch(claim);
  });

  it('marks only the areas that have recorded activity as sufficient (partial)', () => {
    const result = assessTwinEvidence(twinWith({ financial: { salesCount30d: 3, revenue30d: 120 } }));
    expect(result.overall).toBe('partial');
    expect(result.financial).toBe('sufficient');
    expect(result.customers).toBe('insufficient');
    expect(result.team).toBe('insufficient');
    expect(result.message).toMatch(/customer activity/);
    expect(result.message).toMatch(/team changes/);
  });

  it('reports sufficient only when every area has recorded activity', () => {
    const result = assessTwinEvidence(twinWith({
      financial: { expenses30d: 50 }, customers: { new30d: 1 }, team: { hired30d: 1, netHeadcountDelta: 1 },
    }));
    expect(result.overall).toBe('sufficient');
  });

  it('treats a recorded expense alone as financial evidence (a real loss is real evidence)', () => {
    expect(assessTwinEvidence(twinWith({ financial: { expenses30d: 40, burnRatePerDay: 1.3 } })).financial).toBe('sufficient');
  });

  it('does not treat NaN or non-finite values as evidence', () => {
    expect(assessTwinEvidence(twinWith({ financial: { revenue30d: Number.NaN, burnRatePerDay: Number.POSITIVE_INFINITY } })).financial).toBe('insufficient');
  });
});

describe('deterministicRecommendations — no conclusion from zeros', () => {
  it('produces NO recommendations (and none of the false claims) for an empty snapshot', () => {
    const items = deterministicRecommendations(emptyTwin());
    expect(items).toEqual([]);
  });

  it('draws a conclusion only for the area with evidence; unknown areas stay silent', () => {
    const items = deterministicRecommendations(twinWith({ financial: { salesCount30d: 4, revenue30d: 400, expenses30d: 100, profit30d: 300 } }));
    expect(items).toHaveLength(1);
    expect(items[0].decision).toMatch(/reinvest profit/i);
    const text = items.map((i) => `${i.decision} ${i.rationale}`).join(' ');
    expect(text).not.toMatch(/churn/i);
    expect(text).not.toMatch(/headcount|team/i);
  });

  it('does not call exact break-even "profitable"', () => {
    const items = deterministicRecommendations(twinWith({ financial: { salesCount30d: 2, revenue30d: 100, expenses30d: 100, profit30d: 0 } }));
    expect(items).toHaveLength(1);
    expect(`${items[0].decision} ${items[0].rationale}`).not.toMatch(/profitable|reinvest/i);
    expect(items[0].rationale).toMatch(/break-even/i);
  });

  it('still reports a real loss, a real churn problem and a real headcount drop when recorded', () => {
    const items = deterministicRecommendations(twinWith({
      financial: { salesCount30d: 1, revenue30d: 10, expenses30d: 200, profit30d: -190, burnRatePerDay: 6.7 },
      customers: { new30d: 1, returning30d: 1, churned30d: 3, churnRatePct: 60 },
      team: { hired30d: 0, terminated30d: 2, netHeadcountDelta: -2 },
    }));
    expect(items.map((i) => i.risk_level)).toEqual(['high', 'medium', 'medium']);
  });

  it('keeps the healthy-churn statement only when customers were actually recorded', () => {
    const items = deterministicRecommendations(twinWith({ customers: { new30d: 5, returning30d: 4, churned30d: 0, churnRatePct: 0 } }));
    expect(items).toHaveLength(1);
    expect(items[0].rationale).toMatch(/5 new, 4 returning/);
  });
});

describe('BusinessDecisionRecommendationService.recommend — empty business', () => {
  it('returns no decisions and an explicit insufficient-evidence state, without calling the LLM or creating any record', async () => {
    let llmCalls = 0;
    const llm = { complete: async () => { llmCalls += 1; return '{"decisions":[{"decision":"x","rationale":"y","expected_outcome":"z","risk_level":"low"}]}'; } };
    const twins = { getOrComputeTwin: async () => ({ twin: emptyTwin(), cached: false }) };
    // Repositories are never touched on the insufficient path, so the defaults are never used.
    const service = new BusinessDecisionRecommendationService(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      twins as never, undefined, llm as never,
    );
    const result = await service.recommend({ tenantId: 't', workspaceId: 'w', userId: 'u' }, 'b1');
    expect(result.decisions).toEqual([]);
    expect(result.evidence.overall).toBe('insufficient');
    expect(result.evidence.message).toMatch(/not enough real data/i);
    expect(llmCalls).toBe(0);
  });
});
