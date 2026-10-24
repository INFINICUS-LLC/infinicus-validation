/**
 * CL-ACT-06G security acceptance contract: auditable requirements, no grants.
 * A checklist is NOT equivalent to migration approval or a verified DB run.
 */
import { CL_SHADOW_UNRESOLVED_DECISIONS } from './ApprovedShadowPolicy.js';

export const SHADOW_AUDIT_SECURITY_CONTROLS = Object.freeze([
  'CANONICAL_AUTHENTICATED_OPERATOR',
  'EXPLICIT_SCOPED_PERMISSION',
  'CURRENT_ASSIGNMENT_VERSION',
  'INDEPENDENT_HUMAN_APPROVER',
  'DATABASE_TIME_REVOCATION',
  'KILL_SWITCH_FIRST',
  'COMPOSITE_TENANT_WORKSPACE_BUSINESS_SCOPE',
  'FORCED_RLS_WITH_LEAST_PRIVILEGE',
  'APPEND_ONLY_UPDATE_DELETE_TRUNCATE_DENIED',
  'ATOMIC_AUDIT_AND_CONTROL_TRANSITION',
  'SCOPED_IDEMPOTENCY_CONCURRENCY',
  'VERSIONED_CANONICAL_DIGEST',
  'INDEPENDENT_AUDIT_ANCHOR',
  'RETENTION_AND_LEGAL_DELETION',
  'NO_LEARNING_OR_OPERATIONAL_MUTATION',
] as const);
export type ShadowAuditSecurityControl = (typeof SHADOW_AUDIT_SECURITY_CONTROLS)[number];

export type ShadowAuditSecurityEvidence = Readonly<{
  control: ShadowAuditSecurityControl;
  verified: boolean;
  disposableDatabase: boolean;
  evidenceReference: string;
}>;

export type ShadowAuditSecurityDecision = Readonly<{
  acceptanceReady: false;
  migrationAuthorized: false;
  productionEnabled: false;
  learningActivated: false;
  missingOrUnapproved: readonly string[];
}>;

/** Reports gaps without converting caller-supplied claims into an authorization. */
export function assessShadowAuditSecurityEvidence(
  evidence: readonly ShadowAuditSecurityEvidence[],
): ShadowAuditSecurityDecision {
  const supported = new Set<string>();
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (!item || !SHADOW_AUDIT_SECURITY_CONTROLS.includes(item.control) ||
          item.verified !== true || item.disposableDatabase !== true ||
          typeof item.evidenceReference !== 'string' || item.evidenceReference.trim().length === 0) continue;
      supported.add(item.control);
    }
  }
  const missingOrUnapproved = [
    ...SHADOW_AUDIT_SECURITY_CONTROLS.filter(control => !supported.has(control)),
    ...CL_SHADOW_UNRESOLVED_DECISIONS,
  ];
  return Object.freeze({
    acceptanceReady: false, migrationAuthorized: false,
    productionEnabled: false, learningActivated: false,
    missingOrUnapproved: Object.freeze(missingOrUnapproved),
  });
}
