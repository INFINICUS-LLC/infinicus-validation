/**
 * CL-ACT-05: default-off, advisory-only shadow execution controls.
 * No production composition, persistence, sink, network or mutation capability.
 * Operator-supplied controls cannot authorize OM verdicts or CL learning.
 */
import type { LearningReleaseInput } from '@infinicus/handoff-contracts';
import { evaluateLearningShadow, type ShadowEvaluationResult } from './LearningShadowEvaluation.js';

export type ShadowControlReason = 'SHADOW_DISABLED' | 'KILL_SWITCH_ACTIVE' | 'CONTROL_INVALID' | 'SHADOW_EVALUATED';
export interface ShadowControls {
  readonly enabled: boolean;
  readonly killSwitch: boolean;
  readonly approvedScope: Readonly<{ tenantId: string; workspaceId: string; businessId: string }>;
}
export type ControlledShadowEvaluation = Readonly<{
  mode: 'SHADOW_ONLY';
  evaluated: boolean;
  controlReason: ShadowControlReason;
  candidateEligible: boolean;
  reasons: readonly string[];
  releaseAuthorized: false;
  learningApplied: false;
  mutationsPermitted: false;
}>;

const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const disabled = (reason: ShadowControlReason): ControlledShadowEvaluation => Object.freeze({
  mode: 'SHADOW_ONLY', evaluated: false, controlReason: reason, candidateEligible: false,
  reasons: Object.freeze([reason]), releaseAuthorized: false, learningApplied: false, mutationsPermitted: false,
});

/**
 * Controls must be explicitly passed by a trusted offline caller. Absence,
 * malformed controls, kill switch, or scope mismatch all refuse before the
 * rehearsal gate is consulted. No telemetry, log or publication is emitted.
 */
export function evaluateControlledShadow(input: LearningReleaseInput, controls?: ShadowControls): ControlledShadowEvaluation {
  if (!controls || controls.enabled !== true || controls.killSwitch !== false) {
    if (controls?.killSwitch === true) return disabled('KILL_SWITCH_ACTIVE');
    return disabled('SHADOW_DISABLED');
  }
  const scope = controls.approvedScope;
  const payload = input && typeof input === 'object' && input.handoff && typeof input.handoff === 'object'
    ? (input.handoff as { payload?: unknown }).payload : null;
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  if (!scope || !valid(scope.tenantId) || !valid(scope.workspaceId) || !valid(scope.businessId) ||
      !input.deliveryScope || scope.tenantId !== input.deliveryScope.tenantId ||
      scope.workspaceId !== input.deliveryScope.workspaceId ||
      !p || p.tenantId !== scope.tenantId || p.workspaceId !== scope.workspaceId ||
      p.businessId !== scope.businessId) return disabled('CONTROL_INVALID');
  const result: ShadowEvaluationResult = evaluateLearningShadow(input);
  return Object.freeze({
    mode: 'SHADOW_ONLY', evaluated: true, controlReason: 'SHADOW_EVALUATED',
    candidateEligible: result.candidateEligible, reasons: result.reasons,
    releaseAuthorized: false, learningApplied: false, mutationsPermitted: false,
  });
}
