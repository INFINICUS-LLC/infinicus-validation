import { describe, expect, it } from 'vitest';
import { reviewShadowBusinessScope, type CanonicalShadowPrincipal, type AbaShadowPermissionEvidence } from '../src/CanonicalShadowBusinessScope.js';
const ids = Array.from({length: 8}, (_, n) => `${String(n+1).repeat(8)}-${String(n+1).repeat(4)}-4${String(n+1).repeat(3)}-8${String(n+1).repeat(3)}-${String(n+1).repeat(12)}`);
const principal = (): CanonicalShadowPrincipal => ({
  tenantId: ids[0], workspaceId: ids[1], businessId: ids[2], operatorId: ids[3],
  sessionId: ids[4], sessionAuthenticated: true, membershipVerified: true,
});
const evidence = (): AbaShadowPermissionEvidence => ({
  tenantId: ids[0], workspaceId: ids[1], businessId: ids[2], operatorId: ids[3],
  assignmentId: ids[5], assignmentVersionId: ids[6], approverId: ids[7],
  permissionCode: 'cl:shadow:evaluate', permissionExplicit: true,
  assignmentStatus: 'active', versionCurrent: true, delegationUsed: false,
  approverHumanVerified: true, unexpiredAtDbTime: true,
});
describe('CL-ACT-06Q business-scope contract', () => {
  it('allows structural integration review without claiming runtime authorization', () => {
    const result = reviewShadowBusinessScope(principal(), evidence());
    expect(result).toEqual({ acceptedForIntegrationReview: true, operatorAuthorized: false,
      auditWritePermitted: false, learningActivated: false, reasons: [] });
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });
  it('rejects cross-business, forged session, inherited privilege, stale authority and self approval', () => {
    const cases: Array<[CanonicalShadowPrincipal, AbaShadowPermissionEvidence, string]> = [
      [{ ...principal(), businessId: ids[7] }, evidence(), 'SCOPE_MISMATCH'],
      [{ ...principal(), sessionAuthenticated: false }, evidence(), 'UNVERIFIED_SESSION_OR_MEMBERSHIP'],
      [principal(), { ...evidence(), permissionCode: 'bo:admin' }, 'PERMISSION_NOT_EXPLICIT'],
      [principal(), { ...evidence(), permissionExplicit: false }, 'PERMISSION_NOT_EXPLICIT'],
      [principal(), { ...evidence(), assignmentStatus: 'revoked' }, 'AUTHORITY_INACTIVE_OR_STALE'],
      [principal(), { ...evidence(), versionCurrent: false }, 'AUTHORITY_INACTIVE_OR_STALE'],
      [principal(), { ...evidence(), delegationUsed: true }, 'APPROVAL_NOT_INDEPENDENT'],
      [principal(), { ...evidence(), approverId: ids[3] }, 'APPROVAL_NOT_INDEPENDENT'],
    ];
    for (const [p,e,reason] of cases) {
      const result = reviewShadowBusinessScope(p,e);
      expect(result.acceptedForIntegrationReview).toBe(false);
      expect(result.reasons).toContain(reason);
      expect(result.operatorAuthorized).toBe(false);
      expect(result.auditWritePermitted).toBe(false);
    }
  });
  it('refuses malformed and missing authority evidence', () => {
    expect(reviewShadowBusinessScope(principal(), null as never).reasons).toContain('MISSING_EVIDENCE');
    expect(reviewShadowBusinessScope({ ...principal(), sessionId: 'not-uuid' }, evidence()).reasons).toContain('INVALID_IDENTITY');
  });
});
