/**
 * Live PostgreSQL tests for the owner approval-authority bootstrap building blocks (V-01):
 * the STRICT ownership proof classifier fed by real rows, the atomic idempotent grant,
 * revocation, the append-only provenance history, and the read-only backfill dry-run.
 *
 * Requires DATABASE_URL (app_test_user, RLS enforced) and ADMIN_DATABASE_URL (for the
 * dry-run enumeration and for fixtures the app role cannot create).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, type TenantContext } from '../src/client.js';
import { UserRepository, MembershipRepository, RoleRepository } from '../src/repositories/auth/index.js';
import { TenantRepository, WorkspaceRepository, BusinessRepository, OnboardingProgressRepository } from '../src/repositories/onboarding/index.js';
import { ApproverAuthorityRepository } from '../src/repositories/approved_action/index.js';
import { OWNER_APPROVER_ASSIGNMENT_CODE } from '../src/repositories/approved_action/authorityProvenance.js';
import { OwnershipEvidenceRepository, classifyOwnership, runOwnerAuthorityDryRun, CANDIDATE_LABEL } from '../src/repositories/ownership/index.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe.runIf(run)('owner authority — ownership proof, grant, revoke, provenance, dry-run (live PostgreSQL)', () => {
  const users = new UserRepository();
  const tenants = new TenantRepository();
  const workspaces = new WorkspaceRepository();
  const businesses = new BusinessRepository();
  const progress = new OnboardingProgressRepository();
  const memberships = new MembershipRepository();
  const roles = new RoleRepository();
  const authority = new ApproverAuthorityRepository();
  const evidence = new OwnershipEvidenceRepository();
  let admin: Pool;

  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
  });
  afterAll(async () => {
    await admin.end();
    await closePool();
  });

  async function newUser() {
    const u = await users.createUser({ email: `${uid('own')}@owner-authority.example`, passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
    return users.activate(u.id);
  }

  /** A tenant+workspace with a creator (who is NOT automatically an owner of anything). */
  async function newWorld() {
    const creator = await newUser();
    const tenant = await tenants.create({ name: 'Owner Authority Co', slug: uid('oa-t'), createdBy: creator.id });
    const ws = await workspaces.create(tenant.id, { name: 'Primary', slug: uid('oa-w'), createdBy: creator.id });
    const ctx: TenantContext = { tenantId: tenant.id, workspaceId: ws.id, userId: creator.id };
    return { creator, tenant, ws, ctx };
  }

  async function newBusiness(ctx: TenantContext) {
    return businesses.create(ctx, { legalName: 'Fixture Biz', businessCode: uid('oa-b') });
  }

  async function addMember(ctx: TenantContext, userId: string, status: 'active' | 'suspended' = 'active') {
    const m = await memberships.activate(ctx, (await memberships.create(ctx, userId)).id);
    return status === 'suspended' ? memberships.suspend(ctx, m.id) : m;
  }

  async function giveOwnerRole(ctx: TenantContext, membershipId: string, businessId: string | null) {
    const owner = await roles.getByCode(ctx, 'owner');
    await memberships.assignRole(ctx, membershipId, owner.id, businessId);
  }

  /** The onboarding path: the record names the business and the owner's membership. */
  async function onboardOwner(ctx: TenantContext, ownerUserId: string, businessId: string, suspended = false) {
    const onboarding = await progress.create(ctx.tenantId, ctx.workspaceId, ownerUserId);
    const asOwner: TenantContext = { ...ctx, userId: ownerUserId };
    await progress.recordBusinessCreated(asOwner, onboarding.id, businessId);
    const membership = await addMember(asOwner, ownerUserId);
    await giveOwnerRole(asOwner, membership.id, null);
    await progress.recordOwnerAssigned(asOwner, onboarding.id, membership.id);
    if (suspended) await memberships.suspend(asOwner, membership.id);
    return { onboarding, membership };
  }

  // ── the strict proof, one scenario per class ──────────────────────────────
  it('PROVEN: the onboarding record proves the business, the user and an active owner membership', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { onboarding, membership } = await onboardOwner(w.ctx, owner.id, biz.id);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('PROVEN');
    expect(verdict.eligibleForGrant).toBe(true);
    expect(verdict.provenOwners).toEqual([{ userId: owner.id, proof: { kind: 'onboarding-membership', membershipId: membership.id, onboardingId: onboarding.id } }]);
  });

  it('PROVEN: an active membership holding the owner role scoped to that business is proof', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const m = await addMember(w.ctx, owner.id);
    await giveOwnerRole(w.ctx, m.id, biz.id);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('PROVEN');
    expect(verdict.provenOwners[0].proof.kind).toBe('explicit-owner-role');
  });

  it('UNPROVEN: created_by alone is NOT proof of ownership', async () => {
    const w = await newWorld();
    const biz = await newBusiness(w.ctx); // created_by = w.creator
    expect(biz.createdBy ?? w.creator.id).toBe(w.creator.id);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('UNPROVEN');
    expect(verdict.eligibleForGrant).toBe(false);
    expect(verdict.provenOwners).toEqual([]);
  });

  it('UNPROVEN + CANDIDATE: a tenant-wide owner without a business-specific link is a candidate, never auto-granted', async () => {
    const w = await newWorld();
    const tenantOwner = await newUser();
    const biz = await newBusiness(w.ctx);
    const m = await addMember(w.ctx, tenantOwner.id);
    await giveOwnerRole(w.ctx, m.id, null); // tenant-wide
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('UNPROVEN');
    expect(verdict.eligibleForGrant).toBe(false);
    expect(verdict.candidates).toEqual([{ userId: tenantOwner.id, membershipId: m.id, label: CANDIDATE_LABEL }]);
  });

  it('AMBIGUOUS: several valid owners and one holder of the code, so nobody is granted automatically', async () => {
    const w = await newWorld();
    const first = await newUser();
    const second = await newUser();
    const biz = await newBusiness(w.ctx);
    await onboardOwner(w.ctx, first.id, biz.id);
    const m2 = await addMember(w.ctx, second.id);
    await giveOwnerRole(w.ctx, m2.id, biz.id);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('AMBIGUOUS');
    expect(verdict.eligibleForGrant).toBe(false);
    expect(verdict.provenOwners.map((o) => o.userId).sort()).toEqual([first.id, second.id].sort());
  });

  it('INVALID_INACTIVE: the onboarding owner membership is no longer active', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    await onboardOwner(w.ctx, owner.id, biz.id, true);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('INVALID_INACTIVE');
    expect(verdict.eligibleForGrant).toBe(false);
    expect(verdict.notes.join(' ')).toMatch(/suspended/);
  });

  it('INVALID_INACTIVE: a closed business is never granted authority', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    await onboardOwner(w.ctx, owner.id, biz.id);
    await admin.query(`UPDATE platform.businesses SET status = 'closed' WHERE id = $1`, [biz.id]);
    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('INVALID_INACTIVE');
  });

  // ── grant, idempotency, revocation, provenance ────────────────────────────
  function grantInput(businessId: string, userId: string, proofMembershipId: string) {
    return {
      businessId, userId, assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner',
      provenance: {
        action: 'grant' as const, source: 'onboarding' as const, businessId, assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE,
        granteeUserId: userId, state: 'active' as const,
        actor: { type: 'system' as const, id: null, authority: 'owner-bootstrap:onboarding' },
        at: new Date().toISOString(), correlationId: 'corr-1',
        proof: { kind: 'onboarding-membership' as const, membershipId: proofMembershipId, onboardingId: null }, reason: null,
      },
    };
  }

  it('grants an ACTIVE assignment atomically with its provenance, and a second grant changes nothing', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { membership } = await onboardOwner(w.ctx, owner.id, biz.id);

    const first = await authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id));
    expect(first.created).toBe(true);
    expect(first.assignment.status).toBe('active');
    expect(first.assignment.latestVersion).toBe(1);
    expect(await authority.findActiveForUser(w.ctx, biz.id, owner.id, OWNER_APPROVER_ASSIGNMENT_CODE)).not.toBeNull();

    const second = await authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id));
    expect(second.created).toBe(false);
    expect(second.assignment.id).toBe(first.assignment.id);

    const history = await authority.listProvenance(w.ctx, first.assignment.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'grant', source: 'onboarding', state: 'active', granteeUserId: owner.id, businessId: biz.id,
      assignmentCode: OWNER_APPROVER_ASSIGNMENT_CODE, assignmentId: first.assignment.id, correlationId: 'corr-1',
      actor: { type: 'system', id: null, authority: 'owner-bootstrap:onboarding' },
      proof: { kind: 'onboarding-membership', membershipId: membership.id },
    });
  });

  it('two concurrent grants produce exactly one assignment', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { membership } = await onboardOwner(w.ctx, owner.id, biz.id);
    const results = await Promise.all([
      authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id)),
      authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id)),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.assignment.id)).size).toBe(1);
  });

  it('revocation removes authority at once, records who and why, and is idempotent', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { membership } = await onboardOwner(w.ctx, owner.id, biz.id);
    const { assignment } = await authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id));

    const revoke = (reason: string) => authority.revokeAssignment(w.ctx, assignment.id, {
      source: 'manual-admin', actor: { type: 'user', id: w.creator.id, authority: 'aba:admin' },
      at: new Date().toISOString(), correlationId: 'corr-2', proof: null, reason,
    });
    const first = await revoke('owner left the business');
    expect(first.changed).toBe(true);
    expect(first.assignment.status).toBe('revoked');
    expect(await authority.findActiveForUser(w.ctx, biz.id, owner.id, OWNER_APPROVER_ASSIGNMENT_CODE)).toBeNull();

    expect((await revoke('again')).changed).toBe(false);

    const history = await authority.listProvenance(w.ctx, assignment.id);
    expect(history.map((h) => [h.action, h.state])).toEqual([['grant', 'active'], ['revoke', 'revoked']]);
    expect(history[1]).toMatchObject({
      source: 'manual-admin', reason: 'owner left the business', correlationId: 'corr-2',
      actor: { type: 'user', id: w.creator.id, authority: 'aba:admin' }, granteeUserId: owner.id,
    });
  });

  it('ALREADY_ASSIGNED (active and revoked): never re-granted automatically', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { membership } = await onboardOwner(w.ctx, owner.id, biz.id);
    const { assignment } = await authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id));

    const active = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(active.classification).toBe('ALREADY_ASSIGNED');
    expect(active.eligibleForGrant).toBe(false);
    expect(active.holderStillProvenOwner).toBe(true);

    await authority.revokeAssignment(w.ctx, assignment.id, {
      source: 'manual-admin', actor: { type: 'user', id: w.creator.id, authority: 'aba:admin' },
      at: new Date().toISOString(), correlationId: null, proof: null, reason: 'test',
    });
    const revoked = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(revoked.classification).toBe('ALREADY_ASSIGNED');
    expect(revoked.eligibleForGrant).toBe(false);
    expect(revoked.notes.join(' ')).toMatch(/explicit aba:admin decision/);
  });

  it('a holder whose ownership proof lapsed is flagged for review, never revoked automatically', async () => {
    const w = await newWorld();
    const owner = await newUser();
    const biz = await newBusiness(w.ctx);
    const { membership } = await onboardOwner(w.ctx, owner.id, biz.id);
    await authority.grantActiveAssignment(w.ctx, grantInput(biz.id, owner.id, membership.id));
    await memberships.suspend({ ...w.ctx, userId: owner.id }, membership.id);

    const verdict = classifyOwnership(await evidence.loadForBusiness(w.ctx, biz.id));
    expect(verdict.classification).toBe('ALREADY_ASSIGNED');
    expect(verdict.holderStillProvenOwner).toBe(false);
    expect(verdict.notes.join(' ')).toMatch(/never revoked automatically/);
    expect(await authority.findActiveForUser(w.ctx, biz.id, owner.id, OWNER_APPROVER_ASSIGNMENT_CODE)).not.toBeNull();
  });

  // ── the dry run ───────────────────────────────────────────────────────────
  it('dry-run: classifies every business, proposes grants only for PROVEN, and writes nothing', async () => {
    const proven = await newWorld();
    const provenOwner = await newUser();
    const provenBiz = await newBusiness(proven.ctx);
    await onboardOwner(proven.ctx, provenOwner.id, provenBiz.id);

    const ambiguous = await newWorld();
    const a1 = await newUser();
    const a2 = await newUser();
    const ambBiz = await newBusiness(ambiguous.ctx);
    await onboardOwner(ambiguous.ctx, a1.id, ambBiz.id);
    await giveOwnerRole(ambiguous.ctx, (await addMember(ambiguous.ctx, a2.id)).id, ambBiz.id);

    const unproven = await newWorld();
    const cand = await newUser();
    const unprovenBiz = await newBusiness(unproven.ctx);
    await giveOwnerRole(unproven.ctx, (await addMember(unproven.ctx, cand.id)).id, null);

    const inactive = await newWorld();
    const inactiveOwner = await newUser();
    const inactiveBiz = await newBusiness(inactive.ctx);
    await onboardOwner(inactive.ctx, inactiveOwner.id, inactiveBiz.id, true);

    const assigned = await newWorld();
    const assignedOwner = await newUser();
    const assignedBiz = await newBusiness(assigned.ctx);
    const { membership } = await onboardOwner(assigned.ctx, assignedOwner.id, assignedBiz.id);
    await authority.grantActiveAssignment(assigned.ctx, grantInput(assignedBiz.id, assignedOwner.id, membership.id));

    // Scoped to this test's own tenants: other test files write to the same
    // database in parallel, so a table-wide count is not stable.
    const ownTenantIds = [proven, ambiguous, unproven, inactive, assigned].map((w) => w.tenant.id);
    const countRows = async () => Number((await admin.query(
      'SELECT count(*) AS n FROM approved_business_action.approver_assignments WHERE tenant_id = ANY($1::uuid[])', [ownTenantIds]
    )).rows[0].n);
    const before = await countRows();

    const report = await runOwnerAuthorityDryRun(admin);

    expect(await countRows()).toBe(before);
    expect(report.mode).toBe('DRY_RUN_READ_ONLY');
    expect(report.executed).toBe(false);
    expect(report.businessesScanned).toBe(report.entries.length);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.entries.length);

    const byBusiness = (id: string) => report.entries.find((e) => e.businessId === id)!;
    expect(byBusiness(provenBiz.id).classification).toBe('PROVEN');
    expect(byBusiness(provenBiz.id).proposedGrantee).toMatchObject({ userId: provenOwner.id, proofKind: 'onboarding-membership' });
    expect(byBusiness(ambBiz.id).classification).toBe('AMBIGUOUS');
    expect(byBusiness(ambBiz.id).proposedGrantee).toBeNull();
    expect(byBusiness(ambBiz.id).provenOwnerUserIds.sort()).toEqual([a1.id, a2.id].sort());
    expect(byBusiness(unprovenBiz.id).classification).toBe('UNPROVEN');
    expect(byBusiness(unprovenBiz.id).proposedGrantee).toBeNull();
    expect(byBusiness(inactiveBiz.id).classification).toBe('INVALID_INACTIVE');
    expect(byBusiness(assignedBiz.id).classification).toBe('ALREADY_ASSIGNED');
    // Only PROVEN entries ever carry a proposed grantee.
    for (const entry of report.entries) {
      expect(entry.proposedGrantee !== null).toBe(entry.classification === 'PROVEN');
    }
  });

  it('the dry-run connection is read-only: a write inside its transaction is rejected by the database', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(client.query(`UPDATE platform.businesses SET legal_name = legal_name WHERE false`)).rejects.toThrow(/read-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
