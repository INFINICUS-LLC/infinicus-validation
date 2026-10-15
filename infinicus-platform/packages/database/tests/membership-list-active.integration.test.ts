/**
 * NA-04 / migration 0199 - tenancy.list_active_memberships and MembershipRepository.listActiveForUser. Real PostgreSQL, application role (RLS applies to
 * the role; the function is SECURITY DEFINER). The function is the ONLY cross-workspace read of memberships, so the tests prove what it returns and,
 * more importantly, what it refuses to return.
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures). Guard: describe.runIf(!!DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, getPool } from '../src/client.js';
import { UserRepository, MembershipRepository } from '../src/repositories/auth/index.js';

const run = !!process.env.DATABASE_URL;
const repo = new MembershipRepository();
let admin: Pool;

const mk = () => ({ tenant: randomUUID(), ws: randomUUID(), ws2: randomUUID() });
const email = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@na04-test.example`;

async function user() {
  const u = await new UserRepository().createUser({ email: email('u'), passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
  return new UserRepository().activate(u.id);
}
async function seedTenant(ids: ReturnType<typeof mk>, name: string, opts: { tenantStatus?: string; deleted?: boolean } = {}) {
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,$4,'test')`,
    [ids.tenant, name, `na04-${ids.tenant.slice(0, 8)}`, opts.tenantStatus ?? 'active']);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active'),($5,$2,$6,$7,'active')`,
    [ids.ws, ids.tenant, `${name} WS A`, 'a', ids.ws2, `${name} WS B`, 'b']);
  if (opts.deleted) await admin.query(`UPDATE tenancy.tenants SET deleted_at = now() WHERE id = $1`, [ids.tenant]);
}
async function member(ids: ReturnType<typeof mk>, workspace: string, userId: string, status = 'active') {
  await admin.query(`INSERT INTO tenancy.memberships (tenant_id, workspace_id, user_id, status) VALUES ($1,$2,$3,$4)`, [ids.tenant, workspace, userId, status]);
}

describe.runIf(run)('NA-04 0199 list_active_memberships (live PostgreSQL)', () => {
  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  });
  afterAll(async () => { await admin.end(); await closePool(); });

  it("returns exactly the user's ACTIVE memberships across tenants, with ids, names and statuses only", async () => {
    const a = mk(), b = mk(); const u = await user(); const other = await user();
    await seedTenant(a, 'Alpha Co'); await seedTenant(b, 'Beta Co');
    await member(a, a.ws, u.id); await member(a, a.ws2, u.id); await member(b, b.ws, u.id);
    await member(a, a.ws, other.id);                      // another user's membership in the same workspace

    const rows = await repo.listActiveForUser(u.id);
    expect(rows.map((r) => [r.tenantName, r.workspaceName]).sort()).toEqual([['Alpha Co', 'Alpha Co WS A'], ['Alpha Co', 'Alpha Co WS B'], ['Beta Co', 'Beta Co WS A']]);
    expect(rows.every((r) => r.tenantStatus === 'active' && r.workspaceStatus === 'active')).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(['joinedAt', 'tenantId', 'tenantName', 'tenantStatus', 'workspaceId', 'workspaceName', 'workspaceStatus']);
    // nothing of the other user leaks
    expect(JSON.stringify(rows)).not.toContain(other.id);
    expect(JSON.stringify(rows)).not.toContain(other.email);
  });

  it('does not return invited, suspended or removed memberships, nor memberships of a deleted tenant', async () => {
    const a = mk(), gone = mk(); const u = await user();
    await seedTenant(a, 'Gamma Co'); await seedTenant(gone, 'Gone Co', { deleted: true });
    await member(a, a.ws, u.id, 'invited'); await member(a, a.ws2, u.id, 'suspended'); await member(gone, gone.ws, u.id);
    expect(await repo.listActiveForUser(u.id)).toEqual([]);
    await admin.query(`UPDATE tenancy.memberships SET status='removed' WHERE user_id=$1 AND workspace_id=$2`, [u.id, a.ws2]);
    expect(await repo.listActiveForUser(u.id)).toEqual([]);
  });

  it('a user with no membership gets an empty list, not an error', async () => {
    expect(await repo.listActiveForUser((await user()).id)).toEqual([]);
  });

  it("refuses to list another user's memberships: the argument must equal the transaction's app.user_id", async () => {
    const a = mk(); const u = await user(); const victim = await user();
    await seedTenant(a, 'Delta Co'); await member(a, a.ws, victim.id);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await expect(client.query('SELECT * FROM tenancy.list_active_memberships($1)', [victim.id])).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');                                       // no app.user_id at all
      await expect(client.query('SELECT * FROM tenancy.list_active_memberships($1)', [victim.id])).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');                                       // NULL argument
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await expect(client.query('SELECT * FROM tenancy.list_active_memberships(NULL)')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it("the application role still cannot read memberships across workspaces directly (the table policy is unchanged)", async () => {
    const a = mk(); const u = await user();
    await seedTenant(a, 'Epsilon Co'); await member(a, a.ws, u.id);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const direct = await client.query('SELECT 1 FROM tenancy.memberships WHERE user_id = $1', [u.id]);
      expect(direct.rows).toHaveLength(0);                                 // no tenant context -> RLS returns nothing
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('is read-only and not callable by PUBLIC (EXECUTE revoked from PUBLIC, STABLE, SECURITY DEFINER with a pinned search_path)', async () => {
    const r = await admin.query(
      `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='tenancy' AND p.proname='list_active_memberships'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].provolatile).toBe('s');
    expect(r.rows[0].public_exec).toBe(false);
    expect(r.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
  });
});
