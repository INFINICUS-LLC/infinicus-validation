/**
 * CL-ACT-03 disposable rehearsal. Synthetic in-memory fixtures only:
 * no PostgreSQL, production credentials, publication or write dependencies.
 * OUTCOME_VERIFIED here is hypothetical and does not grant real authority.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CL_REQUIRED_TARGET_LAYER, OM_TO_CL_CONTRACT_VERSION,
  type LearningReleaseInput, type LearningSourceFact, type OMToCLHandoff,
} from '@infinicus/handoff-contracts';
import { evaluateLearningShadow } from '../src/LearningShadowEvaluation.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const OTHER = '99999999-9999-4999-8999-999999999999';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function fixture(): LearningReleaseInput {
  const handoff: OMToCLHandoff = {
    handoffId: 'shadow-fixture', sourceLayer: 'OM', sourceBlock: 'OM-09',
    targetLayer: 'CL', targetBlock: 'CL-01', correlationId: 'shadow-correlation',
    status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
    lineage: [{ layer: 'OM', block: 'OM-09', recordId: 'shadow-obs',
      timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
    payload: {
      contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId: T, workspaceId: W,
      businessId: B, idempotencyKey: 'shadow-only', observationId: 'shadow-obs',
      observationVersionId: 'shadow-version', observationVersion: 1,
      feedbackPackageId: 'shadow-feedback', feedbackPackageVersionId: 'shadow-feedback-version',
      feedbackStatus: 'ready', summary: 'synthetic rehearsal',
      findings: [{ findingCode: 'rehearsal', statement: 'synthetic' }],
      reviewActions: [], varianceSummary: [],
      evidenceReferences: ['om://outcome_observation_versions/shadow-version'],
      omPublicationPackageId: 'shadow-publication', targetLayer: CL_REQUIRED_TARGET_LAYER,
      targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z',
    },
  };
  const source: LearningSourceFact = {
    source: 'om_execution_verification', tenantId: T, workspaceId: W, businessId: B,
    executionId: 'shadow-execution', evidenceDigest: DIGEST,
    monitoredActionId: A, approvedActionId: null,
    executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED',
    executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED',
  };
  return {
    handoff, deliveryScope: { tenantId: T, workspaceId: W },
    observation: { businessId: B, monitoredActionId: A, approvedActionId: null },
    sources: [source],
  };
}

function assertShadowOnly(result: ReturnType<typeof evaluateLearningShadow>) {
  expect(result.mode).toBe('SHADOW_ONLY');
  expect(result.releaseAuthorized).toBe(false);
  expect(result.learningApplied).toBe(false);
  expect(result.mutationsPermitted).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.reasons)).toBe(true);
}

describe('CL-ACT-03 disposable shadow rehearsal', () => {
  it('rehearses a hypothetical eligible fixture without release, learning or mutation', () => {
    const result = evaluateLearningShadow(fixture());
    expect(result.candidateEligible, result.reasons.join(', ')).toBe(true);
    expect(result.reasons).toEqual([]);
    assertShadowOnly(result);
  });

  it('refuses cross-tenant, workspace and business substitution', () => {
    const scenarios: Array<[string, (f: LearningReleaseInput) => void]> = [
      ['tenant', f => { f.deliveryScope.tenantId = OTHER; }],
      ['workspace', f => { f.deliveryScope.workspaceId = OTHER; }],
      ['business', f => { f.sources = [{ ...f.sources[0], businessId: OTHER }]; }],
      ['observation', f => { f.observation = { ...f.observation!, businessId: OTHER }; }],
    ];
    for (const [name, change] of scenarios) {
      const input = fixture(); change(input);
      const result = evaluateLearningShadow(input);
      expect(result.candidateEligible, name).toBe(false);
      expect(result.reasons.length, name).toBeGreaterThan(0);
      assertShadowOnly(result);
    }
  });

  it('allows identical duplicate facts but refuses conflicting identity for the same execution', () => {
    const identical = fixture();
    identical.sources = [identical.sources[0], { ...identical.sources[0] }];
    expect(evaluateLearningShadow(identical).candidateEligible).toBe(true);
    const conflicting = fixture();
    conflicting.sources = [conflicting.sources[0], { ...conflicting.sources[0], approvedActionId: OTHER }];
    const result = evaluateLearningShadow(conflicting);
    expect(result.candidateEligible).toBe(false);
    expect(result.reasons).toContain('SOURCE_CONFLICT');
    assertShadowOnly(result);
  });

  it('rejects tampered digests, unsupported sources, unverified outcomes and detached actions', () => {
    const cases: Array<[string, Partial<LearningSourceFact>]> = [
      ['digest', { evidenceDigest: 'sha256:tampered' }],
      ['source', { source: 'external_system' as never }],
      ['outcome', { outcomeState: 'OUTCOME_PENDING' }],
      ['action', { monitoredActionId: OTHER }],
      ['execution', { executionState: 'EXECUTION_PENDING' }],
    ];
    for (const [name, change] of cases) {
      const input = fixture();
      input.sources = [{ ...input.sources[0], ...change }];
      const result = evaluateLearningShadow(input);
      expect(result.candidateEligible, name).toBe(false);
      assertShadowOnly(result);
    }
  });

  it('does not mutate inputs and is deterministic across disposable fixture replays', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const first = evaluateLearningShadow(input);
    const second = evaluateLearningShadow(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
    assertShadowOnly(first);
  });

  it('has no production writer, sink, database or network module dependency', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/LearningShadowEvaluation.ts', import.meta.url)), 'utf8');
    expect(source).toContain('decideLearningRelease(input)');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(imports).toEqual(['@infinicus/handoff-contracts', '@infinicus/handoff-contracts']);
    expect(source).not.toMatch(/\b(?:fetch|LearningSink|LearningReleaseBoundary|withTenantTransaction|INSERT|UPDATE|DELETE|publish|applyMutation)\s*\(/);
  });
});
