/**
 * Append-only provenance for approver authority (V-01 / owner bootstrap).
 *
 * Every grant and every revocation of an approver assignment writes one entry
 * into the existing append-only table `approval_authority_scopes`
 * (`scope_type = 'provenance'`), so no migration is needed. Entries are built
 * by server code only. They never carry secrets, and never carry identity
 * claims that came from a browser: the grantee and actor are server-derived
 * user ids, and the ownership proof is a reference to server-side records.
 *
 * Canonical record (owner ruling D3, closed in P0-4): `approval_authority_scopes` is the canonical append-only
 * audit/provenance record for approver-authority grants and revocations. These events are deliberately NOT duplicated
 * into `approval_audit_events`, which is canonical for approval decision, refusal and expiry audit.
 */

/** The one assignment code the owner bootstrap issues. Unique per business, so it has exactly one holder. */
export const OWNER_APPROVER_ASSIGNMENT_CODE = 'business-owner-approver';

export const PROVENANCE_SCOPE_TYPE = 'provenance';

export type AuthoritySource = 'onboarding' | 'manual-admin' | 'backfill';
export type AuthorityAction = 'grant' | 'revoke';

/** Reference to the server-side record that proved business ownership. */
export interface OwnershipProofRef {
  kind: 'onboarding-membership' | 'explicit-owner-role';
  membershipId: string;
  onboardingId: string | null;
}

export interface AuthorityProvenanceEntry {
  action: AuthorityAction;
  source: AuthoritySource;
  businessId: string;
  assignmentId: string;
  assignmentCode: string;
  granteeUserId: string;
  /** State of the assignment AFTER this entry. */
  state: 'active' | 'revoked';
  actor: {
    type: 'system' | 'user';
    /** User id for `user`; null for `system`. */
    id: string | null;
    /** The authority under which the actor acted, e.g. `owner-bootstrap:onboarding` or `aba:admin`. */
    authority: string;
  };
  at: string;
  correlationId: string | null;
  /** Present for onboarding/backfill grants: the ownership evidence. Absent for manual-admin grants. */
  proof: OwnershipProofRef | null;
  /** Revocations only. */
  reason: string | null;
}

export const MAX_REVOCATION_REASON_LENGTH = 1000;

export function normalizeRevocationReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error('a revocation reason is required');
  return trimmed.slice(0, MAX_REVOCATION_REASON_LENGTH);
}
