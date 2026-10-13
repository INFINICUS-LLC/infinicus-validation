/** AC-1 - the ADI proposal reader used by ABA's capture check: absent -> null, malformed or ambiguous -> error (never silently ignored). No database. */
import { describe, expect, it } from 'vitest';
import { DecisionRecommendationNotFoundError } from '@infinicus/database';
import { ADI_PROPOSED_ACTION_CONTRACT, type ProposedActionRecommendation } from '@infinicus/handoff-contracts';
import { AdiProposedActionSource, ProposedActionIntegrityError } from '../src/ProposedActionSource.js';

const ctx = { tenantId: 't', workspaceId: 'w', userId: 'u' } as never;
const proposal = (): ProposedActionRecommendation => ({
  contract: ADI_PROPOSED_ACTION_CONTRACT, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: '11111111-1111-4111-8111-111111111111' }, proposedParameters: { reorderPoint: 175, reorderQuantity: 190 }, currentState: null,
  evidenceReferences: [{ kind: 'bo_inventory_policy_facts', digest: `sha256:${'c'.repeat(64)}` }], reasoning: { summary: 's', basis: ['b'] },
  confidence: { kind: 'RULE_COMPLIANCE', value: null, statement: 'st' }, constraints: {},
  provenance: { producer: 'p', producerVersion: '1', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'v', producedAt: '2026-10-13T00:00:00.000Z' },
});
const source = (rows: unknown[] | 'no-version') => new AdiProposedActionSource({
  getPublishedVersion: async () => { if (rows === 'no-version') throw new DecisionRecommendationNotFoundError('V', 'r'); return { id: 'v1' } as never; },
  listRationalesByCode: async () => (rows === 'no-version' ? [] : rows.map((r) => ({ recommendationVersionId: 'v1', statement: 's', evidenceReference: r }))) as never,
});

describe('AC-1 AdiProposedActionSource', () => {
  it('returns the stored proposal when exactly one valid one exists', async () => { expect(await source([proposal()]).getForRecommendation(ctx, 'r')).toEqual(proposal()); });
  it('returns null for a recommendation with no published version or no structured proposal (narrative-only / legacy)', async () => {
    expect(await source('no-version').getForRecommendation(ctx, 'r')).toBeNull();
    expect(await source([]).getForRecommendation(ctx, 'r')).toBeNull();
  });
  it('a malformed or duplicated proposal is an error, never ignored', async () => {
    await expect(source([{ ...proposal(), proposedParameters: { reorderPoint: -1, reorderQuantity: 1 } }]).getForRecommendation(ctx, 'r')).rejects.toBeInstanceOf(ProposedActionIntegrityError);
    await expect(source([{}]).getForRecommendation(ctx, 'r')).rejects.toBeInstanceOf(ProposedActionIntegrityError);
    await expect(source([proposal(), proposal()]).getForRecommendation(ctx, 'r')).rejects.toThrow('more than one');
  });
  it('other repository errors propagate', async () => {
    const s = new AdiProposedActionSource({ getPublishedVersion: async () => { throw new Error('db down'); }, listRationalesByCode: async () => [] });
    await expect(s.getForRecommendation(ctx, 'r')).rejects.toThrow('db down');
  });
});
