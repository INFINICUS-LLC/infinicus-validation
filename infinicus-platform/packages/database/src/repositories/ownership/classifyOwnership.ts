import type { OwnershipProofRef } from '../approved_action/authorityProvenance.js';

/**
 * STRICT business-ownership proof (authorised rule D1).
 *
 * A user is a PROVEN owner of a specific business only when server-side records
 * prove all of: the business, the user, an ACTIVE owner membership, and that the
 * ownership relationship belongs to THAT business. The accepted relationships are:
 *   1. the onboarding record that created the business names the owner's
 *      membership, that membership is active, holds the owner role, and belongs
 *      to the user who initiated the onboarding; or
 *   2. an active membership holds the owner role explicitly scoped to the business.
 *
 * NEVER used as proof: `created_by` alone, tenant-wide owner status alone,
 * browser-supplied ids, inferred ownership, name or email matching. Tenant-wide
 * owners without a business-specific link are reported as candidates and are
 * NOT auto-granted.
 *
 * This module is pure (no I/O) so the same rule runs at onboarding time, at
 * decision time and in the backfill dry-run.
 */

export const CANDIDATE_LABEL = 'CANDIDATE — NOT AUTO-GRANTED';

export type OwnershipClassification =
  | 'PROVEN'
  | 'ALREADY_ASSIGNED'
  | 'AMBIGUOUS'
  | 'UNPROVEN'
  | 'INVALID_INACTIVE';

export interface MembershipFact {
  membershipId: string;
  userId: string;
  status: string;
}

export interface OwnershipEvidence {
  tenantId: string;
  workspaceId: string;
  businessId: string;
  /** Null when the business row is not visible. */
  business: { status: string; deleted: boolean } | null;
  onboardingLink: { onboardingId: string; membershipId: string | null; initiatedBy: string } | null;
  /** The membership named by the onboarding link, with whether it holds the owner role. */
  linkedMembership: (MembershipFact & { hasOwnerRole: boolean }) | null;
  /** Memberships holding the owner role explicitly scoped to this business. */
  explicitOwners: MembershipFact[];
  /** Memberships holding the owner role tenant-wide (no business link). Candidates only. */
  tenantWideOwners: MembershipFact[];
  /** The assignment holding `business-owner-approver` for this business, in any status. */
  existingAssignment: { assignmentId: string; userId: string; status: string } | null;
}

export interface ProvenOwner {
  userId: string;
  proof: OwnershipProofRef;
}

export interface CandidateOwner {
  userId: string;
  membershipId: string;
  label: typeof CANDIDATE_LABEL;
}

export interface OwnershipVerdict {
  classification: OwnershipClassification;
  reason: string;
  /** True only for PROVEN: exactly one proven owner and no existing assignment. */
  eligibleForGrant: boolean;
  provenOwners: ProvenOwner[];
  candidates: CandidateOwner[];
  existingAssignment: OwnershipEvidence['existingAssignment'];
  /** For ALREADY_ASSIGNED: whether the holder is still a proven owner. */
  holderStillProvenOwner: boolean | null;
  notes: string[];
}

const INACTIVE_BUSINESS_STATUSES = new Set(['closed', 'archived', 'suspended']);

/** The distinct, currently proven owners of the business, and any broken link detail. */
export function provenOwnersOf(evidence: OwnershipEvidence): { owners: ProvenOwner[]; problems: string[] } {
  const owners = new Map<string, ProvenOwner>();
  const problems: string[] = [];

  const link = evidence.onboardingLink;
  if (link && link.membershipId) {
    const m = evidence.linkedMembership;
    if (!m) problems.push('the onboarding record names a membership that cannot be found');
    else if (m.status !== 'active') problems.push(`the onboarding owner membership is ${m.status}, not active`);
    else if (!m.hasOwnerRole) problems.push('the onboarding membership no longer holds the owner role');
    else if (m.userId !== link.initiatedBy) problems.push('the onboarding membership belongs to a different user than the one who initiated it');
    else owners.set(m.userId, { userId: m.userId, proof: { kind: 'onboarding-membership', membershipId: m.membershipId, onboardingId: link.onboardingId } });
  }

  for (const explicit of evidence.explicitOwners) {
    if (explicit.status !== 'active') {
      problems.push(`a business-scoped owner membership is ${explicit.status}, not active`);
      continue;
    }
    if (!owners.has(explicit.userId)) {
      owners.set(explicit.userId, { userId: explicit.userId, proof: { kind: 'explicit-owner-role', membershipId: explicit.membershipId, onboardingId: null } });
    }
  }
  return { owners: [...owners.values()], problems };
}

export function classifyOwnership(evidence: OwnershipEvidence): OwnershipVerdict {
  const { owners, problems } = provenOwnersOf(evidence);
  const proven = new Set(owners.map((o) => o.userId));
  const candidates: CandidateOwner[] = evidence.tenantWideOwners
    .filter((m) => m.status === 'active' && !proven.has(m.userId))
    .map((m) => ({ userId: m.userId, membershipId: m.membershipId, label: CANDIDATE_LABEL }));
  const base = { provenOwners: owners, candidates, existingAssignment: evidence.existingAssignment, notes: [...problems] };

  if (!evidence.business || evidence.business.deleted || INACTIVE_BUSINESS_STATUSES.has(evidence.business.status)) {
    return { ...base, classification: 'INVALID_INACTIVE', eligibleForGrant: false, holderStillProvenOwner: null,
      reason: !evidence.business ? 'the business is not visible' : evidence.business.deleted ? 'the business is deleted' : `the business is ${evidence.business.status}` };
  }

  if (evidence.existingAssignment) {
    const holderStillProvenOwner = proven.has(evidence.existingAssignment.userId);
    const notes = [...base.notes];
    if (evidence.existingAssignment.status !== 'active') notes.push(`the existing assignment is ${evidence.existingAssignment.status}; automatic grant is disabled and an explicit aba:admin decision is required`);
    else if (!holderStillProvenOwner) notes.push('the assignment holder is not a currently proven owner: review for revocation (never revoked automatically)');
    return { ...base, notes, classification: 'ALREADY_ASSIGNED', eligibleForGrant: false, holderStillProvenOwner,
      reason: `an assignment already holds business-owner-approver (${evidence.existingAssignment.status})` };
  }

  if (owners.length === 1) {
    return { ...base, classification: 'PROVEN', eligibleForGrant: true, holderStillProvenOwner: null,
      reason: owners[0].proof.kind === 'onboarding-membership' ? 'the onboarding record proves this business and its active owner membership' : 'an active membership holds the owner role scoped to this business' };
  }
  if (owners.length > 1) {
    return { ...base, classification: 'AMBIGUOUS', eligibleForGrant: false, holderStillProvenOwner: null,
      reason: `${owners.length} valid owners; business-owner-approver has one holder, so nobody is granted automatically (explicit aba:admin decision required)` };
  }

  // No proven owner.
  const linkBroken = problems.length > 0;
  if (linkBroken) {
    return { ...base, classification: 'INVALID_INACTIVE', eligibleForGrant: false, holderStillProvenOwner: null,
      reason: 'an ownership relationship exists but the owner or membership is not active or consistent' };
  }
  return { ...base, classification: 'UNPROVEN', eligibleForGrant: false, holderStillProvenOwner: null,
    reason: candidates.length > 0
      ? 'no business-specific ownership link; tenant-wide owners are candidates only and are not auto-granted'
      : 'no ownership evidence for this business' };
}
