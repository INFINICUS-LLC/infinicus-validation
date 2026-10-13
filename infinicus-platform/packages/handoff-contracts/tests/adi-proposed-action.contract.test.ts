/** AC-1 - the ADI structured proposed-action contract: validator is fail-closed; matching helper compares exactly. */
import { describe, expect, it } from 'vitest';
import { ADI_PROPOSED_ACTION_CONTRACT, BO_EVALUATION_REFERENCE_KIND, BO_FACTS_REFERENCE_KIND, PROPOSED_ACTION_RATIONALE_CODE, STRUCTURED_ADI_PROPOSAL_REQUIRED, boEvaluationReferences, proposalEvidenceProblems, proposalMatchesCapture, validateProposedActionRecommendation, type ProposedActionRecommendation } from '../src';

const ITEM = '11111111-1111-4111-8111-111111111111';
const good = (): ProposedActionRecommendation => ({
  contract: ADI_PROPOSED_ACTION_CONTRACT,
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: ITEM },
  proposedParameters: { reorderPoint: 175, reorderQuantity: 180 },
  currentState: { reference: { kind: 'bo_inventory_balance', id: '22222222-2222-4222-8222-222222222222' }, parameters: { reorderPoint: '150', reorderQuantity: '180' } },
  evidenceReferences: [{ kind: 'bo_inventory_policy_facts', digest: `sha256:${'a'.repeat(64)}` }],
  reasoning: { summary: 'because', basis: ['demand', 'bounds'] },
  confidence: { kind: 'RULE_COMPLIANCE', value: null, statement: 'rule compliance only' },
  constraints: { ruleSetVersion: 'inventory-reorder-policy/v1.0.0' },
  provenance: { producer: 'p', producerVersion: '1.0.0', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'inventory-reorder-policy/v1.0.0', producedAt: '2026-10-13T12:00:00.000Z' },
});
const mutate = (f: (p: Record<string, any>) => void): unknown => { const p = JSON.parse(JSON.stringify(good())); f(p); return p; };

describe('AC-1 adi-proposed-action/1 validator', () => {
  it('accepts the well-formed first-action proposal', () => {
    expect(validateProposedActionRecommendation(good())).toEqual([]);
    expect(PROPOSED_ACTION_RATIONALE_CODE).toBe('proposed_action');
  });
  it('accepts a null current state', () => { expect(validateProposedActionRecommendation(mutate((p) => { p.currentState = null; }))).toEqual([]); });
  it('refuses anything that is not an object, and unknown or missing properties', () => {
    for (const v of [null, 'x', 1, [], undefined]) expect(validateProposedActionRecommendation(v).length).toBeGreaterThan(0);
    expect(validateProposedActionRecommendation(mutate((p) => { p.extra = 1; })).join()).toContain('unknown properties');
    expect(validateProposedActionRecommendation(mutate((p) => { delete p.provenance; })).join()).toContain('missing property: provenance');
  });
  it('refuses an unsupported action type, schema version or target kind (the vocabulary is canonical, not invented)', () => {
    expect(validateProposedActionRecommendation(mutate((p) => { p.actionType.code = 'price_update'; })).join()).toContain('not in the canonical vocabulary');
    expect(validateProposedActionRecommendation(mutate((p) => { p.actionType.schemaVersion = '2'; })).join()).toContain('not in the canonical vocabulary');
    expect(validateProposedActionRecommendation(mutate((p) => { p.target.kind = 'warehouse'; })).join()).toContain('target kind');
    expect(validateProposedActionRecommendation(mutate((p) => { p.target.id = 'sku-1'; })).join()).toContain('lowercase UUID');
    expect(validateProposedActionRecommendation(mutate((p) => { p.contract = 'adi-proposed-action/2'; })).join()).toContain('contract must be');
  });
  it('refuses impossible, undeclared, missing or non-numeric parameters', () => {
    expect(validateProposedActionRecommendation(mutate((p) => { p.proposedParameters.reorderPoint = -1; })).join()).toContain('below minimum');
    expect(validateProposedActionRecommendation(mutate((p) => { p.proposedParameters.reorderQuantity = '180'; })).join()).toContain('finite number');
    expect(validateProposedActionRecommendation(mutate((p) => { p.proposedParameters.reorderPoint = null; })).join()).toContain('finite number');
    expect(validateProposedActionRecommendation(mutate((p) => { delete p.proposedParameters.reorderQuantity; })).join()).toContain('required parameter reorderQuantity is missing');
    expect(validateProposedActionRecommendation(mutate((p) => { p.proposedParameters.leadTimeDays = 3; })).join()).toContain('not declared');
    expect(validateProposedActionRecommendation(mutate((p) => { p.proposedParameters = []; })).join()).toContain('proposedParameters must be an object');
  });
  it('requires evidence, reasoning, an honest confidence, constraints and provenance', () => {
    expect(validateProposedActionRecommendation(mutate((p) => { p.evidenceReferences = []; })).join()).toContain('at least one evidence reference');
    expect(validateProposedActionRecommendation(mutate((p) => { p.evidenceReferences[0].digest = 'abc'; })).join()).toContain('sha256 digest');
    expect(validateProposedActionRecommendation(mutate((p) => { p.reasoning.basis = []; })).join()).toContain('reasoning');
    expect(validateProposedActionRecommendation(mutate((p) => { p.confidence.value = 0.9; })).join()).toContain('must not claim a numeric probability');
    expect(validateProposedActionRecommendation(mutate((p) => { p.confidence = { kind: 'CALIBRATED_PROBABILITY', value: 1.5, statement: 's' }; })).join()).toContain('[0, 1]');
    expect(validateProposedActionRecommendation(mutate((p) => { p.confidence = { kind: 'CALIBRATED_PROBABILITY', value: 0.8, statement: 's' }; }))).toEqual([]);
    expect(validateProposedActionRecommendation(mutate((p) => { p.provenance.method = 'LLM'; })).join()).toContain('provenance');
    expect(validateProposedActionRecommendation(mutate((p) => { p.provenance.producedAt = '2026-10-13'; })).join()).toContain('provenance');
    expect(validateProposedActionRecommendation(mutate((p) => { p.constraints = null; })).join()).toContain('constraints');
    expect(validateProposedActionRecommendation(mutate((p) => { p.currentState = { reference: {}, parameters: {} }; })).join()).toContain('currentState');
  });
});

describe('AC-1 proposalMatchesCapture', () => {
  const cap = (over: Record<string, any> = {}) => ({ actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ITEM }, proposedParameters: { reorderPoint: 175, reorderQuantity: 180 }, ...over });
  it('equal on type, target and the exact parameter set', () => { expect(proposalMatchesCapture(good(), cap())).toEqual([]); });
  it('every difference is named', () => {
    expect(proposalMatchesCapture(good(), cap({ proposedParameters: { reorderPoint: 176, reorderQuantity: 180 } })).join()).toContain('proposed parameters differ');
    expect(proposalMatchesCapture(good(), cap({ proposedParameters: { reorderPoint: 175 } })).join()).toContain('proposed parameters differ');
    expect(proposalMatchesCapture(good(), cap({ proposedParameters: { reorderPoint: 175, reorderQuantity: 180, extra: 1 } })).join()).toContain('proposed parameters differ');
    expect(proposalMatchesCapture(good(), cap({ target: { kind: 'inventory_item', id: '33333333-3333-4333-8333-333333333333' } })).join()).toContain('target differs');
    expect(proposalMatchesCapture(good(), cap({ actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } })).join()).toContain('action type differs');
  });
});

describe('AC-1 corrections: proposal evidence completeness and the mandatory-proposal set', () => {
  const D = `sha256:${'a'.repeat(64)}`;
  const DIMS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'];
  const withEvidence = (mut: (e: Record<string, any>[]) => void = () => undefined): ProposedActionRecommendation => {
    const p = JSON.parse(JSON.stringify(good()));
    p.evidenceReferences = [{ kind: BO_FACTS_REFERENCE_KIND, digest: D }, ...DIMS.map((dimension, i) => ({ kind: BO_EVALUATION_REFERENCE_KIND, id: `00000000-0000-4000-8000-00000000000${i}`, dimension, digest: D }))];
    mut(p.evidenceReferences);
    return p;
  };
  it('the mandatory set is exactly the first action, per code and version (not global)', () => { expect([...STRUCTURED_ADI_PROPOSAL_REQUIRED]).toEqual(['inventory_reorder_policy_update@1']); });
  it('a complete proposal has one facts reference and one evaluation per canonical dimension, all with the same digest', () => {
    expect(validateProposedActionRecommendation(withEvidence())).toEqual([]);
    expect(proposalEvidenceProblems(withEvidence())).toEqual([]);
    expect(boEvaluationReferences(withEvidence()).map((r) => r.dimension).sort()).toEqual([...DIMS].sort());
  });
  it('facts-only evidence, a missing/repeated/unknown dimension, a second facts reference and a digest mismatch are all named', () => {
    expect(proposalEvidenceProblems(good()).join()).toContain('no BO evaluation reference for COST');
    expect(proposalEvidenceProblems(withEvidence((e) => e.splice(1, 1))).join()).toContain('no BO evaluation reference for CONSTRAINTS');
    expect(proposalEvidenceProblems(withEvidence((e) => { e[2].dimension = 'CONSTRAINTS'; })).join()).toContain('repeated');
    expect(proposalEvidenceProblems(withEvidence((e) => { e[1].dimension = 'NOT_A_DIMENSION'; })).join()).toContain('unexpected');
    expect(proposalEvidenceProblems(withEvidence((e) => e.push({ kind: BO_FACTS_REFERENCE_KIND, digest: D }))).join()).toContain('exactly one');
    expect(proposalEvidenceProblems(withEvidence((e) => { e[3].digest = `sha256:${'b'.repeat(64)}`; })).join()).toContain('same digest');
  });
  it('an evaluation reference without a UUID id or a dimension is refused by the validator', () => {
    expect(validateProposedActionRecommendation(withEvidence((e) => { delete e[1].id; })).join()).toContain('UUID id and a dimension');
    expect(validateProposedActionRecommendation(withEvidence((e) => { e[1].id = 'not-a-uuid'; })).join()).toContain('UUID id and a dimension');
    expect(validateProposedActionRecommendation(withEvidence((e) => { delete e[1].dimension; })).join()).toContain('UUID id and a dimension');
  });
});
