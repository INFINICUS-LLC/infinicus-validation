import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CL_REQUIRED_TARGET_LAYER, OM_TO_CL_CONTRACT_VERSION, type LearningReleaseInput } from '@infinicus/handoff-contracts';
import { evaluateLearningShadow } from '../src/LearningShadowEvaluation.js';

const path = fileURLToPath(new URL('../src/LearningShadowEvaluation.ts', import.meta.url));

describe('CL-ACT-02 advisory shadow mode', () => {
  it('refuses incomplete inputs, with no release or mutation authority', () => {
    const result = evaluateLearningShadow({
      handoff: null, deliveryScope: { tenantId: 't', workspaceId: 'w' },
      observation: null, sources: [],
    });
    expect(result.mode).toBe('SHADOW_ONLY');
    expect(result.candidateEligible).toBe(false);
    expect(result.releaseAuthorized).toBe(false);
    expect(result.learningApplied).toBe(false);
    expect(result.mutationsPermitted).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it('does not grant release or mutation authority even if the hypothetical gate is eligible', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const businessId = '33333333-3333-4333-8333-333333333333';
    const observationId = '66666666-6666-4666-8666-666666666666';
    const monitoredActionId = '44444444-4444-4444-8444-444444444444';
    const candidate: LearningReleaseInput = {
      handoff: {
        handoffId: 'h', sourceLayer: 'OM', sourceBlock: 'OM-09', targetLayer: 'CL', targetBlock: 'CL-01',
        correlationId: 'c', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
        lineage: [{ layer: 'OM', block: 'OM-09', recordId: observationId, timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
        payload: {
          contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId, workspaceId, businessId, idempotencyKey: 'k',
          observationId, observationVersionId: 'v', observationVersion: 1, feedbackPackageId: 'fb', feedbackPackageVersionId: 'fbv',
          feedbackStatus: 'ready', summary: 's', findings: [{ findingCode: 'f', statement: 's' }], reviewActions: [], varianceSummary: [],
          evidenceReferences: ['om://x'], omPublicationPackageId: 'p', targetLayer: CL_REQUIRED_TARGET_LAYER,
          targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z',
        },
      },
      deliveryScope: { tenantId, workspaceId },
      observation: { businessId, monitoredActionId, approvedActionId: null },
      sources: [{ source: 'om_execution_verification', tenantId, workspaceId, businessId, executionId: 'e1',
        evidenceDigest: `sha256:${'a'.repeat(64)}`, monitoredActionId, approvedActionId: null,
        executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_VERIFIED', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED' }],
    };
    const result = evaluateLearningShadow(candidate);
    expect(result.candidateEligible).toBe(true); // Synthetic eligibility is still not authority.
    expect(result.mode).toBe('SHADOW_ONLY');
    expect(result.releaseAuthorized).toBe(false);
    expect(result.learningApplied).toBe(false);
    expect(result.mutationsPermitted).toBe(false);
  });

  it('does not import persistence, production composition, mutation or learning sink capabilities', () => {
    const source = readFileSync(resolve(path), 'utf8');
    expect(source).toContain('decideLearningRelease(input)');
    expect(source).not.toMatch(/from ['"]@infinicus\/(database|business-operations-runtime|workflow|layer-continuous-learning)/);
    expect(source).not.toMatch(/\b(?:LearningReleaseBoundary|LearningSink|INSERT INTO|UPDATE\s+|DELETE FROM|model\.save|policy\.update|executeOn\()\b/);
  });
});
