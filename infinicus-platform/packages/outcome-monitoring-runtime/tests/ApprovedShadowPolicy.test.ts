import { describe, expect, it } from 'vitest';
import { CL_SHADOW_POLICY_V1, CL_SHADOW_UNRESOLVED_DECISIONS, shadowPolicyMigrationGate } from '../src/ApprovedShadowPolicy.js';

describe('CL-ACT-06F owner-approved policy contract', () => {
  it('preserves explicit grants, human separation, no delegation, and default-off kill switch', () => {
    expect(CL_SHADOW_POLICY_V1.permission).toBe('cl:shadow:evaluate');
    expect(CL_SHADOW_POLICY_V1.implicitAdminInheritance).toBe(false);
    expect(CL_SHADOW_POLICY_V1.humanApproverRequired).toBe(true);
    expect(CL_SHADOW_POLICY_V1.operatorApproverSeparationRequired).toBe(true);
    expect(CL_SHADOW_POLICY_V1.delegationAllowed).toBe(false);
    expect(CL_SHADOW_POLICY_V1.defaultEnabled).toBe(false);
    expect(CL_SHADOW_POLICY_V1.killSwitchOverridesApproval).toBe(true);
    expect(CL_SHADOW_POLICY_V1.revokedOrStaleAuthorityDenied).toBe(true);
  });

  it('keeps CL audit ownership separate from canonical ABA assignments and forbids mutation', () => {
    expect(CL_SHADOW_POLICY_V1.auditOwnerDomain).toBe('continuous-learning');
    expect(CL_SHADOW_POLICY_V1.assignmentOwnerDomain).toBe('approved-business-action');
    expect(CL_SHADOW_POLICY_V1.automaticAuditDeletionAllowed).toBe(false);
    expect(CL_SHADOW_POLICY_V1.learningPublicationAllowed).toBe(false);
    expect(CL_SHADOW_POLICY_V1.modelMutationAllowed).toBe(false);
    expect(CL_SHADOW_POLICY_V1.policyMutationAllowed).toBe(false);
    expect(CL_SHADOW_POLICY_V1.businessOperationsMutationAllowed).toBe(false);
  });

  it('does not misinterpret specification approval as migration or runtime authorization', () => {
    const gate = shadowPolicyMigrationGate();
    expect(gate.specificationApproved).toBe(true);
    expect(gate.schemaMigrationAuthorized).toBe(false);
    expect(gate.liveShadowAuthorized).toBe(false);
    expect(gate.learningActivated).toBe(false);
    expect(gate.reasons).toEqual(CL_SHADOW_UNRESOLVED_DECISIONS);
    expect(Object.isFrozen(gate)).toBe(true);
    expect(Object.isFrozen(CL_SHADOW_UNRESOLVED_DECISIONS)).toBe(true);
  });
});
