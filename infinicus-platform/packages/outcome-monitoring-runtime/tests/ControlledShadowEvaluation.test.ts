import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LearningReleaseInput } from '@infinicus/handoff-contracts';
import { evaluateControlledShadow, type ShadowControls } from '../src/ControlledShadowEvaluation.js';

const scope = { tenantId: 'tenant-one', workspaceId: 'workspace-one', businessId: 'business-one' };
const input = (): LearningReleaseInput => ({
  handoff: { payload: { ...scope } },
  deliveryScope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
  observation: null, sources: [],
}) as LearningReleaseInput;
const enabled = (): ShadowControls => ({ enabled: true, killSwitch: false, approvedScope: { ...scope } });
const noAuthority = (result: ReturnType<typeof evaluateControlledShadow>) => {
  expect(result.mode).toBe('SHADOW_ONLY');
  expect(result.releaseAuthorized).toBe(false);
  expect(result.learningApplied).toBe(false);
  expect(result.mutationsPermitted).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.reasons)).toBe(true);
};

describe('CL-ACT-05 controlled shadow evaluation', () => {
  it('is default-off without explicit controls', () => {
    const result = evaluateControlledShadow(input());
    expect(result.evaluated).toBe(false);
    expect(result.controlReason).toBe('SHADOW_DISABLED');
    noAuthority(result);
  });

  it('kill switch overrides an enabled flag', () => {
    const result = evaluateControlledShadow(input(), { ...enabled(), killSwitch: true });
    expect(result.evaluated).toBe(false);
    expect(result.controlReason).toBe('KILL_SWITCH_ACTIVE');
    noAuthority(result);
  });

  it('explicit scoped enablement performs an advisory evaluation without granting authority', () => {
    const result = evaluateControlledShadow(input(), enabled());
    expect(result.evaluated).toBe(true);
    expect(result.controlReason).toBe('SHADOW_EVALUATED');
    expect(result.candidateEligible).toBe(false);
    noAuthority(result);
  });

  it('refuses wrong tenant, workspace, business or delivery scope before evaluation', () => {
    const cases = [
      { ...enabled(), approvedScope: { ...scope, tenantId: 'other' } },
      { ...enabled(), approvedScope: { ...scope, workspaceId: 'other' } },
      { ...enabled(), approvedScope: { ...scope, businessId: 'other' } },
    ];
    for (const controls of cases) {
      const result = evaluateControlledShadow(input(), controls);
      expect(result.evaluated).toBe(false);
      expect(result.controlReason).toBe('CONTROL_INVALID');
      noAuthority(result);
    }
    const mismatched = input();
    mismatched.deliveryScope = { tenantId: 'other', workspaceId: scope.workspaceId };
    expect(evaluateControlledShadow(mismatched, enabled()).evaluated).toBe(false);
  });

  it('fails closed for missing scope or malformed input', () => {
    const result = evaluateControlledShadow({ ...input(), handoff: null }, enabled());
    expect(result.evaluated).toBe(false);
    expect(result.controlReason).toBe('CONTROL_INVALID');
    noAuthority(result);
  });

  it('does not expose database, network, writer or learning sink dependencies', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/ControlledShadowEvaluation.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(imports).toEqual(['@infinicus/handoff-contracts', './LearningShadowEvaluation.js']);
    expect(source).not.toMatch(/\b(?:fetch|LearningReleaseBoundary|LearningSink|withTenantTransaction|INSERT INTO|UPDATE|DELETE FROM|publish|applyMutation)\s*\(/);
  });
});
