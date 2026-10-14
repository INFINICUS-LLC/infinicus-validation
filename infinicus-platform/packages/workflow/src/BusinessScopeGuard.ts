import {
  BusinessRepository, BusinessNotFoundError, MembershipRepository,
  type TenantContext, type Business,
} from '@infinicus/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when a proposed approver grantee cannot receive approval authority: unknown user, no membership in the
 * authoritative workspace, a membership that is not ACTIVE, or a user of another scope. One error and one message for
 * every reason, so a caller cannot probe which users exist elsewhere. Mapped to HTTP 400 in apps/api/src/errors.ts.
 */
export class ApproverGranteeNotEligibleError extends Error {
  constructor() {
    super('approver grantee is not an active member of this workspace');
    this.name = 'ApproverGranteeNotEligibleError';
  }
}

/**
 * The single authoritative business-scope mechanism for the workflow services (AC-3 J-1, J-6).
 *
 * A business id from a path or body is a TARGET, never authority. It is resolved through the authoritative business
 * repository under the authenticated principal's tenant context (row-level security) and must additionally belong to
 * that exact tenant and workspace. A foreign business and an unknown business raise the identical `BusinessNotFoundError`
 * (HTTP 404), so existence elsewhere is not observable. It performs no write, so a refused attempt leaves nothing behind.
 * Every business-scoped entry point calls it BEFORE any read-for-write, write, assignment, decision, outcome or audit row.
 */
export class BusinessScopeGuard {
  constructor(
    private readonly businesses: BusinessRepository = new BusinessRepository(),
    private readonly memberships: MembershipRepository = new MembershipRepository(),
  ) {}

  /** Resolves the business inside the caller's tenant and workspace or throws the uniform not-found. */
  async assertBusinessInScope(ctx: TenantContext, businessId: string): Promise<Business> {
    if (!UUID.test(businessId)) throw new BusinessNotFoundError('Business', businessId);
    const business = await this.businesses.getById(ctx, businessId);
    if (business.tenantId !== ctx.tenantId || business.workspaceId !== ctx.workspaceId) {
      throw new BusinessNotFoundError('Business', businessId);
    }
    return business;
  }

  /** The proposed grantee is resolved server-side and must hold an ACTIVE membership in the caller's workspace. */
  async assertActiveWorkspaceMember(ctx: TenantContext, userId: string): Promise<void> {
    if (!UUID.test(userId)) throw new ApproverGranteeNotEligibleError();
    let membership;
    try {
      membership = await this.memberships.getByUserAndWorkspace(ctx, userId);
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFoundError') throw new ApproverGranteeNotEligibleError();
      throw err;
    }
    if (membership.status !== 'active' || membership.tenantId !== ctx.tenantId || membership.workspaceId !== ctx.workspaceId) {
      throw new ApproverGranteeNotEligibleError();
    }
  }
}
