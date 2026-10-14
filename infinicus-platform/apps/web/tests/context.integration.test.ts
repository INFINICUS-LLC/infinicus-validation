/**
 * J-2 against real PostgreSQL: the real AuthenticationService / MembershipRepository / AuthorizationService behind resolveContext.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, UserRepository, MembershipRepository, RoleRepository, type TenantContext } from '@infinicus/database';
import { AuthenticationService } from '@infinicus/authentication';
import { resolveContext } from '../lib/context.js';
import { WORKFLOW_VIEW_PERMISSIONS, DECISION_PERMISSIONS } from '../lib/permissions.js';

// Each test registers and logs in real users; password hashing is slow on CI runners (apps/api sets the same 180s/60s for this reason).
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const PASSWORD = 'Correct-Horse-9!';
let admin: Pool;
const auth = new AuthenticationService();

async function world(role: string | null) {
  const email = `j2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@j2.example`;
  const userId = (await auth.register(email, PASSWORD)).id;
  await new UserRepository().activate(userId);
  const { rawSessionToken } = await auth.login(email, PASSWORD);
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = randomUUID().slice(0, 8);
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'J2',$2,'active','test')`, [tenantId, `j2-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'J2 WS',$3,'active')`, [workspaceId, tenantId, `j2-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  const roleId = role ? (await new RoleRepository().getByCode(ctx, role)).id : null;
  if (roleId) await memberships.assignRole(ctx, m.id, roleId);
  return { ctx, membershipId: m.id, roleId, token: rawSessionToken, claim: `${tenantId}:${workspaceId}`, userId };
}

describe.runIf(run)('apps/web resolveContext - live PostgreSQL (AC-3 J-2)', () => {
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('a valid session + ACTIVE membership + permissions resolves to the SESSION principal', async () => {
    const w = await world('owner');
    expect(await resolveContext({ sessionToken: w.token, workspaceClaim: w.claim }, WORKFLOW_VIEW_PERMISSIONS)).toEqual({ ok: true, ctx: w.ctx });
  });

  it('no session, a garbage token, or a forged claim for someone else\'s workspace all fail closed', async () => {
    const a = await world('owner'); const b = await world('owner');
    expect(await resolveContext({ workspaceClaim: a.claim }, [])).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await resolveContext({ sessionToken: 'not-a-token', workspaceClaim: a.claim }, [])).toEqual({ ok: false, reason: 'unauthenticated' });
    // A's valid session claiming B's workspace: A has no membership there, so it is forbidden (the claim selects, never grants).
    expect(await resolveContext({ sessionToken: a.token, workspaceClaim: b.claim }, [])).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('an active member WITHOUT the permission is forbidden', async () => {
    const w = await world(null);
    expect(await resolveContext({ sessionToken: w.token, workspaceClaim: w.claim }, DECISION_PERMISSIONS)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('suspension and role revocation take effect on the very next call (nothing cached)', async () => {
    const w = await world('owner');
    const input = { sessionToken: w.token, workspaceClaim: w.claim };
    expect((await resolveContext(input, DECISION_PERMISSIONS)).ok).toBe(true);
    await new MembershipRepository().revokeRole(w.ctx, w.membershipId, w.roleId!);
    expect(await resolveContext(input, DECISION_PERMISSIONS)).toEqual({ ok: false, reason: 'forbidden' });
    await new MembershipRepository().assignRole(w.ctx, w.membershipId, w.roleId!);
    expect((await resolveContext(input, DECISION_PERMISSIONS)).ok).toBe(true);
    await new MembershipRepository().suspend(w.ctx, w.membershipId);
    expect(await resolveContext(input, DECISION_PERMISSIONS)).toEqual({ ok: false, reason: 'forbidden' });
  });
});
