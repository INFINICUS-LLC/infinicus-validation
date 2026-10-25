import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, UserRepository, MembershipRepository } from '@infinicus/database';
import { AuthorizationService } from '@infinicus/authorization';
import { OfflineReviewEvidenceReader } from '../src/services/OfflineReviewEvidenceReader.js';

describe.runIf(!!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL)('M1-A6 canonical review read', () => {
  const tenant = randomUUID(); const workspace = randomUUID();
  const business = randomUUID(); const foreignBusiness = randomUUID(); const intake = randomUUID();
  let admin: Pool;
  let permitted: { tenantId: string; workspaceId: string; userId: string };
  let denied: { tenantId: string; workspaceId: string; userId: string };
  let permittedMembershipId: string;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.query("INSERT INTO tenancy.tenants(id,name,slug,status,plan_code) VALUES($1,'Review Auth',$2,'active','test')", [tenant, `review-${tenant}`]);
    await admin.query("INSERT INTO tenancy.workspaces(id,tenant_id,name,slug,status) VALUES($1,$2,'Review Auth',$3,'active')", [workspace,tenant,`review-${workspace}`]);
    for (const id of [business, foreignBusiness]) {
      await admin.query("INSERT INTO platform.businesses(id,tenant_id,workspace_id,legal_name,business_code,status) VALUES($1,$2,$3,'Review Auth',$4,'active')", [id,tenant,workspace,`review-${id}`]);
    }
    await admin.query(`INSERT INTO business_operations.offline_sales
      (id,tenant_id,workspace_id,business_id,client_sale_id,device_id,claimed_register_session_id,outcome,review_reason,currency_code,
       device_created_at,clock_skew_seconds,catalogue_snapshot_at,device_total_minor,request_digest,lines_detail)
      VALUES($1,$2,$3,$4,$5,'synthetic',$6,'needs_review','underpaid','KWD',now(),0,now(),100,$7,'[]')`,
    [intake,tenant,workspace,business,randomUUID(),randomUUID(),'a'.repeat(64)]);
    const users = new UserRepository(); const memberships = new MembershipRepository(); const authz = new AuthorizationService();
    const makeMember = async (role: string | null) => {
      const user = await users.createUser({ email: `${randomUUID()}@example.invalid`, passwordHash: 'synthetic' });
      await users.activate(user.id);
      const ctx = { tenantId: tenant, workspaceId: workspace, userId: user.id };
      const membership = await memberships.create(ctx, user.id);
      await memberships.activate(ctx, membership.id);
      if (role) await authz.assignRole(ctx, membership.id, role);
      return { ctx, membershipId: membership.id };
    };
    const allowed = await makeMember('viewer');
    permitted = allowed.ctx;
    permittedMembershipId = allowed.membershipId;
    denied = (await makeMember(null)).ctx;
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('requires current canonical bo:read and same-business scope on every call', async () => {
    const reader = new OfflineReviewEvidenceReader();
    expect((await reader.get(permitted,business,intake))?.authority).toBe('NONAUTHORITATIVE_UNRESOLVED');
    await expect(reader.get(denied,business,intake)).rejects.toThrow();
    await expect(reader.get(permitted,randomUUID(),intake)).rejects.toThrow();
    expect(await reader.get(permitted,foreignBusiness,intake)).toBeNull();
    await new AuthorizationService().revokeRole(permitted, permittedMembershipId, 'viewer');
    await expect(reader.get(permitted,business,intake)).rejects.toThrow();
  });
});
