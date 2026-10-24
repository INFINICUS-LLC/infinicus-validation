/** CL-ACT-06V: business membership and ABA proof are separate, untrusted input snapshots.
 * Pure review only. Neither owners, members nor ABA-looking values grant runtime authority.
 */
export interface ScopedBusinessMembershipFact {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly workspaceMembershipStatus: string;
  readonly businessRelationshipEstablished: boolean;
  readonly businessStatus: string;
}
export interface ExplicitAbaShadowPermissionFact {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly assignmentId: string;
  readonly assignmentVersionId: string;
  readonly permissionCode: string;
  readonly status: string;
  readonly currentVersion: boolean;
  readonly unexpiredAtDatabaseTime: boolean;
  readonly delegated: boolean;
  readonly independentHumanApprover: boolean;
}
export interface ScopedPermissionReview {
  readonly eligibleForTrustedAdapterReview: boolean;
  readonly authorized: false;
  readonly auditWritePermitted: false;
  readonly learningActivated: false;
  readonly reasons: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export function reviewBusinessMembershipAndAbaPermission(
  membership: ScopedBusinessMembershipFact | null,
  grant: ExplicitAbaShadowPermissionFact | null,
): ScopedPermissionReview {
  const reasons: string[] = [];
  if (!membership || !grant) reasons.push('MISSING_FACT');
  else {
    if (![membership.tenantId,membership.workspaceId,membership.businessId,membership.userId,membership.membershipId,
      grant.tenantId,grant.workspaceId,grant.businessId,grant.operatorId,grant.approverId,
      grant.assignmentId,grant.assignmentVersionId].every(valid)) reasons.push('INVALID_ID');
    if (membership.tenantId !== grant.tenantId || membership.workspaceId !== grant.workspaceId ||
      membership.businessId !== grant.businessId || membership.userId !== grant.operatorId)
      reasons.push('BUSINESS_SCOPE_MISMATCH');
    if (membership.workspaceMembershipStatus !== 'active' || membership.businessRelationshipEstablished !== true ||
      membership.businessStatus !== 'active') reasons.push('BUSINESS_MEMBERSHIP_NOT_ESTABLISHED');
    if (grant.permissionCode !== 'cl:shadow:evaluate') reasons.push('EXPLICIT_PERMISSION_MISSING');
    if (grant.status !== 'active' || grant.currentVersion !== true ||
      grant.unexpiredAtDatabaseTime !== true) reasons.push('GRANT_REVOKED_STALE_OR_EXPIRED');
    if (grant.delegated !== false || grant.independentHumanApprover !== true ||
      grant.operatorId === grant.approverId) reasons.push('NONINDEPENDENT_APPROVAL');
  }
  return Object.freeze({
    eligibleForTrustedAdapterReview: reasons.length === 0,
    authorized: false, auditWritePermitted: false, learningActivated: false,
    reasons: Object.freeze(reasons),
  });
}
