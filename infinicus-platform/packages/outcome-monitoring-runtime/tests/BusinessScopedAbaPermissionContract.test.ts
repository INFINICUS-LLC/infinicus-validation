import { describe, it, expect } from 'vitest';
import { reviewBusinessMembershipAndAbaPermission, type ScopedBusinessMembershipFact, type ExplicitAbaShadowPermissionFact } from '../src/BusinessScopedAbaPermissionContract.js';
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const m = (): ScopedBusinessMembershipFact => ({tenantId:id(1),workspaceId:id(2),businessId:id(3),userId:id(4),membershipId:id(5),workspaceMembershipStatus:'active',businessRelationshipEstablished:true,businessStatus:'active'});
const a = (): ExplicitAbaShadowPermissionFact => ({tenantId:id(1),workspaceId:id(2),businessId:id(3),operatorId:id(4),approverId:id(6),assignmentId:id(7),assignmentVersionId:id(8),permissionCode:'cl:shadow:evaluate',status:'active',currentVersion:true,unexpiredAtDatabaseTime:true,delegated:false,independentHumanApprover:true});
describe('CL-ACT-06V membership versus explicit ABA authority', () => {
  it('never authorizes from even structurally complete caller-supplied evidence', () => {
    const r=reviewBusinessMembershipAndAbaPermission(m(),a());
    expect(r.eligibleForTrustedAdapterReview).toBe(true);
    expect(r.authorized).toBe(false);
    expect(r.auditWritePermitted).toBe(false);
    expect(r.learningActivated).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it('refuses absent membership or ABA grant', () => {
    expect(reviewBusinessMembershipAndAbaPermission(null,a()).reasons).toContain('MISSING_FACT');
    expect(reviewBusinessMembershipAndAbaPermission(m(),null).reasons).toContain('MISSING_FACT');
  });
  it('refuses scope substitution, inactive membership, and missing business relationship', () => {
    const cases: Array<[ScopedBusinessMembershipFact,ExplicitAbaShadowPermissionFact,string]> = [
      [{...m(),businessId:id(9)},a(),'BUSINESS_SCOPE_MISMATCH'],
      [{...m(),userId:id(9)},a(),'BUSINESS_SCOPE_MISMATCH'],
      [{...m(),workspaceMembershipStatus:'suspended'},a(),'BUSINESS_MEMBERSHIP_NOT_ESTABLISHED'],
      [{...m(),businessRelationshipEstablished:false},a(),'BUSINESS_MEMBERSHIP_NOT_ESTABLISHED'],
      [{...m(),businessStatus:'closed'},a(),'BUSINESS_MEMBERSHIP_NOT_ESTABLISHED'],
      [m(),{...a(),permissionCode:'bo:admin'},'EXPLICIT_PERMISSION_MISSING'],
      [m(),{...a(),status:'revoked'},'GRANT_REVOKED_STALE_OR_EXPIRED'],
      [m(),{...a(),currentVersion:false},'GRANT_REVOKED_STALE_OR_EXPIRED'],
      [m(),{...a(),unexpiredAtDatabaseTime:false},'GRANT_REVOKED_STALE_OR_EXPIRED'],
      [m(),{...a(),delegated:true},'NONINDEPENDENT_APPROVAL'],
      [m(),{...a(),approverId:id(4)},'NONINDEPENDENT_APPROVAL'],
      [m(),{...a(),independentHumanApprover:false},'NONINDEPENDENT_APPROVAL'],
    ];
    for(const [membership,grant,reason] of cases) {
      const r=reviewBusinessMembershipAndAbaPermission(membership,grant);
      expect(r.reasons).toContain(reason);
      expect(r.eligibleForTrustedAdapterReview).toBe(false);
      expect(r.authorized).toBe(false);
    }
  });
});
