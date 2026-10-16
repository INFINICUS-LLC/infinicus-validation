/**
 * F-NA05-4 / migration 0201 - monitored_action_versions and monitored_action_status_history cannot reference a monitored action of another
 * tenant, workspace or business. Real PostgreSQL, application role (RLS applies), raw SQL and the repository: no application guard is involved,
 * so every refusal below is the database's own. Each negative test fails if the composite foreign key is absent.
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures, catalog reads).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, withTenantTransaction, UserRepository, MembershipRepository, MonitoredActionRepository, type TenantContext } from '@infinicus/database';
import { createMonitoredAction } from './helpers/omFixtures.js';
import { uc } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;
const OM = 'outcome_monitoring';
const TABLES = [
  { table: 'monitored_action_versions', fk: 'monitored_action_versions_monitored_action_scope_fkey' },
  { table: 'monitored_action_status_history', fk: 'monitored_action_status_history_monitored_action_scope_fkey' },
] as const;
let admin: Pool;
interface Scope { ctx: TenantContext; bizId: string; actionId: string }

async function user(): Promise<string> {
  const u = await new UserRepository().createUser({ email: `${uc('f4')}@f4.example`, passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
  return (await new UserRepository().activate(u.id)).id;
}
async function tenant(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'F4 Tenant',$2,'active','test')`, [id, uc('f4t')]);
  return id;
}
async function workspace(tenantId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'F4 WS',$3,'active')`, [id, tenantId, uc('f4w')]);
  return id;
}
async function business(ctx: TenantContext): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'F4 Biz',$4,'active')`, [id, ctx.tenantId, ctx.workspaceId, uc('f4b')]);
  return id;
}
async function scope(ctx: TenantContext): Promise<Scope> {
  const m = new MembershipRepository(); const row = await m.create(ctx, ctx.userId); await m.activate(ctx, row.id);
  const bizId = await business(ctx);
  return { ctx, bizId, actionId: await createMonitoredAction(ctx, bizId) };
}
const count = async (table: string) => Number((await admin.query(`SELECT count(*)::int n FROM ${OM}.${table}`)).rows[0].n);

/** Raw INSERT as the application role in the caller's tenant context, bypassing every application guard. */
const insertChild = (table: string, ctx: TenantContext, businessId: string, monitoredActionId: string) =>
  withTenantTransaction(ctx, (c) => table === 'monitored_action_versions'
    ? c.query(`INSERT INTO ${OM}.monitored_action_versions (tenant_id, workspace_id, business_id, monitored_action_id, version_number, description) VALUES ($1,$2,$3,$4,99,'f4') RETURNING id`, [ctx.tenantId, ctx.workspaceId, businessId, monitoredActionId])
    : c.query(`INSERT INTO ${OM}.monitored_action_status_history (tenant_id, workspace_id, business_id, monitored_action_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,'pending','in_progress','f4') RETURNING id`, [ctx.tenantId, ctx.workspaceId, businessId, monitoredActionId]));

describe.runIf(run)('F-NA05-4 0201 monitored-action child-table scope integrity (live PostgreSQL, application role)', () => {
  let a: Scope; let sibling: Scope; let otherWs: Scope; let otherTenant: Scope;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    const uid = await user();
    const t1 = await tenant(); const ws1 = await workspace(t1); const ws2 = await workspace(t1);
    a = await scope({ tenantId: t1, workspaceId: ws1, userId: uid });
    const sibBiz = await business(a.ctx);
    sibling = { ctx: a.ctx, bizId: sibBiz, actionId: await createMonitoredAction(a.ctx, sibBiz) };
    otherWs = await scope({ tenantId: t1, workspaceId: ws2, userId: uid });
    const t2 = await tenant(); const ws3 = await workspace(t2);
    otherTenant = await scope({ tenantId: t2, workspaceId: ws3, userId: uid });
  }, 240_000);
  afterAll(async () => { await admin?.end(); await closePool(); });

  describe.each(TABLES)('$table', ({ table, fk }) => {
    it('a monitored action of the SAME tenant, workspace and business is accepted', async () => {
      expect((await insertChild(table, a.ctx, a.bizId, a.actionId)).rows).toHaveLength(1);
    });

    it.each([
      ['a different business in the same workspace', () => sibling.actionId],
      ['a different workspace of the same tenant', () => otherWs.actionId],
      ['a different tenant', () => otherTenant.actionId],
    ])('%s is rejected by the database (23503) and leaves no row', async (_n, pick) => {
      const before = await count(table);
      await expect(insertChild(table, a.ctx, a.bizId, pick())).rejects.toMatchObject({ code: '23503', constraint: fk });
      expect(await count(table)).toBe(before);
    });

    it('a nonexistent monitored action is rejected and leaves no row', async () => {
      const before = await count(table);
      await expect(insertChild(table, a.ctx, a.bizId, randomUUID())).rejects.toMatchObject({ code: '23503' });
      expect(await count(table)).toBe(before);
    });

    it('RLS still hides the foreign action from the application role while the database refuses the reference', async () => {
      const seen = await withTenantTransaction(a.ctx, (c) => c.query(`SELECT 1 FROM ${OM}.monitored_actions WHERE id = $1`, [otherTenant.actionId]));
      expect(seen.rows).toHaveLength(0);
      await expect(insertChild(table, a.ctx, a.bizId, otherTenant.actionId)).rejects.toMatchObject({ code: '23503' });
    });

    it('stays append-only: UPDATE and DELETE are refused', async () => {
      await expect(admin.query(`UPDATE ${OM}.${table} SET created_at = now() WHERE monitored_action_id = $1`, [a.actionId])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${OM}.${table} WHERE monitored_action_id = $1`, [a.actionId])).rejects.toThrow(/append-only/);
    });
  });

  it('the repository workflows still write consistent version and status-history rows (create, in_progress, complete)', async () => {
    const repo = new MonitoredActionRepository();
    const id = await createMonitoredAction(a.ctx, a.bizId);
    await repo.markInProgress(a.ctx, id); await repo.complete(a.ctx, id);
    const v = await admin.query(`SELECT count(*)::int n FROM ${OM}.monitored_action_versions WHERE monitored_action_id = $1`, [id]);
    const h = await admin.query(`SELECT count(*)::int n FROM ${OM}.monitored_action_status_history WHERE monitored_action_id = $1`, [id]);
    expect([v.rows[0].n, h.rows[0].n]).toEqual([1, 2]);
  });

  it('a referenced action cannot be re-scoped (the 0200 key and the new foreign keys hold it)', async () => {
    await expect(admin.query(`UPDATE ${OM}.monitored_actions SET business_id = $2 WHERE id = $1`, [a.actionId, sibling.bizId])).rejects.toMatchObject({ code: '23503' });
  });

  it('catalog: both constraints exist, validated, MATCH SIMPLE, ON DELETE RESTRICT, on the scope columns, reusing the 0200 key; old FKs kept; migration registered', async () => {
    const r = await admin.query(`SELECT conname, convalidated, confmatchtype, confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`, [TABLES.map((t) => t.fk)]);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.convalidated).toBe(true); expect(row.confmatchtype).toBe('s'); expect(row.confdeltype).toBe('r');
      expect(row.def).toContain('(monitored_action_id, tenant_id, workspace_id, business_id) REFERENCES outcome_monitoring.monitored_actions(id, tenant_id, workspace_id, business_id)');
    }
    const old = await admin.query(`SELECT conname FROM pg_constraint WHERE conname IN ('monitored_action_versions_monitored_action_id_fkey','monitored_action_status_history_monitored_action_id_fkey')`);
    expect(old.rows).toHaveLength(2);
    expect(Number((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0201_enforce_om_monitored_action_child_scope_integrity.sql'`)).rows[0].n)).toBe(1);
    const rls = await admin.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid IN ('outcome_monitoring.monitored_action_versions'::regclass,'outcome_monitoring.monitored_action_status_history'::regclass)`);
    expect(rls.rows.every((x) => x.r && x.f)).toBe(true);
  });
});
