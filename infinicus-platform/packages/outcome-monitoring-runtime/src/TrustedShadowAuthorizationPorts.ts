/**
 * CL-ACT-06S: trusted-source adapter *interfaces*, not an implementation.
 * Only identity and ABA owners may implement these ports and attest provenance.
 * Never call caller-supplied records authorized; no database or network access.
 */
export interface VerifiedShadowSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly authenticatedBy: 'canonical_identity';
  readonly active: true;
}
export interface VerifiedShadowBusinessMembership {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly verifiedBy: 'canonical_business_membership';
  readonly active: true;
}
export interface VerifiedAbaShadowGrant {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly operatorId: string;
  readonly assignmentId: string;
  readonly assignmentVersionId: string;
  readonly permissionCode: 'cl:shadow:evaluate';
  readonly grantedBy: 'canonical_aba';
  readonly active: true;
  readonly currentVersion: true;
  readonly unexpiredAtDatabaseTime: true;
  readonly revoked: false;
  readonly delegated: false;
  readonly approverId: string;
  readonly humanApproverVerified: true;
}
export interface ShadowAuthorizationReadPorts {
  /** Input is an opaque server-held session handle, never claimed user identity. */
  readonly authenticateSession: (sessionHandle: string) => Promise<VerifiedShadowSession | null>;
  readonly verifyBusinessMembership: (session: VerifiedShadowSession, businessId: string) => Promise<VerifiedShadowBusinessMembership | null>;
  /** Must consult the current ABA grant and database clock; no stale cached results. */
  readonly verifyCurrentAbaGrant: (session: VerifiedShadowSession, businessId: string) => Promise<VerifiedAbaShadowGrant | null>;
}
export interface ShadowAdapterPreflightResult {
  readonly structurallyConsistent: boolean;
  readonly operationallyAuthorized: false;
  readonly auditWritePermitted: false;
  readonly learningActivated: false;
  readonly reasons: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/** Structural check over untrusted objects. It is never an authorization decision. */
export function assessShadowAdapterEvidence(
  session: VerifiedShadowSession | null,
  membership: VerifiedShadowBusinessMembership | null,
  grant: VerifiedAbaShadowGrant | null,
): ShadowAdapterPreflightResult {
  const reasons: string[] = [];
  if (!session || !membership || !grant) reasons.push('MISSING_CANONICAL_EVIDENCE');
  else {
    if (![session.userId,session.sessionId,session.tenantId,session.workspaceId,
      membership.tenantId,membership.workspaceId,membership.businessId,membership.userId,
      grant.tenantId,grant.workspaceId,grant.businessId,grant.operatorId,
      grant.assignmentId,grant.assignmentVersionId,grant.approverId].every(validId))
      reasons.push('INVALID_IDENTITY');
    if (session.tenantId !== membership.tenantId || session.workspaceId !== membership.workspaceId ||
        session.userId !== membership.userId || session.userId !== grant.operatorId ||
        membership.tenantId !== grant.tenantId || membership.workspaceId !== grant.workspaceId ||
        membership.businessId !== grant.businessId) reasons.push('SCOPE_MISMATCH');
    if (session.authenticatedBy !== 'canonical_identity' || session.active !== true ||
        membership.verifiedBy !== 'canonical_business_membership' || membership.active !== true)
      reasons.push('UNVERIFIED_IDENTITY_OR_MEMBERSHIP');
    if (grant.grantedBy !== 'canonical_aba' || grant.permissionCode !== 'cl:shadow:evaluate')
      reasons.push('NONCANONICAL_GRANT');
    if (grant.active !== true || grant.currentVersion !== true ||
        grant.unexpiredAtDatabaseTime !== true || grant.revoked !== false)
      reasons.push('INACTIVE_OR_STALE_GRANT');
    if (grant.delegated !== false || grant.humanApproverVerified !== true ||
        grant.approverId === session.userId) reasons.push('UNSAFE_APPROVAL');
  }
  return Object.freeze({
    structurallyConsistent: reasons.length === 0,
    operationallyAuthorized: false, auditWritePermitted: false, learningActivated: false,
    reasons: Object.freeze(reasons),
  });
}
