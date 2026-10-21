// CL-BOUNDARY-1 - the OM -> CL learning release decision (pure). Acceptance contract: Guardrail Sections XI and XII.
import { describe, expect, it } from 'vitest';
import { CL_REQUIRED_TARGET_LAYER, OM_TO_CL_CONTRACT_VERSION, type OMToCLHandoff } from '../src/om-to-cl';
import { decideLearningRelease, LEARNING_SOURCE_KIND, type LearningObservationRef, type LearningReleaseInput, type LearningSourceFact } from '../src/om-to-cl-learning-release';
import { learningEligibility, OUTCOME_STATES } from '../src/execution-evidence/states';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const MA = '44444444-4444-4444-8444-444444444444';
const AA = '55555555-5555-4555-8555-555555555555';
const OTHER = '99999999-9999-4999-8999-999999999999';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function handoff(over: Partial<OMToCLHandoff> = {}): OMToCLHandoff {
  return {
    handoffId: 'h-1', sourceLayer: 'OM', sourceBlock: 'OM-09', targetLayer: 'CL', targetBlock: 'CL-01', correlationId: 'c-1', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
    lineage: [{ layer: 'OM', block: 'OM-09', recordId: 'obs', timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
    payload: {
      contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, idempotencyKey: 'k', observationId: 'obs', observationVersionId: 'obsv', observationVersion: 1,
      feedbackPackageId: 'fb', feedbackPackageVersionId: 'fbv', feedbackStatus: 'ready', summary: 's', findings: [{ findingCode: 'f', statement: 's' }],
      reviewActions: [], varianceSummary: [], evidenceReferences: ['om://outcome_observation_versions/obsv'], omPublicationPackageId: 'p', targetLayer: CL_REQUIRED_TARGET_LAYER, targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z',
    },
    ...over,
  };
}
const fact = (over: Partial<LearningSourceFact> = {}): LearningSourceFact => ({
  source: LEARNING_SOURCE_KIND, tenantId: T, workspaceId: W, businessId: B, executionId: 'e1', evidenceDigest: DIGEST, monitoredActionId: MA, approvedActionId: AA,
  executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED', ...over,
});
const obs = (over: Partial<LearningObservationRef> = {}): LearningObservationRef => ({ businessId: B, monitoredActionId: MA, approvedActionId: AA, ...over });
const input = (over: Partial<LearningReleaseInput> = {}): LearningReleaseInput => ({ handoff: handoff(), deliveryScope: { tenantId: T, workspaceId: W }, observation: obs(), sources: [fact()], ...over });

describe('learning release - the one positive path', () => {
  it('is released only when the hand-off, scope, source, linkage and the learning gate ALL hold', () => {
    expect(decideLearningRelease(input())).toEqual({ released: true, reasons: [] });
  });
});

describe('Section XI - an executed action is not a worked action', () => {
  it('SUCCEEDED + APPLIED + EXECUTION_VERIFIED does not release unless the outcome is OUTCOME_VERIFIED', () => {
    for (const outcomeState of OUTCOME_STATES.filter((s) => s !== 'OUTCOME_VERIFIED')) {
      const d = decideLearningRelease(input({ sources: [fact({ outcomeState })] }));
      expect(d.released, outcomeState).toBe(false);
      expect(d.reasons).toContain('LEARNING_GATE_CLOSED');
    }
  });

  it('OUTCOME_PENDING and OUTCOME_INCONCLUSIVE (the only states OM can assign) never open the gate, for any execution fact', () => {
    for (const outcomeState of ['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE']) for (const executionOutcome of ['SUCCEEDED', 'REFUSED', 'FAILED']) for (const mutationResult of ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE']) {
      expect(decideLearningRelease(input({ sources: [fact({ outcomeState, executionOutcome, mutationResult })] })).released, `${outcomeState}/${executionOutcome}/${mutationResult}`).toBe(false);
    }
  });

  it('unsupported, misspelled or empty states stay closed', () => {
    for (const outcomeState of ['OUTCOME_EFFECTIVE', 'outcome_verified', 'VERIFIED', 'OUTCOME_VERIFIED ', '']) {
      expect(decideLearningRelease(input({ sources: [fact({ outcomeState })] })).released, JSON.stringify(outcomeState)).toBe(false);
    }
    for (const executionState of ['EXECUTION_PENDING', 'execution_verified', 'VERIFIED', '']) {
      expect(decideLearningRelease(input({ sources: [fact({ executionState })] })).released, JSON.stringify(executionState)).toBe(false);
    }
  });

  it('a failed, refused or no-change execution can never be learned from, even with a verified outcome', () => {
    for (const [executionOutcome, mutationResult] of [['FAILED', 'NOT_APPLICABLE'], ['REFUSED', 'NOT_APPLICABLE'], ['SUCCEEDED', 'NO_CHANGE']]) {
      expect(decideLearningRelease(input({ sources: [fact({ executionOutcome, mutationResult })] })).released).toBe(false);
    }
  });

  it('one closed fact among eligible ones closes the whole release', () => {
    const d = decideLearningRelease(input({ sources: [fact({ executionId: 'e1' }), fact({ executionId: 'e2', outcomeState: 'OUTCOME_PENDING' })] }));
    expect(d.released).toBe(false);
    expect(d.reasons).toContain('LEARNING_GATE_CLOSED');
  });

  it('the decision is exactly the existing learning gate: over the whole fact space released <=> learningEligibility says eligible', () => {
    const states = ['EXECUTION_VERIFIED', 'EXECUTION_PENDING', ''];
    const outs = [...OUTCOME_STATES, 'x', ''];
    let releasedCount = 0;
    for (const executionState of states) for (const outcomeState of outs) for (const executionOutcome of ['SUCCEEDED', 'REFUSED', 'FAILED', 'x']) for (const mutationResult of ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE', 'x']) {
      const gate = learningEligibility({ executionState, outcomeState, executionOutcome, mutationResult });
      const d = decideLearningRelease(input({ sources: [fact({ executionState, outcomeState, executionOutcome, mutationResult })] }));
      // an empty string also trips the completeness check; everything else must follow the gate exactly
      const complete = [executionState, outcomeState, executionOutcome, mutationResult].every((v) => v !== '');
      expect(d.released, JSON.stringify({ executionState, outcomeState, executionOutcome, mutationResult })).toBe(gate.eligible && complete);
      if (d.released) releasedCount += 1;
    }
    expect(releasedCount).toBe(1);
  });
});

describe('incomplete, mismatched, cross-tenant and improperly sourced evidence is refused', () => {
  it('an invalid hand-off is refused with the contract reasons', () => {
    for (const h of [null, undefined, 'x', {}, handoff({ status: 'draft' as never }), handoff({ sourceLayer: 'BO' as never })]) {
      const d = decideLearningRelease(input({ handoff: h }));
      expect(d.released).toBe(false);
      expect(d.reasons.some((r) => r.startsWith('HANDOFF_INVALID:') || r === 'HANDOFF_PAYLOAD_MISSING')).toBe(true);
    }
  });

  it('a hand-off for another tenant or workspace than the delivery scope is refused (cross-tenant substitution)', () => {
    expect(decideLearningRelease(input({ deliveryScope: { tenantId: OTHER, workspaceId: W } })).reasons).toContain('SCOPE_MISMATCH');
    expect(decideLearningRelease(input({ deliveryScope: { tenantId: T, workspaceId: OTHER } })).reasons).toContain('SCOPE_MISMATCH');
  });

  it('a fact from another tenant, workspace or business is refused even when it is otherwise eligible', () => {
    for (const over of [{ tenantId: OTHER }, { workspaceId: OTHER }, { businessId: OTHER }]) {
      const d = decideLearningRelease(input({ sources: [fact(over)] }));
      expect(d.released).toBe(false);
      expect(d.reasons).toContain('SOURCE_SCOPE_MISMATCH');
    }
  });

  it('an observation that does not exist in the scope, or belongs to another business, is refused', () => {
    expect(decideLearningRelease(input({ observation: null })).reasons).toContain('OBSERVATION_NOT_FOUND');
    expect(decideLearningRelease(input({ observation: obs({ businessId: OTHER }) })).reasons).toContain('OBSERVATION_BUSINESS_MISMATCH');
  });

  it('an observation with no OM-verified execution behind it (a human-entered outcome) is refused', () => {
    for (const sources of [[], undefined as unknown as LearningSourceFact[], null as unknown as LearningSourceFact[]]) {
      expect(decideLearningRelease(input({ sources })).reasons).toContain('NO_VERIFIED_EXECUTION_SOURCE');
    }
  });

  it('only OM execution verification is an authoritative source', () => {
    for (const source of ['manual_entry', 'external_system', 'bo_execution', '']) {
      expect(decideLearningRelease(input({ sources: [fact({ source: source as never })] })).reasons).toContain('SOURCE_KIND_UNSUPPORTED');
    }
  });

  it('incomplete facts and malformed digests are refused', () => {
    for (const key of ['executionId', 'evidenceDigest', 'executionState', 'outcomeState', 'executionOutcome', 'mutationResult', 'tenantId'] as const) {
      expect(decideLearningRelease(input({ sources: [fact({ [key]: '' })] })).released, key).toBe(false);
      expect(decideLearningRelease(input({ sources: [fact({ [key]: undefined as never })] })).released, key).toBe(false);
    }
    for (const evidenceDigest of ['sha256:abc', `md5:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, 'x']) {
      expect(decideLearningRelease(input({ sources: [fact({ evidenceDigest })] })).reasons).toContain('SOURCE_DIGEST_INVALID');
    }
    expect(decideLearningRelease(input({ sources: [null as unknown as LearningSourceFact] })).released).toBe(false);
  });

  it('a fact that belongs to a different action than the observation is refused; linkage by monitored action OR approved action is enough', () => {
    expect(decideLearningRelease(input({ sources: [fact({ monitoredActionId: OTHER, approvedActionId: OTHER })] })).reasons).toContain('SOURCE_NOT_LINKED_TO_OBSERVATION');
    expect(decideLearningRelease(input({ sources: [fact({ monitoredActionId: null, approvedActionId: AA })] })).released).toBe(true);
    expect(decideLearningRelease(input({ sources: [fact({ monitoredActionId: MA, approvedActionId: null })] })).released).toBe(true);
    // an observation with no known action links to nothing: null never equals null
    expect(decideLearningRelease(input({ observation: obs({ monitoredActionId: null, approvedActionId: null }), sources: [fact({ monitoredActionId: null, approvedActionId: null })] })).reasons).toContain('SOURCE_NOT_LINKED_TO_OBSERVATION');
  });

  it('conflicting facts for one execution (different digest or verdict) are refused', () => {
    expect(decideLearningRelease(input({ sources: [fact(), fact({ evidenceDigest: `sha256:${'b'.repeat(64)}` })] })).reasons).toContain('SOURCE_CONFLICT');
    expect(decideLearningRelease(input({ sources: [fact(), fact({ outcomeState: 'OUTCOME_PENDING' })] })).reasons).toContain('SOURCE_CONFLICT');
    // an exact duplicate is harmless
    expect(decideLearningRelease(input({ sources: [fact(), fact()] })).released).toBe(true);
  });
});

describe('fail closed and safe to log', () => {
  it('never throws: hostile or broken input is a refusal', () => {
    const hostile = { get handoff(): never { throw new Error('boom'); } } as unknown as LearningReleaseInput;
    expect(decideLearningRelease(hostile)).toMatchObject({ released: false });
    expect(decideLearningRelease(null as unknown as LearningReleaseInput)).toMatchObject({ released: false, reasons: ['DECISION_ERROR'] });
    expect(decideLearningRelease({ ...input(), deliveryScope: null as never })).toMatchObject({ released: false });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(decideLearningRelease(input({ handoff: cyclic })).released).toBe(false);
  });

  it('reasons are stable codes that carry no identifiers, digests or values', () => {
    const d = decideLearningRelease(input({ deliveryScope: { tenantId: OTHER, workspaceId: W }, sources: [fact({ tenantId: OTHER, evidenceDigest: DIGEST, outcomeState: 'OUTCOME_PENDING' })] }));
    const text = JSON.stringify(d.reasons);
    for (const secret of [T, W, B, MA, AA, OTHER, DIGEST, 'e1']) expect(text).not.toContain(secret);
    expect(d.reasons.every((r) => /^[A-Z_]+(:[a-z_]+)?$/.test(r) || r.startsWith('HANDOFF_INVALID:'))).toBe(true);
  });
});
