import {
  ApproverAuthorityRepository, OwnershipEvidenceRepository, classifyOwnership, OWNER_APPROVER_ASSIGNMENT_CODE,
  type OwnershipClassification, type TenantContext,
} from '@infinicus/database';

/**
 * Owner approval-authority bootstrap (V-01, authorised D1–D3).
 *
 * Issues the `business-owner-approver` assignment for a business ONLY when
 * server-side records prove who owns THAT business (strict rule, see
 * classifyOwnership in @infinicus/database). Nothing here reads a browser
 * field: the grantee is the proven owner found in the database, and it must
 * equal the authenticated principal on the request (`ctx.userId`), so authority
 * is never self-issued from a claim and never handed to someone else.
 *
 * Idempotent, business-scoped, and written with an append-only provenance
 * entry. It never overwrites, re-grants after a revocation, or picks among
 * several owners. It performs no ABA -> BO wiring.
 */

export type OwnerBootstrapOutcome =
  | 'granted'
  | 'already-assigned'
  | 'previously-revoked'
  | 'held-by-other'
  | 'not-granted';

export interface OwnerBootstrapResult {
  outcome: OwnerBootstrapOutcome;
  classification: OwnershipClassification;
  reason: string;
  assignmentId: string | null;
}

export const OWNER_BOOTSTRAP_AUTHORITY = 'owner-bootstrap:onboarding';

export class OwnerApproverAuthorityService {
  constructor(
    private readonly authority: ApproverAuthorityRepository = new ApproverAuthorityRepository(),
    private readonly evidence: OwnershipEvidenceRepository = new OwnershipEvidenceRepository()
  ) {}

  async bootstrapForBusiness(
    ctx: TenantContext,
    businessId: string,
    opts: { onboardingId?: string | null; correlationId?: string | null } = {}
  ): Promise<OwnerBootstrapResult> {
    const evidence = await this.evidence.loadForBusiness(ctx, businessId);
    const verdict = classifyOwnership(evidence);

    if (verdict.classification === 'ALREADY_ASSIGNED' && verdict.existingAssignment) {
      const existing = verdict.existingAssignment;
      const outcome: OwnerBootstrapOutcome =
        existing.status === 'revoked' ? 'previously-revoked'
          : existing.status === 'active' && existing.userId !== ctx.userId ? 'held-by-other'
            : existing.status === 'active' ? 'already-assigned' : 'not-granted';
      return { outcome, classification: verdict.classification, reason: verdict.reason, assignmentId: existing.assignmentId };
    }
    if (!verdict.eligibleForGrant) {
      return { outcome: 'not-granted', classification: verdict.classification, reason: verdict.reason, assignmentId: null };
    }

    const owner = verdict.provenOwners[0];
    if (owner.userId !== ctx.userId) {
      return {
        outcome: 'not-granted', classification: verdict.classification, assignmentId: null,
        reason: 'the authenticated principal is not the proven owner of this business; no authority was issued',
      };
    }

    const { assignment, created } = await this.authority.grantActiveAssignment(ctx, {
      businessId,
      userId: owner.userId,
      assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE,
      roleCode: 'business-owner',
      provenance: {
        action: 'grant',
        source: 'onboarding',
        businessId,
        assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE,
        granteeUserId: owner.userId,
        state: 'active',
        actor: { type: 'system', id: null, authority: OWNER_BOOTSTRAP_AUTHORITY },
        at: new Date().toISOString(),
        correlationId: opts.correlationId ?? null,
        proof: owner.proof,
        reason: null,
      },
    });
    return {
      outcome: created ? 'granted' : 'already-assigned',
      classification: verdict.classification,
      reason: verdict.reason,
      assignmentId: assignment.id,
    };
  }
}
