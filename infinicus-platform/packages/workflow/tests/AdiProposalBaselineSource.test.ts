/** AC-1 corrections (ruling 1) - the ADI side of BO's plain-approval baseline port: references only, and only for the exact stored, in-scope proposal. No database. */
import { describe, expect, it } from 'vitest';
import { ADI_PROPOSED_ACTION_CONTRACT, BO_EVALUATION_REFERENCE_KIND, BO_FACTS_REFERENCE_KIND, type ProposedActionRecommendation } from '@infinicus/handoff-contracts';
import { AdiProposalBaselineSource } from '../src/AdiProposalBaselineSource.js';
import type { StoredProposedAction } from '../src/ProposedActionSource.js';

const ctx = { tenantId: 't', workspaceId: 'w', userId: 'u' } as never;
const ITEM = '11111111-1111-4111-8111-111111111111';
const D = `sha256:${'c'.repeat(64)}`;
const proposal = (): ProposedActionRecommendation => ({
  contract: ADI_PROPOSED_ACTION_CONTRACT, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ITEM },
  proposedParameters: { reorderPoint: 175, reorderQuantity: 180 }, currentState: null,
  evidenceReferences: [{ kind: BO_FACTS_REFERENCE_KIND, digest: D }, ...['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'].map((dimension, i) => ({ kind: BO_EVALUATION_REFERENCE_KIND, id: `00000000-0000-4000-8000-00000000000${i}`, dimension, digest: D }))],
  reasoning: { summary: 's', basis: ['b'] }, confidence: { kind: 'RULE_COMPLIANCE', value: null, statement: 'st' }, constraints: {},
  provenance: { producer: 'p', producerVersion: '1', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'v', producedAt: '2026-10-13T00:00:00.000Z' },
});
const stored = (over: Partial<StoredProposedAction> = {}): StoredProposedAction => ({ proposal: proposal(), recommendationId: 'r', recommendationVersionId: 'v', tenantId: 't', workspaceId: 'w', businessId: 'b', ...over });
const source = (s: StoredProposedAction | null) => new AdiProposalBaselineSource({ getForRecommendation: async () => s });
const request = (over: Record<string, unknown> = {}) => ({
  businessId: 'b', recommendationId: 'r', actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ITEM }, parameters: { reorderPoint: 175, reorderQuantity: 180 }, ...over,
}) as never;

describe('AC-1 AdiProposalBaselineSource', () => {
  it('returns the four cited BO evaluation references for the exact stored proposal', async () => {
    const refs = await source(stored()).evaluationReferencesFor(ctx, request());
    expect(refs.map((r) => r.dimension)).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
    expect(refs.every((r) => r.kind === BO_EVALUATION_REFERENCE_KIND && typeof r.id === 'string')).toBe(true);
  });
  it('returns nothing (fail closed) without a stored proposal, for another business or tenant, and for any different action, target or parameter', async () => {
    expect(await source(null).evaluationReferencesFor(ctx, request())).toEqual([]);
    expect(await source(stored({ businessId: 'other' })).evaluationReferencesFor(ctx, request())).toEqual([]);
    expect(await source(stored({ tenantId: 'other' })).evaluationReferencesFor(ctx, request())).toEqual([]);
    expect(await source(stored({ workspaceId: 'other' })).evaluationReferencesFor(ctx, request())).toEqual([]);
    expect(await source(stored()).evaluationReferencesFor(ctx, request({ parameters: { reorderPoint: 176, reorderQuantity: 180 } }))).toEqual([]);
    expect(await source(stored()).evaluationReferencesFor(ctx, request({ target: { kind: 'inventory_item', id: '33333333-3333-4333-8333-333333333333' } }))).toEqual([]);
    expect(await source(stored()).evaluationReferencesFor(ctx, request({ actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }))).toEqual([]);
  });
});
