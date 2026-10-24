import { describe, expect, it } from 'vitest';
import { CL_06J_DECISIONS } from '../src/ShadowSecurityRatificationGate.js';
import { assessCL06MMigrationReadiness } from '../src/ShadowMigrationReadinessAssessment.js';
describe('CL-ACT-06M advisory migration readiness', () => {
  it('blocks readiness with no owner decisions or disposable DB proof', () => {
    const result = assessCL06MMigrationReadiness({
      ratifications: [], ownerApprovalIndependentlyVerified: false,
      exactParameterValuesReviewed: false, schemaSecurityReviewCompleted: false,
      disposablePostgresRlsAcceptanceCompleted: false,
    });
    expect(result.pendingDecisions).toEqual(CL_06J_DECISIONS);
    expect(result.missingVerification).toContain('DISPOSABLE_POSTGRES_RLS_ACCEPTANCE');
    expect(result.status).toBe('BLOCKED');
    expect(result.disposableMigrationAuthorized).toBe(false);
    expect(result.productionMigrationAuthorized).toBe(false);
    expect(result.liveShadowEnabled).toBe(false);
    expect(result.learningActivated).toBe(false);
  });
  it('refuses authority even if the caller asserts all five ratifications and all verifications', () => {
    const result = assessCL06MMigrationReadiness({
      ratifications: CL_06J_DECISIONS.map(decision => ({
        decision, status: 'RATIFIED' as const, specificationVersion: 'v1',
        approvalReference: 'caller-claimed',
      })),
      ownerApprovalIndependentlyVerified: true, exactParameterValuesReviewed: true,
      schemaSecurityReviewCompleted: true, disposablePostgresRlsAcceptanceCompleted: true,
    });
    expect(result.pendingDecisions).toEqual([]);
    expect(result.missingVerification).toEqual([]);
    expect(result.status).toBe('BLOCKED');
    expect(result.disposableMigrationAuthorized).toBe(false);
    expect(result.productionMigrationAuthorized).toBe(false);
    expect(result.learningActivated).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pendingDecisions)).toBe(true);
  });
});
