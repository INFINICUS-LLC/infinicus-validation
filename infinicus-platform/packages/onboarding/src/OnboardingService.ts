import {
  TenantRepository, WorkspaceRepository, BusinessRepository, SettingsRepository,
  OnboardingProgressRepository, MembershipRepository, InvitationRepository,
  OnboardingNotInitiatorError,
  type TenantContext, type Tenant, type Workspace, type Business, type Membership,
  type OnboardingProgress, type Setting, type Invitation,
} from '@infinicus/database';
import { AuthorizationService, type CreatedInvitation } from '@infinicus/authorization';
import { OwnerApproverAuthorityService } from './OwnerApproverAuthorityService.js';

const DEFAULT_TENANT_SETTINGS: Record<string, unknown> = {
  theme: 'system',
  notificationsEnabled: true,
  defaultLocale: 'en-US',
};

export interface BeginOnboardingInput {
  tenantName: string;
  tenantSlug: string;
  workspaceName: string;
  workspaceSlug: string;
  planCode?: string;
}

export interface BeginOnboardingResult {
  tenant: Tenant;
  workspace: Workspace;
  progress: OnboardingProgress;
  ctx: TenantContext;
}

export interface CreateOnboardingBusinessInput {
  legalName: string;
  tradingName?: string;
  businessCode: string;
  industry?: string;
  legalStructure?: string;
  businessModel?: string;
}

/**
 * Orchestrates the multi-step tenant onboarding wizard. Each step is its
 * own atomic database transaction (composed sequentially here, never
 * nested), so a failure or dropped connection between steps leaves durable,
 * resumable state in onboarding.tenant_onboarding rather than rolling back
 * work that already succeeded — this is what makes resumeOnboarding() and
 * retrying an individual step both safe.
 */
export class OnboardingService {
  constructor(
    private readonly tenants: TenantRepository = new TenantRepository(),
    private readonly workspaces: WorkspaceRepository = new WorkspaceRepository(),
    private readonly businesses: BusinessRepository = new BusinessRepository(),
    private readonly settings: SettingsRepository = new SettingsRepository(),
    private readonly progress: OnboardingProgressRepository = new OnboardingProgressRepository(),
    private readonly memberships: MembershipRepository = new MembershipRepository(),
    private readonly invitations: InvitationRepository = new InvitationRepository(),
    private readonly authz: AuthorizationService = new AuthorizationService(),
    private readonly ownerAuthority: OwnerApproverAuthorityService = new OwnerApproverAuthorityService()
  ) {}

  /** Step 1: creates the tenant and its first workspace, and starts progress tracking. */
  async beginOnboarding(initiatedBy: string, input: BeginOnboardingInput): Promise<BeginOnboardingResult> {
    const tenant = await this.tenants.create({
      name: input.tenantName, slug: input.tenantSlug, planCode: input.planCode, createdBy: initiatedBy,
    });
    const workspace = await this.workspaces.create(tenant.id, {
      name: input.workspaceName, slug: input.workspaceSlug, createdBy: initiatedBy,
    });
    const onboardingProgress = await this.progress.create(tenant.id, workspace.id, initiatedBy);
    return { tenant, workspace, progress: onboardingProgress, ctx: { tenantId: tenant.id, workspaceId: workspace.id, userId: initiatedBy } };
  }

  /** Resume lookup for a user who has an in-progress onboarding attempt but no local ctx (e.g. new session/device). */
  async resumeOnboarding(userId: string): Promise<OnboardingProgress | null> {
    return this.progress.getActiveForUser(userId);
  }

  /**
   * Step 2: registers the business and its industry. Idempotent —
   * re-calling after success returns the existing business. Same
   * caller-supplied-ctx / initiator-verification reasoning as step 3's
   * assignOwner (see its own comment) — no membership exists yet here
   * either.
   */
  async setBusiness(ctx: TenantContext, onboardingId: string, input: CreateOnboardingBusinessInput): Promise<{ business: Business; progress: OnboardingProgress }> {
    const current = await this.progress.getById(ctx, onboardingId);
    if (current.initiatedBy !== ctx.userId) throw new OnboardingNotInitiatorError();
    if (current.businessId) {
      return { business: await this.businesses.getById(ctx, current.businessId), progress: current };
    }
    const business = await this.businesses.create(ctx, input);
    const updated = await this.progress.recordBusinessCreated(ctx, onboardingId, business.id);
    return { business, progress: updated };
  }

  /**
   * Step 3: creates and activates the initiating user's membership,
   * granting the 'owner' role. Idempotent.
   *
   * ctx.tenantId/workspaceId here are necessarily caller-supplied (no
   * membership exists yet for resolveTenantContext's usual active-
   * membership check to succeed against — this route is itself what
   * creates the first one). RLS on getById already confines the lookup
   * to ctx.tenantId's own rows, but that alone isn't enough: a caller
   * who supplies a real tenantId/onboardingId pair belonging to a
   * DIFFERENT user's in-progress onboarding would otherwise grant
   * themselves 'owner' in that tenant. Verifying the record's own
   * initiatedBy against ctx.userId closes that gap.
   */
  async assignOwner(ctx: TenantContext, onboardingId: string): Promise<{ membership: Membership; progress: OnboardingProgress }> {
    const current = await this.progress.getById(ctx, onboardingId);
    if (current.initiatedBy !== ctx.userId) throw new OnboardingNotInitiatorError();
    if (current.membershipId) {
      const membership = await this.memberships.getById(ctx, current.membershipId);
      // Re-run on retry: idempotent, so an interrupted first attempt is completed, never duplicated.
      await this.bootstrapOwnerAuthority(ctx, current);
      return { membership, progress: current };
    }
    const created = await this.memberships.create(ctx, ctx.userId);
    const active = await this.memberships.activate(ctx, created.id);
    await this.authz.assignRole(ctx, active.id, 'owner');
    const updated = await this.progress.recordOwnerAssigned(ctx, onboardingId, active.id);
    await this.bootstrapOwnerAuthority(ctx, updated);
    return { membership: active, progress: updated };
  }

  /**
   * Issues the owner's approval authority from the server-side ownership proof (the onboarding
   * record for THIS business and the active owner membership). Does nothing if the business is not
   * yet registered. Derives nothing from caller-supplied fields; see OwnerApproverAuthorityService.
   */
  private async bootstrapOwnerAuthority(ctx: TenantContext, progress: OnboardingProgress): Promise<void> {
    if (!progress.businessId) return;
    await this.ownerAuthority.bootstrapForBusiness(ctx, progress.businessId, { onboardingId: progress.id });
  }

  /** Step 4: applies default tenant settings, merged with any caller-supplied overrides. Naturally idempotent (upsert). */
  async applyDefaultSettings(ctx: TenantContext, onboardingId: string, overrides: Record<string, unknown> = {}): Promise<{ settings: Setting[]; progress: OnboardingProgress }> {
    const merged = { ...DEFAULT_TENANT_SETTINGS, ...overrides };
    const settingsRows = await this.settings.setMany('tenant', ctx.tenantId, merged);
    const updated = await this.progress.recordSettingsApplied(ctx, onboardingId);
    return { settings: settingsRows, progress: updated };
  }

  /** Step 5: invites team members (pass an empty array to skip). Idempotent — already-pending emails are not re-invited. */
  async inviteTeamMembers(ctx: TenantContext, onboardingId: string, emails: string[]): Promise<{ invitations: CreatedInvitation[]; progress: OnboardingProgress }> {
    const pending: Invitation[] = await this.invitations.listPending(ctx);
    const alreadyInvited = new Set(pending.map((i) => i.email.toLowerCase()));

    const created: CreatedInvitation[] = [];
    for (const email of emails) {
      if (alreadyInvited.has(email.toLowerCase())) continue;
      created.push(await this.authz.createInvitation(ctx, email));
    }

    const updated = await this.progress.recordInvitationsSent(ctx, onboardingId);
    return { invitations: created, progress: updated };
  }

  /** Step 6: marks onboarding complete. Requires every prior step to have been visited (invitations_sent, even with zero invitees). */
  async completeOnboarding(ctx: TenantContext, onboardingId: string): Promise<OnboardingProgress> {
    return this.progress.markCompleted(ctx, onboardingId);
  }

  async abandonOnboarding(ctx: TenantContext, onboardingId: string): Promise<OnboardingProgress> {
    return this.progress.markAbandoned(ctx, onboardingId);
  }
}
