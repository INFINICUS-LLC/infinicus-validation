import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LearningReleaseInput } from '@infinicus/handoff-contracts';
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
    // A deliberately minimal synthetic handoff; even if contract evolution makes it
    // eligible, shadow output MUST always remain non-authorizing.
    const candidate = {
      handoff: { payload: { tenantId: 't', workspaceId: 'w' } },
      deliveryScope: { tenantId: 't', workspaceId: 'w' },
      observation: null,
      sources: [],
    } as LearningReleaseInput;
    const result = evaluateLearningShadow(candidate);
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
