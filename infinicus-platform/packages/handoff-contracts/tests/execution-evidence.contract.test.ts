/* eslint-disable @typescript-eslint/no-explicit-any -- tests edit arbitrary JSON documents */
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_EVIDENCE_CONTRACT_VERSION, ExecutionEvidenceInvalidError, INITIAL_OUTCOME_STATES, OUTCOME_STATES, computeExecutionEvidenceDigest,
  learningEligibility, sealExecutionEvidence, validateExecutionEvidence, validateExecutionEvidenceBody,
} from '../src';
import type { ExecutionEvidenceBody } from '../src';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D = (c: string): string => `sha256:${c.repeat(64)}`;
const T = (s: number): string => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

function body(kind: 'APPLIED' | 'NO_CHANGE' | 'REFUSED' | 'FAILED' = 'APPLIED'): any {
  const applied = kind === 'APPLIED';
  const succeeded = kind === 'APPLIED' || kind === 'NO_CHANGE';
  return {
    contractVersion: 'execution-evidence/1', evidenceKind: 'EXECUTION_FACT',
    identity: {
      executionId: U(1), packageId: U(2), packageVersion: 1, packageDigest: D('a'), claimId: U(3), receiptId: U(4),
      scope: { tenantId: U(5), workspaceId: U(6), businessId: U(7) }, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: U(8) },
    },
    timing: { claimedAt: T(0), executionStartedAt: T(1), authorityJudgedAt: succeeded ? T(2) : null },
    authority: succeeded
      ? { verdict: 'CURRENT', statusVerifiedAt: T(2), authorityVerifiedAt: T(2), statusAnswerDigest: D('b'), provider: 'aba.package-status-provider' }
      : { verdict: 'NOT_CHECKED', statusVerifiedAt: null, authorityVerifiedAt: null, statusAnswerDigest: null, provider: null },
    mutation: {
      result: applied ? 'APPLIED' : kind === 'NO_CHANGE' ? 'NO_CHANGE' : 'NOT_APPLICABLE', balanceId: succeeded ? U(9) : null,
      balanceVersionBefore: succeeded ? 1 : null, balanceVersionAfter: applied ? 2 : null,
      before: succeeded ? { reorderPoint: '100', reorderQuantity: '200' } : null, requested: succeeded ? { reorderPoint: '150', reorderQuantity: '250' } : null,
      after: applied ? { reorderPoint: '150', reorderQuantity: '250' } : null, baselineSource: succeeded ? 'BO_EVALUATION_EVIDENCE' : null,
    },
    preconditions: [{ code: 'stock_available', operator: 'gte', operand: 1, observed: '50', passed: true, problem: null }],
    boundaries: { executionWindow: { state: 'VALUE', value: { startsAt: T(-60), endsAt: null } }, budget: null, rollback: null, monitoring: null },
    outcome: { outcome: succeeded ? 'SUCCEEDED' : kind, reasonCode: succeeded ? null : 'BASELINE_CHANGED', detail: null, attemptCount: 1 },
    lineage: { correlationId: U(10), causationId: null, executor: { type: 'system', id: 'bo.authorized-action-execution' }, authorization: { actionId: U(11), decisionId: U(12), decisionVersionId: U(13), evaluationRefs: [] } },
  };
}

describe('execution-evidence/1', () => {
  it('seals and validates every execution fact: APPLIED, NO_CHANGE, REFUSED, FAILED', () => {
    for (const kind of ['APPLIED', 'NO_CHANGE', 'REFUSED', 'FAILED'] as const) {
      const sealed = sealExecutionEvidence(body(kind) as ExecutionEvidenceBody);
      expect(validateExecutionEvidence(sealed), kind).toEqual({ valid: true, problems: [] });
      expect(sealed.integrity).toEqual({ algorithm: 'sha256', canonicalVersion: 'aap-canonical/1', digest: computeExecutionEvidenceDigest(body(kind)) });
    }
  });

  it('is versioned and the digest is deterministic regardless of key order', () => {
    const a = sealExecutionEvidence(body() as ExecutionEvidenceBody);
    expect(a.contractVersion).toBe(EXECUTION_EVIDENCE_CONTRACT_VERSION);
    const reverse = (v: any): any => (Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse(v[k])])) : v);
    const reordered = reverse(body());
    expect(sealExecutionEvidence(reordered).integrity.digest).toBe(a.integrity.digest);
    expect(a.evidenceKind).toBe('EXECUTION_FACT');
  });

  it('a tampered document fails its digest; so does a substituted digest', () => {
    const sealed: any = JSON.parse(JSON.stringify(sealExecutionEvidence(body() as ExecutionEvidenceBody)));
    sealed.mutation.after.reorderPoint = '999';
    expect(validateExecutionEvidence(sealed).problems.join()).toMatch(/digest/);
    const swapped: any = JSON.parse(JSON.stringify(sealExecutionEvidence(body() as ExecutionEvidenceBody)));
    swapped.integrity.digest = D('c');
    expect(validateExecutionEvidence(swapped).valid).toBe(false);
  });

  it('is closed: unknown keys are refused at every level', () => {
    for (const edit of [
      (b: any) => { b.extra = 1; }, (b: any) => { b.identity.extra = 1; }, (b: any) => { b.identity.scope.extra = 1; }, (b: any) => { b.timing.extra = 1; },
      (b: any) => { b.authority.extra = 1; }, (b: any) => { b.mutation.extra = 1; }, (b: any) => { b.outcome.extra = 1; }, (b: any) => { b.lineage.extra = 1; },
      (b: any) => { b.lineage.authorization.extra = 1; }, (b: any) => { b.boundaries.extra = 1; }, (b: any) => { delete b.evidenceKind; },
    ]) {
      const b = body(); edit(b);
      expect(validateExecutionEvidenceBody(b).length).toBeGreaterThan(0);
      expect(() => sealExecutionEvidence(b)).toThrow(ExecutionEvidenceInvalidError);
    }
  });

  it('BO cannot claim outcome effectiveness: effectiveness vocabulary is refused at any depth', () => {
    for (const key of ['effectiveness', 'improved', 'improvement', 'businessImpact', 'expectedResult', 'successRate', 'outcomeVerified', 'outcome_observed', 'benefit', 'uplift', 'effect', 'learned', 'outcomeState']) {
      const top = body(); top.outcome[key] = true;
      const nested = body(); nested.mutation.after = { ...nested.mutation.after, [key]: 'yes' };
      const pre = body(); pre.preconditions[0][key] = 1;
      for (const b of [top, nested, pre]) expect(validateExecutionEvidenceBody(b).join(), key).toBeTruthy();
    }
    expect(() => sealExecutionEvidence({ ...body(), outcome: { ...body().outcome, effectiveness: 'IMPROVED' } })).toThrow();
  });

  it('refuses credential-like keys and oversize documents', () => {
    const b = body(); b.mutation.after = { reorderPoint: '1', apiKey: 'x' };
    expect(validateExecutionEvidenceBody(b).join()).toMatch(/credential/);
    const big = body(); big.preconditions = Array.from({ length: 4000 }, () => ({ code: 'x'.repeat(100) }));
    expect(validateExecutionEvidenceBody(big).join()).toMatch(/too large/);
  });

  it('enforces the outcome / mutation / authority consistency of an execution fact', () => {
    const cases: [string, (b: any) => void][] = [
      ['SUCCEEDED with a reason code', (b) => { b.outcome.reasonCode = 'X'; }],
      ['SUCCEEDED but NOT_APPLICABLE', (b) => { b.mutation.result = 'NOT_APPLICABLE'; b.mutation.after = null; b.mutation.balanceVersionAfter = null; }],
      ['SUCCEEDED without CURRENT authority', (b) => { b.authority.verdict = 'REVOKED'; }],
      ['APPLIED without an after-state', (b) => { b.mutation.after = null; }],
      ['APPLIED with a non-consecutive version', (b) => { b.mutation.balanceVersionAfter = 5; }],
      ['NO_CHANGE with an after-state', (b) => { b.mutation.result = 'NO_CHANGE'; }],
      ['CURRENT authority without its proof', (b) => { b.authority.statusAnswerDigest = null; }],
      ['REFUSED without a reason', (b) => { b.outcome.outcome = 'REFUSED'; b.outcome.reasonCode = null; b.mutation = { ...b.mutation, result: 'NOT_APPLICABLE', after: null, balanceVersionAfter: null }; }],
      ['REFUSED yet APPLIED', (b) => { b.outcome.outcome = 'REFUSED'; b.outcome.reasonCode = 'X'; }],
      ['an unknown outcome', (b) => { b.outcome.outcome = 'EXECUTED'; }],
      ['the legacy NOT_APPLIED vocabulary', (b) => { b.mutation.result = 'NOT_APPLIED'; }],
      ['an execution before its claim', (b) => { b.timing.executionStartedAt = T(-5); }],
      ['authority judged before the start', (b) => { b.timing.authorityJudgedAt = T(0); }],
      ['a non-millisecond timestamp', (b) => { b.timing.claimedAt = '2026-10-12T10:00:00Z'; }],
      ['a non-UUID id', (b) => { b.identity.claimId = 'claim-1'; }],
      ['a malformed digest', (b) => { b.identity.packageDigest = 'sha256:abc'; }],
      ['a zero attempt count', (b) => { b.outcome.attemptCount = 0; }],
      ['another contract version', (b) => { b.contractVersion = 'execution-evidence/2'; }],
      ['another evidence kind', (b) => { b.evidenceKind = 'OUTCOME_FACT'; }],
    ];
    for (const [name, edit] of cases) {
      const b = body(); edit(b);
      expect(validateExecutionEvidenceBody(b).length, name).toBeGreaterThan(0);
    }
    for (const kind of ['REFUSED', 'FAILED'] as const) expect(validateExecutionEvidenceBody(body(kind))).toEqual([]);
  });

  it('rejects non-objects and missing integrity', () => {
    for (const v of [null, undefined, 'x', 1, []]) expect(validateExecutionEvidence(v).valid).toBe(false);
    expect(validateExecutionEvidence(body()).valid).toBe(false);
  });
});

describe('OM state vocabulary and the learning gate', () => {
  const base = { executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED' };

  it('only a VERIFIED outcome of a SUCCEEDED, APPLIED execution is eligible for learning', () => {
    expect(learningEligibility(base)).toEqual({ eligible: true, reasons: [] });
  });

  it('execution verified is not outcome verified; nothing else is eligible (fail closed)', () => {
    for (const outcomeState of OUTCOME_STATES.filter((s) => s !== 'OUTCOME_VERIFIED')) {
      const r = learningEligibility({ ...base, outcomeState });
      expect(r.eligible, outcomeState).toBe(false);
      expect(r.reasons.join()).toContain(outcomeState);
    }
    for (const over of [
      { executionOutcome: 'REFUSED' }, { executionOutcome: 'FAILED' }, { mutationResult: 'NO_CHANGE' }, { mutationResult: 'NOT_APPLICABLE' },
      { executionState: 'EXECUTION_PENDING' }, { outcomeState: '' }, { executionOutcome: 'EXECUTED' }, { outcomeState: 'outcome_verified' },
    ]) expect(learningEligibility({ ...base, ...over }).eligible, JSON.stringify(over)).toBe(false);
  });

  it('only PENDING and INCONCLUSIVE can be assigned when an execution is verified (no observation model exists yet)', () => {
    expect([...INITIAL_OUTCOME_STATES]).toEqual(['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE']);
    expect([...OUTCOME_STATES]).toEqual(['OUTCOME_PENDING', 'OUTCOME_OBSERVED', 'OUTCOME_VERIFIED', 'OUTCOME_INCONCLUSIVE', 'OUTCOME_FAILED']);
  });
});
