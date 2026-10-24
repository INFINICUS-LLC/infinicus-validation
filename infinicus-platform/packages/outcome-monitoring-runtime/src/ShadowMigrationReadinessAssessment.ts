/**
 * CL-ACT-06M — fail-closed, advisory-only migration readiness assessment.
 * No caller-supplied approval can authorize a migration or production use.
 */
import { CL_06J_DECISIONS, reviewSecurityRatification, type SecurityDecisionRatification } from './ShadowSecurityRatificationGate.js';

export interface MigrationReadinessEvidence {
  readonly ratifications: readonly SecurityDecisionRatification[];
  readonly ownerApprovalIndependentlyVerified: boolean;
  readonly exactParameterValuesReviewed: boolean;
  readonly schemaSecurityReviewCompleted: boolean;
  readonly disposablePostgresRlsAcceptanceCompleted: boolean;
}
export interface MigrationReadinessAssessment {
  readonly status: 'BLOCKED';
  readonly pendingDecisions: readonly string[];
  readonly missingVerification: readonly string[];
  readonly disposableMigrationAuthorized: false;
  readonly productionMigrationAuthorized: false;
  readonly liveShadowEnabled: false;
  readonly learningActivated: false;
}
export function assessCL06MMigrationReadiness(input: MigrationReadinessEvidence): MigrationReadinessAssessment {
  const ratifications = reviewSecurityRatification(input?.ratifications ?? []);
  const missingVerification: string[] = [];
  if (input?.ownerApprovalIndependentlyVerified !== true) missingVerification.push('INDEPENDENT_OWNER_APPROVAL');
  if (input?.exactParameterValuesReviewed !== true) missingVerification.push('EXACT_PARAMETER_VALUES');
  if (input?.schemaSecurityReviewCompleted !== true) missingVerification.push('SCHEMA_SECURITY_REVIEW');
  if (input?.disposablePostgresRlsAcceptanceCompleted !== true) missingVerification.push('DISPOSABLE_POSTGRES_RLS_ACCEPTANCE');
  return Object.freeze({
    status: 'BLOCKED',
    pendingDecisions: Object.freeze([...ratifications.pending]),
    missingVerification: Object.freeze(missingVerification),
    disposableMigrationAuthorized: false,
    productionMigrationAuthorized: false,
    liveShadowEnabled: false,
    learningActivated: false,
  });
}
