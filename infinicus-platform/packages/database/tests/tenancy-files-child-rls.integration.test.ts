/**
 * V-18 / migration 0212 and the service-only erasure audit trail: tenancy.membership_roles, files.file_versions and files.file_links inherit their
 * parent's tenant isolation, and the application role has no access to platform.data_deletion_events.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures, BYPASSRLS/superuser). The grant proof additionally requires psql.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MembershipRepository } from '../src/repositories/auth/MembershipRepository.js';
import { withTenantTransaction } from '../src/client.js';
import { withExclusiveLocksNoWait } from './helpers/ddlProof.js';
import { setupIntegration, endIntegration, ctx1, ctx2, T1, WS1 } from './helpers/integration.js';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '0212_enable_rls_membership_roles_and_file_children.sql';
const TABLES = ['tenancy.membership_roles', 'files.file_versions', 'files.file_links'] as const;

describe.runIf(RUN)('migration 0212: membership_roles and file children are tenant-isolated (V-18)', () => {
  let admin: Pool;
  const repo = new MembershipRepository();
  const x: Record<string, string> = {};
  const cleanup: Array<[string, string, string]> = [];   // table, id column, id

  const q = (ctx: typeof ctx1, sql: string, params: unknown[] = []) => withTenantTransaction(ctx, (c) => c.query(sql, params));
  const count = async (ctx: typeof ctx1, table: string) => (await q(ctx, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  const ins = async (table: string, cols: string, vals: unknown[], idCol = 'id') => {
    const r = await admin.query(`INSERT INTO ${table} (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${idCol} AS id`, vals);
    cleanup.unshift([table, idCol, r.rows[0].id]);
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    await setupIntegration();
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    const user = await ins('identity.users', 'email', [`rls-${randomUUID().slice(0, 8)}@example.test`]);
    x.membership = await ins('tenancy.memberships', 'tenant_id,workspace_id,user_id,status', [T1, WS1, user, 'active']);
    x.role = await ins('tenancy.roles', 'code,name,scope', [`rls-role-${randomUUID().slice(0, 8)}`, 'rls role', 'workspace']);
    await admin.query('INSERT INTO tenancy.membership_roles (membership_id, role_id) VALUES ($1,$2)', [x.membership, x.role]);
    cleanup.unshift(['tenancy.membership_roles', 'membership_id', x.membership]);
    x.file = await ins('files.file_objects', 'tenant_id,storage_provider,bucket_name,object_key,original_filename,media_type,size_bytes,sha256_hash',
      [T1, 'test', 'b', `k-${randomUUID()}`, 'f.txt', 'text/plain', 1, 'a'.repeat(64)]);
    x.version = await ins('files.file_versions', 'file_object_id,version,object_key,size_bytes,sha256_hash', [x.file, 1, 'k1', 1, 'a'.repeat(64)]);
    x.link = await ins('files.file_links', 'file_object_id,entity_type,entity_id,relationship_type', [x.file, 'order', randomUUID(), 'attachment']);
  });

  afterAll(async () => {
    for (const [table, idCol, id] of cleanup) await admin.query(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]).catch(() => undefined);
    await admin.end();
    await endIntegration();
  });

  it('RLS is enabled with one parent-derived isolation policy on each table (not forced, so owner and admin authority is unchanged)', async () => {
    const r = await admin.query(
      `SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname || '.' || c.relname = ANY($1) ORDER BY 1`, [[...TABLES]]);
    expect(r.rows).toHaveLength(TABLES.length);
    for (const row of r.rows) expect(row, row.t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: false, policies: 1 });
  });

  for (const [table, key] of [['tenancy.membership_roles', 'membership_id'], ['files.file_versions', 'id'], ['files.file_links', 'id']] as const) {
    const rowId = () => (table === 'tenancy.membership_roles' ? x.membership : table === 'files.file_versions' ? x.version : x.link);
    it(`${table}: the owning tenant sees its row; another tenant sees nothing and can neither change nor delete it`, async () => {
      expect(await count(ctx1, table)).toBeGreaterThanOrEqual(1);
      expect(await count(ctx2, table)).toBe(0);
      const upd = await q(ctx2, `UPDATE ${table} SET ${key} = ${key} WHERE ${key} = $1`, [rowId()]);
      expect(upd.rowCount).toBe(0);
      const del = await q(ctx2, `DELETE FROM ${table} WHERE ${key} = $1`, [rowId()]);
      expect(del.rowCount).toBe(0);
      expect((await admin.query(`SELECT 1 FROM ${table} WHERE ${key} = $1`, [rowId()])).rowCount).toBe(1);
    });
  }

  it('fails closed: with no usable tenant context nothing is visible', async () => {
    const stranger = { tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() };
    for (const t of TABLES) expect(await count(stranger, t), t).toBe(0);
  });

  it('another tenant cannot attach a child row to a parent it cannot see (WITH CHECK)', async () => {
    await expect(q(ctx2, 'INSERT INTO tenancy.membership_roles (membership_id, role_id) SELECT $1, id FROM tenancy.roles LIMIT 1', [x.membership]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(q(ctx2, `INSERT INTO files.file_links (file_object_id, entity_type, entity_id, relationship_type) VALUES ($1,'order',$2,'x')`, [x.file, randomUUID()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(q(ctx2, `INSERT INTO files.file_versions (file_object_id, version, object_key, size_bytes, sha256_hash) VALUES ($1,2,'k2',1,$2)`, [x.file, 'b'.repeat(64)]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('legitimate access is unchanged: the owning tenant lists, assigns and revokes roles through MembershipRepository', async () => {
    expect(await repo.listRoleIds(ctx1, x.membership)).toEqual([x.role]);
    await repo.revokeRole(ctx1, x.membership, x.role);
    expect(await repo.listRoleIds(ctx1, x.membership)).toEqual([]);
    await repo.assignRole(ctx1, x.membership, x.role);
    expect(await repo.listRoleIds(ctx1, x.membership)).toEqual([x.role]);
    expect(await repo.listRoleIds(ctx2, x.membership)).toEqual([]);          // another tenant sees no assignment for it
    await expect(repo.assignRole(ctx2, x.membership, x.role)).rejects.toMatchObject({ code: '42501' });   // ... and cannot create one for it
  }, 15000);

  it('the documented rollback removes exactly the policies and RLS flags, proven inside a transaction that is rolled back', async () => {
    const sql = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations', MIGRATION), 'utf8');
    const stmts = sql.split('\n').filter((l) => /^-- {3}(DROP POLICY|ALTER TABLE)/.test(l)).map((l) => l.slice(5));
    expect(stmts).toHaveLength(6);
    // Locked up front with NOWAIT (helpers/ddlProof.ts): the proof never waits in a lock queue, so it cannot deadlock or stall other tests.
    await withExclusiveLocksNoWait(admin, { tables: [...TABLES] }, async (c) => {
      for (const s of stmts) await c.query(s);
      const flags = await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = ANY($1) AND c.relrowsecurity`, [[...TABLES]]);
      const pols = await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname || '.' || tablename = ANY($1)`, [[...TABLES]]);
      expect(flags.rows[0].n).toBe(0);
      expect(pols.rows[0].n).toBe(0);
    });
    const after = await admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = ANY($1) AND c.relrowsecurity`, [[...TABLES]]);
    expect(after.rows[0].n).toBe(TABLES.length);
  });
});

describe.runIf(RUN)('platform.data_deletion_events is service-only (V-18)', () => {
  let admin: Pool;
  let app: Pool;
  const tenant = randomUUID();
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await admin.query('DELETE FROM platform.data_deletion_events WHERE tenant_id = $1', [tenant]).catch(() => undefined);
    await admin.end(); await app.end();
  });

  it('the application role can neither read, write nor delete the erasure audit trail; the admin connection still can', async () => {
    const ins = await admin.query('INSERT INTO platform.data_deletion_events (tenant_id, tenant_name, deleted_by) VALUES ($1,$2,$3) RETURNING id', [tenant, 'gone', 'test']);
    expect(ins.rowCount).toBe(1);
    await expect(app.query('SELECT 1 FROM platform.data_deletion_events LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('INSERT INTO platform.data_deletion_events (tenant_id, deleted_by) VALUES ($1,$2)', [tenant, 'forged'])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('UPDATE platform.data_deletion_events SET deleted_by = $2 WHERE tenant_id = $1', [tenant, 'rewritten'])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('DELETE FROM platform.data_deletion_events WHERE tenant_id = $1', [tenant])).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query('SELECT deleted_by FROM platform.data_deletion_events WHERE tenant_id = $1', [tenant])).rows).toEqual([{ deleted_by: 'test' }]);
  });
});
