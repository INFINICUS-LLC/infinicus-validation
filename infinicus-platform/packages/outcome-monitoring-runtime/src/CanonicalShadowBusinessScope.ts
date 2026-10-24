/**
 * CL-ACT-06Q: non-authorizing contracts for a future trusted composition.
 * Types alone do not establish provenance. Never create this snapshot from
 * request-body fields or use a valid assessment as an operational permission.
 */
export interface CanonicalBusinessScope {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
}
export interface CanonicalShadowPrincipal extends CanonicalBusinessScope {
  readonly operatorId: string;
  readonly sessionId: string;
  readonly sessionAuthenticated: boolean;
  readonly membershipVerified: boolean;
}
export interface AbaShadowPermissionEvidence extends CanonicalBusinessScope {
  readonly operatorId: string;
  readonly assignmentId: string;
  readonly assignmentVersionId: string;
  readonly permissionCode: string;
  readonly assignmentStatus: 'active' | 'revoked' | 'draft';
  readonly versionCurrent: boolean;
  readonly permissionExplicit: boolean;
  readonly delegationUsed: boolean;
  readonly approverId: string;
  readonly approverHumanVerified: boolean;
  readonly unexpiredAtDbTime: boolean;
}
export interface ShadowBusinessScopeReview {
  readonly acceptedForIntegrationReview: boolean;
  readonly operatorAuthorized: false;
  readonly auditWritePermitted: false;
  readonly learningActivated: false;
  readonly reasons: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
/**
 * Structural/claimed-value sanity check only. A caller can forge booleans.
 * The trusted owner must fetch current session, membership and ABA evidence
 * transactionally, then enforce database RLS before allowing operations.
 */
export function reviewShadowBusinessScope(
  principal: CanonicalShadowPrincipal,
  evidence: AbaShadowPermissionEvidence,
): ShadowBusinessScopeReview {
  const reasons: string[] = [];
  if (!principal || !evidence) reasons.push('MISSING_EVIDENCE');
  else {
    const fields = [principal.tenantId, principal.workspaceId, principal.businessId, principal.operatorId,
      principal.sessionId, evidence.tenantId, evidence.workspaceId, evidence.businessId, evidence.operatorId,
      evidence.assignmentId, evidence.assignmentVersionId, evidence.approverId];
    if (!fields.every(isUuid)) reasons.push('INVALID_IDENTITY');
    if (principal.tenantId !== evidence.tenantId ||
      principal.workspaceId !== evidence.workspaceId || principal.businessId !== evidence.businessId ||
      principal.operatorId !== evidence.operatorId) reasons.push('SCOPE_MISMATCH');
    if (principal.sessionAuthenticated !== true || principal.membershipVerified !== true)
      reasons.push('UNVERIFIED_SESSION_OR_MEMBERSHIP');
    if (evidence.permissionCode !== 'cl:shadow:evaluate' || evidence.permissionExplicit !== true)
      reasons.push('PERMISSION_NOT_EXPLICIT');
    if (evidence.assignmentStatus !== 'active' || evidence.versionCurrent !== true ||
      evidence.unexpiredAtDbTime !== true) reasons.push('AUTHORITY_INACTIVE_OR_STALE');
    if (evidence.delegationUsed !== false || evidence.approverHumanVerified !== true ||
      evidence.approverId === principal.operatorId) reasons.push('APPROVAL_NOT_INDEPENDENT');
  }
  return Object.freeze({
    acceptedForIntegrationReview: reasons.length === 0,
    operatorAuthorized: false, auditWritePermitted: false, learningActivated: false,
    reasons: Object.freeze(reasons),
  });
}
