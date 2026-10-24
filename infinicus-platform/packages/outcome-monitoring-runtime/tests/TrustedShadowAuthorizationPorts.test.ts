import { describe, expect, it } from 'vitest';
import { assessShadowAdapterEvidence, type VerifiedShadowSession, type VerifiedShadowBusinessMembership, type VerifiedAbaShadowGrant } from '../src/TrustedShadowAuthorizationPorts.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
];
const session = (): VerifiedShadowSession => ({
  userId: ids[3], sessionId: ids[4], tenantId: ids[0], workspaceId: ids[1],
  authenticatedBy: 'canonical_identity', active: true,
});
const membership = (): VerifiedShadowBusinessMembership => ({
  tenantId: ids[0], workspaceId: ids[1], businessId: ids[2], userId: ids[3],
  verifiedBy: 'canonical_business_membership', active: true,
});
const grant = (): VerifiedAbaShadowGrant => ({
  tenantId: ids[0], workspaceId: ids[1], businessId: ids[2], operatorId: ids[3],
  assignmentId: ids[5], assignmentVersionId: ids[6], permissionCode: 'cl:shadow:evaluate',
  grantedBy: 'canonical_aba', active: true, currentVersion: true,
  unexpiredAtDatabaseTime: true, revoked: false, delegated: false,
  approverId: ids[4], humanApproverVerified: true,
});

describe('CL-ACT-06S trusted authorization adapter evidence', () => {
  it('allows structural review only, never operational authorization', () => {
    const result = assessShadowAdapterEvidence(session(), membership(), grant());
    expect(result).toEqual({ structurallyConsistent: true, operationallyAuthorized: false,
      auditWritePermitted: false, learningActivated: false, reasons: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it('denies absent sources, scope mismatch, impersonation and forged canonical origin', () => {
    const cases: Array<[VerifiedShadowSession | null, VerifiedShadowBusinessMembership | null, VerifiedAbaShadowGrant | null, string]> = [
      [null, membership(), grant(), 'MISSING_CANONICAL_EVIDENCE'],
      [session(), null, grant(), 'MISSING_CANONICAL_EVIDENCE'],
      [session(), membership(), null, 'MISSING_CANONICAL_EVIDENCE'],
      [session(), { ...membership(), tenantId: ids[6] }, grant(), 'SCOPE_MISMATCH'],
      [session(), membership(), { ...grant(), businessId: ids[6] }, 'SCOPE_MISMATCH'],
      [session(), { ...membership(), userId: ids[6] }, grant(), 'SCOPE_MISMATCH'],
      [{ ...session(), authenticatedBy: 'caller' as never }, membership(), grant(), 'UNVERIFIED_IDENTITY_OR_MEMBERSHIP'],
      [session(), membership(), { ...grant(), grantedBy: 'caller' as never }, 'NONCANONICAL_GRANT'],
      [session(), membership(), { ...grant(), permissionCode: 'bo:admin' as never }, 'NONCANONICAL_GRANT'],
      [{ ...session(), sessionId: 'invalid' }, membership(), grant(), 'INVALID_IDENTITY'],
    ];
    for (const [s,m,g,reason] of cases) {
      const result = assessShadowAdapterEvidence(s,m,g);
      expect(result.structurallyConsistent).toBe(false);
      expect(result.reasons).toContain(reason);
      expect(result.operationallyAuthorized).toBe(false);
      expect(result.auditWritePermitted).toBe(false);
    }
  });

  it('rejects revocation, stale versions, delegation, self approval and nonhuman approval', () => {
    const changes: Array<[Partial<VerifiedAbaShadowGrant>, string]> = [
      [{ active: false as never }, 'INACTIVE_OR_STALE_GRANT'],
      [{ currentVersion: false as never }, 'INACTIVE_OR_STALE_GRANT'],
      [{ unexpiredAtDatabaseTime: false as never }, 'INACTIVE_OR_STALE_GRANT'],
      [{ revoked: true as never }, 'INACTIVE_OR_STALE_GRANT'],
      [{ delegated: true as never }, 'UNSAFE_APPROVAL'],
      [{ approverId: ids[3] }, 'UNSAFE_APPROVAL'],
      [{ humanApproverVerified: false as never }, 'UNSAFE_APPROVAL'],
    ];
    for (const [change,reason] of changes) {
      const result = assessShadowAdapterEvidence(session(), membership(), { ...grant(), ...change });
      expect(result.structurallyConsistent).toBe(false);
      expect(result.reasons).toContain(reason);
      expect(result.learningActivated).toBe(false);
    }
  });
});
