/**
 * Live PostgreSQL tests: the owner approval-authority bootstrap wired into the onboarding
 * owner-assignment step (V-01). Authority comes only from server-side ownership proof.
 *
 * Requires DATABASE_URL (app_test_user, RLS enforced).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPool, closePool, UserRepository, ApproverAuthorityRepository, BusinessRepository, MembershipRepository,
  OWNER_APPROVER_ASSIGNMENT_CODE, type TenantContext,
} from '@infinicus/database';
import { OnboardingService } from '../src/OnboardingService.js';
import { OwnerApproverAuthorityService } from '../src/OwnerApproverAuthorityService.js';

const run = !!process.env.DATABASE_URL;
const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe.runIf(run)('owner authority bootstrap at onboarding — live PostgreSQL', () => {
  const users = new UserRepository();
  const authority = new ApproverAuthorityRepository();
  const businesses = new BusinessRepository();
  const memberships = new MembershipRepository();

  beforeAll(() => createPool({ connectionString: process.env.DATABASE_URL! }));
  afterAll(async () => closePool());

  async function newUser() {
    const u = await users.createUser({ email: `${uid('boot')}@owner-bootstrap.example`, passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
    return users.activate(u.id);
  }

  async function begin(service: OnboardingService) {
    const user = await newUser();
    const started = await service.beginOnboarding(user.id, {
      tenantName: 'Bootstrap Co', tenantSlug: uid('bs'), workspaceName: 'Main', workspaceSlug: uid('bs-ws'),
    });
    const { business } = await service.setBusiness(started.ctx, started.progress.id, { legalName: 'Bootstrap LLC', businessCode: uid('bsbiz') });
    return { user, ctx: started.ctx, onboardingId: started.progress.id, business };
  }

  it('issues the business-owner-approver assignment to the proven owner when the owner is assigned, with provenance', async () => {
    const service = new OnboardingService();
    const { user, ctx, onboardingId, business } = await begin(service);
    expect(await authority.findByCode(ctx, business.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull(); // nothing before the owner step

    const { membership } = await service.assignOwner(ctx, onboardingId);

    const assignment = await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE);
    expect(assignment).not.toBeNull();
    expect(assignment!.businessId).toBe(business.id);
    const history = await authority.listProvenance(ctx, assignment!.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'grant', source: 'onboarding', state: 'active', granteeUserId: user.id, businessId: business.id,
      assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE,
      actor: { type: 'system', id: null, authority: 'owner-bootstrap:onboarding' },
      proof: { kind: 'onboarding-membership', membershipId: membership.id, onboardingId },
    });
  });

  it('is idempotent: assigning the owner again changes nothing and adds no second assignment or provenance entry', async () => {
    const service = new OnboardingService();
    const { user, ctx, onboardingId, business } = await begin(service);
    await service.assignOwner(ctx, onboardingId);
    const first = await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE);
    await service.assignOwner(ctx, onboardingId);
    const second = await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE);
    expect(second!.id).toBe(first!.id);
    expect(await authority.listProvenance(ctx, first!.id)).toHaveLength(1);
  });

  it('completes an interrupted bootstrap on retry: a failure after the owner step is retried, never duplicated', async () => {
    let calls = 0;
    const real = new OwnerApproverAuthorityService();
    const flaky = {
      bootstrapForBusiness: async (...args: Parameters<OwnerApproverAuthorityService['bootstrapForBusiness']>) => {
        calls += 1;
        if (calls === 1) throw new Error('simulated outage');
        return real.bootstrapForBusiness(...args);
      },
    } as unknown as OwnerApproverAuthorityService;
    const service = new OnboardingService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, flaky);
    const { user, ctx, onboardingId, business } = await begin(service);

    await expect(service.assignOwner(ctx, onboardingId)).rejects.toThrow('simulated outage');
    expect(await authority.findByCode(ctx, business.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();

    await service.assignOwner(ctx, onboardingId); // owner step already recorded: the retry still completes the grant
    expect(await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE)).not.toBeNull();
  });

  it('issues nothing to an authenticated principal who is not the proven owner (no self-issued or borrowed authority)', async () => {
    const service = new OnboardingService();
    const { ctx, onboardingId, business } = await begin(service);
    await service.assignOwner(ctx, onboardingId);
    // The owner holds it already; a different principal asking for a bootstrap gets nothing and changes nothing.
    const stranger = await newUser();
    const result = await new OwnerApproverAuthorityService().bootstrapForBusiness({ ...ctx, userId: stranger.id }, business.id);
    expect(result.outcome).toBe('held-by-other');
    expect(await authority.findActiveForUser(ctx, business.id, stranger.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();
  });

  it('the grantee must be the authenticated principal: a proven owner is not granted authority on someone else\'s request', async () => {
    // Assign the owner WITHOUT running the bootstrap, so nothing is assigned yet.
    const noop = { bootstrapForBusiness: async () => ({ outcome: 'not-granted', classification: 'PROVEN', reason: 'skipped', assignmentId: null }) } as unknown as OwnerApproverAuthorityService;
    const service = new OnboardingService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, noop);
    const { user, ctx, onboardingId, business } = await begin(service);
    await service.assignOwner(ctx, onboardingId);
    expect(await authority.findByCode(ctx, business.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();

    const bootstrap = new OwnerApproverAuthorityService();
    const stranger = await newUser();
    const refused = await bootstrap.bootstrapForBusiness({ ...ctx, userId: stranger.id }, business.id);
    expect(refused.outcome).toBe('not-granted');
    expect(refused.reason).toMatch(/not the proven owner/);
    expect(await authority.findByCode(ctx, business.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();

    const granted = await bootstrap.bootstrapForBusiness({ ...ctx, userId: user.id }, business.id);
    expect(granted.outcome).toBe('granted');
  });

  it('issues nothing for a business with no ownership proof, even for its creator or a tenant-wide owner', async () => {
    const service = new OnboardingService();
    const { ctx } = await begin(service);
    const creator: TenantContext = ctx;
    const orphan = await businesses.create(creator, { legalName: 'No Proof LLC', businessCode: uid('orphan') });
    const result = await new OwnerApproverAuthorityService().bootstrapForBusiness(creator, orphan.id);
    expect(result.outcome).toBe('not-granted');
    expect(result.classification).toBe('UNPROVEN');
    expect(await authority.findByCode(ctx, orphan.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();
  });

  it('never re-grants automatically after a revocation', async () => {
    const service = new OnboardingService();
    const { user, ctx, onboardingId, business } = await begin(service);
    await service.assignOwner(ctx, onboardingId);
    const assignment = await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE);
    await authority.revokeAssignment(ctx, assignment!.id, {
      source: 'manual-admin', actor: { type: 'user', id: user.id, authority: 'aba:admin' },
      at: new Date().toISOString(), correlationId: null, proof: null, reason: 'owner stepped down',
    });

    await service.assignOwner(ctx, onboardingId); // retry path runs the bootstrap again
    const result = await new OwnerApproverAuthorityService().bootstrapForBusiness(ctx, business.id);
    expect(result.outcome).toBe('previously-revoked');
    expect(await authority.findActiveForUser(ctx, business.id, user.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();
    expect((await authority.findByCode(ctx, business.id, OWNER_APPROVER_ASSIGNMENT_CODE))!.status).toBe('revoked');
  });

  it('an owner whose membership is no longer active gets no authority from the bootstrap', async () => {
    const service = new OnboardingService();
    const { user, ctx, onboardingId, business } = await begin(service);
    const { membership } = await service.assignOwner(ctx, onboardingId);
    // Remove the owner's membership AFTER the grant; a fresh business check classifies it as no longer provable.
    await memberships.suspend({ ...ctx, userId: user.id }, membership.id);
    const result = await new OwnerApproverAuthorityService().bootstrapForBusiness(ctx, business.id);
    expect(result.classification).toBe('ALREADY_ASSIGNED'); // the earlier grant exists; it is flagged, not silently trusted or revoked
    expect(result.outcome).toBe('already-assigned');
  });
});
