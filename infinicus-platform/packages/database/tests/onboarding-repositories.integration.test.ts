/**
 * Live PostgreSQL 16 integration tests for BUILD-19 Tenant Onboarding
 * repositories (TenantRepository, WorkspaceRepository, BusinessRepository,
 * SettingsRepository, OnboardingProgressRepository), built on the frozen
 * tenancy/platform/identity schema plus the new onboarding.tenant_onboarding
 * table (migrations 0138-0141).
 *
 * Requires:
 *   DATABASE_URL — app_test_user (RLS enforced)
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, closePool } from '../src/client.js';
import { UserRepository, MembershipRepository } from '../src/repositories/auth/index.js';
import {
  TenantRepository, WorkspaceRepository, BusinessRepository, SettingsRepository,
  OnboardingProgressRepository,
  TenantSlugConflictError, WorkspaceSlugConflictError, BusinessCodeConflictError,
  TenantNotFoundError, WorkspaceNotFoundError, BusinessNotFoundError, OnboardingNotFoundError,
  OnboardingStepOrderError, OnboardingAlreadyTerminalError,
} from '../src/repositories/onboarding/index.js';

const run = !!process.env.DATABASE_URL;

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@onboarding-test.example`;
}

describe.runIf(run)('BUILD-19 Tenant Onboarding repositories — live PostgreSQL', () => {
  const users = new UserRepository();
  const tenants = new TenantRepository();
  const workspaces = new WorkspaceRepository();
  const businesses = new BusinessRepository();
  const settings = new SettingsRepository();
  const progress = new OnboardingProgressRepository();
  const memberships = new MembershipRepository();

  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
  });

  afterAll(async () => {
    await closePool();
  });

  async function createActiveUser() {
    const user = await users.createUser({ email: uniqueEmail('onb-user'), passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
    return users.activate(user.id);
  }

  async function createTenantAndWorkspace(userId: string) {
    const tenant = await tenants.create({ name: 'Onboarding Test Co', slug: uniqueSlug('onb-tenant'), createdBy: userId });
    const workspace = await workspaces.create(tenant.id, { name: 'Primary', slug: uniqueSlug('onb-ws'), createdBy: userId });
    return { tenant, workspace };
  }

  // ── 1. TenantRepository ─────────────────────────────────────────────────
  describe('TenantRepository', () => {
    it('creates a tenant with default trial status', async () => {
      const user = await createActiveUser();
      const tenant = await tenants.create({ name: 'Acme Inc', slug: uniqueSlug('acme'), createdBy: user.id });
      expect(tenant.status).toBe('trial');
      expect(tenant.defaultCurrency).toBe('USD');
    });

    it('reads back a tenant it just created', async () => {
      const user = await createActiveUser();
      const tenant = await tenants.create({ name: 'Acme Reads', slug: uniqueSlug('acme-r'), createdBy: user.id });
      const found = await tenants.getById(tenant.id);
      expect(found.id).toBe(tenant.id);
      expect(found.name).toBe('Acme Reads');
    });

    it('throws TenantNotFoundError for an unknown id', async () => {
      await expect(tenants.getById('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('rejects a duplicate slug with TenantSlugConflictError', async () => {
      const user = await createActiveUser();
      const slug = uniqueSlug('dup-tenant');
      await tenants.create({ name: 'First', slug, createdBy: user.id });
      await expect(tenants.create({ name: 'Second', slug, createdBy: user.id })).rejects.toBeInstanceOf(TenantSlugConflictError);
    });

    it('accepts an explicit planCode', async () => {
      const user = await createActiveUser();
      const tenant = await tenants.create({ name: 'Planned Co', slug: uniqueSlug('planned'), planCode: 'growth', createdBy: user.id });
      expect(tenant.planCode).toBe('growth');
    });
  });

  // ── 2. WorkspaceRepository ───────────────────────────────────────────────
  describe('WorkspaceRepository', () => {
    it('creates a workspace scoped to its tenant', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      expect(workspace.tenantId).toBe(tenant.id);
      expect(workspace.status).toBe('active');
    });

    it('reads back a workspace by id', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const found = await workspaces.getById({ tenantId: tenant.id, workspaceId: workspace.id, userId: user.id }, workspace.id);
      expect(found.id).toBe(workspace.id);
    });

    it('throws WorkspaceNotFoundError for an unknown id', async () => {
      const user = await createActiveUser();
      const { tenant } = await createTenantAndWorkspace(user.id);
      await expect(
        workspaces.getById({ tenantId: tenant.id, workspaceId: tenant.id, userId: user.id }, '00000000-0000-0000-0000-000000000000')
      ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    });

    it('rejects a duplicate slug within the same tenant', async () => {
      const user = await createActiveUser();
      const tenant = await tenants.create({ name: 'Dup WS Tenant', slug: uniqueSlug('dupws-tenant'), createdBy: user.id });
      const slug = uniqueSlug('dupws');
      await workspaces.create(tenant.id, { name: 'First', slug, createdBy: user.id });
      await expect(workspaces.create(tenant.id, { name: 'Second', slug, createdBy: user.id })).rejects.toBeInstanceOf(WorkspaceSlugConflictError);
    });

    it('allows the same slug across two different tenants', async () => {
      const user = await createActiveUser();
      const tenantA = await tenants.create({ name: 'Tenant A', slug: uniqueSlug('cross-a'), createdBy: user.id });
      const tenantB = await tenants.create({ name: 'Tenant B', slug: uniqueSlug('cross-b'), createdBy: user.id });
      const slug = uniqueSlug('shared-ws-slug');
      await expect(workspaces.create(tenantA.id, { name: 'WS A', slug, createdBy: user.id })).resolves.toBeDefined();
      await expect(workspaces.create(tenantB.id, { name: 'WS B', slug, createdBy: user.id })).resolves.toBeDefined();
    });

    it('lists all workspaces for a tenant', async () => {
      const user = await createActiveUser();
      const tenant = await tenants.create({ name: 'Multi WS Tenant', slug: uniqueSlug('multiws'), createdBy: user.id });
      await workspaces.create(tenant.id, { name: 'WS 1', slug: uniqueSlug('mws1'), createdBy: user.id });
      await workspaces.create(tenant.id, { name: 'WS 2', slug: uniqueSlug('mws2'), createdBy: user.id });
      const list = await workspaces.listForTenant(tenant.id);
      expect(list.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 3. BusinessRepository ────────────────────────────────────────────────
  describe('BusinessRepository', () => {
    it('creates a business as active (not the schema default draft)', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const business = await businesses.create(ctx, { legalName: 'Acme Trading LLC', businessCode: uniqueSlug('biz'), industry: 'retail' });
      expect(business.status).toBe('active');
      expect(business.industry).toBe('retail');
    });

    it('reads back a business by id', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const business = await businesses.create(ctx, { legalName: 'Read Co', businessCode: uniqueSlug('biz-r') });
      const found = await businesses.getById(ctx, business.id);
      expect(found.id).toBe(business.id);
    });

    it('throws BusinessNotFoundError for an unknown id', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      await expect(businesses.getById(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(BusinessNotFoundError);
    });

    it('rejects a duplicate business code within the same tenant', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const code = uniqueSlug('dupcode');
      await businesses.create(ctx, { legalName: 'First Biz', businessCode: code });
      await expect(businesses.create(ctx, { legalName: 'Second Biz', businessCode: code })).rejects.toBeInstanceOf(BusinessCodeConflictError);
    });

    it('updates status and increments version', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const business = await businesses.create(ctx, { legalName: 'Status Co', businessCode: uniqueSlug('status') });
      const suspended = await businesses.updateStatus(ctx, business.id, 'suspended');
      expect(suspended.status).toBe('suspended');
      expect(suspended.version).toBe(business.version + 1);
    });

    describe('listForWorkspace — SQL-pushed pagination', () => {
      it('bounds a page with LIMIT/OFFSET and reports the true total across pages', async () => {
        const user = await createActiveUser();
        const { tenant, workspace } = await createTenantAndWorkspace(user.id);
        const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };

        // Alphabetically-ordered names so page boundaries are deterministic:
        // listForWorkspace orders by legal_name.
        const names = ['Alpha Co', 'Bravo Co', 'Charlie Co', 'Delta Co', 'Echo Co'];
        for (const legalName of names) {
          await businesses.create(ctx, { legalName, businessCode: uniqueSlug('page') });
        }

        const firstPage = await businesses.listForWorkspace(ctx, { limit: 2, offset: 0 });
        expect(firstPage.items.map((b) => b.legalName)).toEqual(['Alpha Co', 'Bravo Co']);
        expect(firstPage.total).toBe(5);

        const secondPage = await businesses.listForWorkspace(ctx, { limit: 2, offset: 2 });
        expect(secondPage.items.map((b) => b.legalName)).toEqual(['Charlie Co', 'Delta Co']);
        expect(secondPage.total).toBe(5);

        // Last page is a partial page (5 rows, page size 2, offset 4) —
        // the boundary case a naive LIMIT/OFFSET translation gets wrong.
        const lastPage = await businesses.listForWorkspace(ctx, { limit: 2, offset: 4 });
        expect(lastPage.items.map((b) => b.legalName)).toEqual(['Echo Co']);
        expect(lastPage.total).toBe(5);

        // Past the end: empty items, but total still reflects the full set.
        const pastEnd = await businesses.listForWorkspace(ctx, { limit: 2, offset: 10 });
        expect(pastEnd.items).toEqual([]);
        expect(pastEnd.total).toBe(5);
      });

      it('defaults to DEFAULT_PAGE_SIZE when no page options are supplied', async () => {
        const user = await createActiveUser();
        const { tenant, workspace } = await createTenantAndWorkspace(user.id);
        const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
        await businesses.create(ctx, { legalName: 'Solo Co', businessCode: uniqueSlug('solo') });

        const page = await businesses.listForWorkspace(ctx);
        expect(page.items.some((b) => b.legalName === 'Solo Co')).toBe(true);
        expect(page.total).toBe(1);
      });
    });
  });

  // ── 4. SettingsRepository ────────────────────────────────────────────────
  describe('SettingsRepository', () => {
    it('sets and reads back multiple settings for a tenant scope', async () => {
      const user = await createActiveUser();
      const { tenant } = await createTenantAndWorkspace(user.id);
      await settings.setMany('tenant', tenant.id, { theme: 'dark', notificationsEnabled: true });
      const all = await settings.getAll('tenant', tenant.id);
      const byKey = Object.fromEntries(all.map((s) => [s.key, s.value]));
      expect(byKey.theme).toBe('dark');
      expect(byKey.notificationsEnabled).toBe(true);
    });

    it('upserts an existing key rather than duplicating it', async () => {
      const user = await createActiveUser();
      const { tenant } = await createTenantAndWorkspace(user.id);
      await settings.setMany('tenant', tenant.id, { theme: 'light' });
      await settings.setMany('tenant', tenant.id, { theme: 'dark' });
      const all = await settings.getAll('tenant', tenant.id);
      const themeRows = all.filter((s) => s.key === 'theme');
      expect(themeRows).toHaveLength(1);
      expect(themeRows[0].value).toBe('dark');
    });

    it('returns an empty list for a scope with no settings', async () => {
      const user = await createActiveUser();
      const { tenant } = await createTenantAndWorkspace(user.id);
      const all = await settings.getAll('tenant', tenant.id);
      expect(all).toEqual([]);
    });
  });

  // ── 5. OnboardingProgressRepository ──────────────────────────────────────
  describe('OnboardingProgressRepository', () => {
    it('create() starts progress at workspace_created', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const onboarding = await progress.create(tenant.id, workspace.id, user.id);
      expect(onboarding.status).toBe('in_progress');
      expect(onboarding.currentStep).toBe('workspace_created');
      expect(onboarding.completedSteps).toEqual(['workspace_created']);
    });

    it('throws OnboardingNotFoundError for an unknown id', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      await expect(progress.getById(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(OnboardingNotFoundError);
    });

    it('getByTenant finds the onboarding row for a tenant', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const found = await progress.getByTenant(ctx, tenant.id);
      expect(found.id).toBe(created.id);
    });

    it('getActiveForUser finds an in-progress attempt without a pre-known tenant', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const found = await progress.getActiveForUser(user.id);
      expect(found?.id).toBe(created.id);
    });

    it('getActiveForUser returns null for a user with no onboarding attempt', async () => {
      const user = await createActiveUser();
      const found = await progress.getActiveForUser(user.id);
      expect(found).toBeNull();
    });

    it('advances through business_created, owner_assigned, settings_applied, invitations_sent, completed', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const business = await businesses.create(ctx, { legalName: 'Step Co', businessCode: uniqueSlug('step') });

      const afterBusiness = await progress.recordBusinessCreated(ctx, created.id, business.id);
      expect(afterBusiness.currentStep).toBe('business_created');
      expect(afterBusiness.businessId).toBe(business.id);

      const membership = await memberships.create(ctx, user.id);
      const afterOwner = await progress.recordOwnerAssigned(ctx, created.id, membership.id);
      expect(afterOwner.currentStep).toBe('owner_assigned');

      const afterSettings = await progress.recordSettingsApplied(ctx, created.id);
      expect(afterSettings.currentStep).toBe('settings_applied');

      const afterInvitations = await progress.recordInvitationsSent(ctx, created.id);
      expect(afterInvitations.currentStep).toBe('invitations_sent');

      const completed = await progress.markCompleted(ctx, created.id);
      expect(completed.status).toBe('completed');
      expect(completed.currentStep).toBe('completed');
      expect(completed.completedAt).not.toBeNull();
    });

    it('re-recording an already-completed step is idempotent (no error, no step regression)', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const business = await businesses.create(ctx, { legalName: 'Idempotent Co', businessCode: uniqueSlug('idem') });

      const first = await progress.recordBusinessCreated(ctx, created.id, business.id);
      const second = await progress.recordBusinessCreated(ctx, created.id, business.id);
      expect(second.currentStep).toBe(first.currentStep);
      expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    });

    it('rejects an out-of-order step with OnboardingStepOrderError', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      await expect(progress.recordSettingsApplied(ctx, created.id)).rejects.toBeInstanceOf(OnboardingStepOrderError);
    });

    it('markCompleted rejects when invitations_sent has not been reached yet', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      await expect(progress.markCompleted(ctx, created.id)).rejects.toBeInstanceOf(OnboardingStepOrderError);
    });

    it('markAbandoned sets status and abandoned_at', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const abandoned = await progress.markAbandoned(ctx, created.id);
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.abandonedAt).not.toBeNull();
    });

    it('further step changes on an abandoned onboarding throw OnboardingAlreadyTerminalError', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      await progress.markAbandoned(ctx, created.id);
      const business = await businesses.create(ctx, { legalName: 'Abandoned Co', businessCode: uniqueSlug('aband') });
      await expect(progress.recordBusinessCreated(ctx, created.id, business.id)).rejects.toBeInstanceOf(OnboardingAlreadyTerminalError);
    });

    it('markCompleted on an already-completed onboarding is idempotent', async () => {
      const user = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user.id);
      const ctx = { tenantId: tenant.id, workspaceId: workspace.id, userId: user.id };
      const created = await progress.create(tenant.id, workspace.id, user.id);
      const business = await businesses.create(ctx, { legalName: 'Complete Twice Co', businessCode: uniqueSlug('ctwice') });
      await progress.recordBusinessCreated(ctx, created.id, business.id);
      const membership = await memberships.create(ctx, user.id);
      await progress.recordOwnerAssigned(ctx, created.id, membership.id);
      await progress.recordSettingsApplied(ctx, created.id);
      await progress.recordInvitationsSent(ctx, created.id);
      const completedOnce = await progress.markCompleted(ctx, created.id);
      const completedTwice = await progress.markCompleted(ctx, created.id);
      expect(completedTwice.completedAt?.getTime()).toBe(completedOnce.completedAt?.getTime());
    });
  });

  // ── 6. Cross-tenant / cross-user isolation (live RLS) ────────────────────
  describe('cross-tenant isolation (live RLS)', () => {
    it('a different user cannot resolve another user\'s onboarding via getActiveForUser', async () => {
      const user1 = await createActiveUser();
      const user2 = await createActiveUser();
      const { tenant, workspace } = await createTenantAndWorkspace(user1.id);
      await progress.create(tenant.id, workspace.id, user1.id);
      const found = await progress.getActiveForUser(user2.id);
      expect(found).toBeNull();
    });

    it('tenant B cannot read tenant A\'s onboarding row by id even with the correct row id', async () => {
      const userA = await createActiveUser();
      const userB = await createActiveUser();
      const { tenant: tenantA, workspace: workspaceA } = await createTenantAndWorkspace(userA.id);
      const onboardingA = await progress.create(tenantA.id, workspaceA.id, userA.id);
      const { tenant: tenantB, workspace: workspaceB } = await createTenantAndWorkspace(userB.id);
      const ctxB = { tenantId: tenantB.id, workspaceId: workspaceB.id, userId: userB.id };
      await expect(progress.getById(ctxB, onboardingA.id)).rejects.toBeInstanceOf(OnboardingNotFoundError);
    });

    it('a business created under tenant A is not visible under tenant B\'s context', async () => {
      const userA = await createActiveUser();
      const userB = await createActiveUser();
      const { tenant: tenantA, workspace: workspaceA } = await createTenantAndWorkspace(userA.id);
      const ctxA = { tenantId: tenantA.id, workspaceId: workspaceA.id, userId: userA.id };
      const business = await businesses.create(ctxA, { legalName: 'Isolated Co', businessCode: uniqueSlug('isob') });
      const { tenant: tenantB, workspace: workspaceB } = await createTenantAndWorkspace(userB.id);
      const ctxB = { tenantId: tenantB.id, workspaceId: workspaceB.id, userId: userB.id };
      await expect(businesses.getById(ctxB, business.id)).rejects.toBeInstanceOf(BusinessNotFoundError);
    });
  });
});

describe.skipIf(run)('BUILD-19 Tenant Onboarding repositories — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});
