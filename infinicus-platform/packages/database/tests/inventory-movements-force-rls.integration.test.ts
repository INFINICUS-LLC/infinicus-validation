/**
 * inventory_movements FORCE RLS (0186) - live PostgreSQL proof.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0186.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0186_force_rls_inventory_movements.sql'), 'utf8');
const T = 'business_operations.inventory_movements';
const OWNER_ROLE = 'force_rls_test_owner';
const APPEND_ONLY = (op: string) => new RegExp(`business_operations\\.inventory_movements: append-only table - ${op} is not permitted`);

describe.runIf(run)('inventory_movements FORCE RLS (0186) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let t = ''; let ws = ''; let biz = ''; let item = ''; let wh = ''; let otherT = ''; let otherWs = ''; let rowId = '';

  const insertAdmin = (over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { tenant_id: t, workspace_id: ws, business_id: biz, inventory_item_id: item, warehouse_id: wh, movement_type: 'receipt', quantity: 5, ...over };
    const cols = Object.keys(r);
    return admin.query(`INSERT INTO ${T} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, cols.map((c) => r[c]));
  };
  /** The RLS-confined application role, scoped to a tenant/workspace (or to nothing when both are null). */
  const asApp = async <R>(scope: { t: string; ws: string } | null, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (scope) await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [scope.t, scope.ws]);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };
  /**
   * Acts as a NON-superuser, non-BYPASSRLS TABLE OWNER, inside a transaction that is always rolled back: the table is handed to a test role, the
   * session switches to that role (no tenant context set), `fn` runs, and everything is undone. `forced` chooses FORCE / NO FORCE for the contrast.
   */
  const asOwner = async <R>(forced: boolean, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE ${T} OWNER TO ${OWNER_ROLE}`);
      await c.query(`ALTER TABLE ${T} ${forced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`);
      await c.query(`GRANT USAGE ON SCHEMA business_operations TO ${OWNER_ROLE}`);
      await c.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };
  /** No tenant context must fail CLOSED: either zero rows or an error (an unset-then-reset GUC is '' and cannot cast to uuid) - never data. */
  const failsClosed = async (fn: () => Promise<{ rows: any[] }>) => {
    const r = await fn().then((x) => ({ rows: x.rows, error: '' }), (e: Error) => ({ rows: [] as any[], error: e.message }));
    expect(r.rows).toEqual([]);
    if (r.error) expect(r.error).toMatch(/invalid input syntax for type uuid|row-level security/i);
  };
  const snapshot = async (): Promise<string> =>
    (await admin.query(`SELECT md5(coalesce(string_agg(to_jsonb(m)::text, '|' ORDER BY id), '')) h FROM ${T} m WHERE tenant_id = $1`, [t])).rows[0].h;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    t = randomUUID(); ws = randomUUID(); biz = randomUUID(); item = randomUUID(); wh = randomUUID(); otherT = randomUUID(); otherWs = randomUUID();
    for (const [tt, ww] of [[t, ws], [otherT, otherWs]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Force RLS 0186',$2,'active','test')`, [tt, `fr-${tt}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ww, tt, `ws-${ww}`]);
    }
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'FR Biz',$4,'active')`, [biz, t, ws, `fr-${biz}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [item, t, ws, biz, `sku-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [wh, t, ws, biz, `wh-${wh}`]);
    rowId = (await insertAdmin({ movement_type: 'issue', quantity: 3, notes: 'historic' })).rows[0].id;
    await insertAdmin({ quantity: 10, unit_cost: 4.25, unit_cost_currency: 'EUR' });
  });
  afterAll(async () => {
    await deleteMovementsForTenants(admin, [t, otherT]);
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => undefined);
    await closePool(); await admin.end(); await app.end();
  });

  describe('RLS state and policy', () => {
    it('RLS is enabled AND forced', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('the policy is unchanged: one permissive FOR ALL policy for public on tenant AND workspace, nothing else', async () => {
      const pol = (await admin.query(`SELECT policyname, permissive, roles::text r, cmd, qual, with_check FROM pg_policies WHERE schemaname='business_operations' AND tablename='inventory_movements'`)).rows;
      expect(pol).toHaveLength(1);
      expect(pol[0]).toMatchObject({ policyname: 'inventory_movements_isolation', permissive: 'PERMISSIVE', r: '{public}', cmd: 'ALL', with_check: null });
      expect(pol[0].qual).toBe("((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid) AND (workspace_id = (current_setting('app.workspace_id'::text, true))::uuid))");
    });

    it('the application role is not the owner, not a superuser and not BYPASSRLS (so RLS already applied to it)', async () => {
      const r = (await admin.query(`SELECT r.rolname, r.rolsuper, r.rolbypassrls, (c.relowner = r.oid) AS owns
        FROM pg_roles r, pg_class c WHERE c.oid = '${T}'::regclass AND r.rolname = (SELECT current_user FROM (SELECT 1) x WHERE false) IS NOT TRUE AND r.rolname = $1`, [(await app.query(`SELECT current_user u`)).rows[0].u])).rows[0];
      expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, owns: false });
    });
  });

  describe('tenant / workspace scoping through the application role', () => {
    it('the correct tenant and workspace can SELECT and INSERT', async () => {
      await asApp({ t, ws }, async (q) => {
        expect((await q(`SELECT id FROM ${T} WHERE id = $1`, [rowId])).rows).toHaveLength(1);
        const ins = await q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity) VALUES ($1,$2,$3,$4,$5,'issue',1) RETURNING id`, [t, ws, biz, item, wh]);
        expect(ins.rows).toHaveLength(1);
      });
    });

    it('a wrong tenant, a wrong workspace and no tenant context at all see nothing', async () => {
      await asApp({ t: otherT, ws: otherWs }, async (q) => { expect((await q(`SELECT id FROM ${T} WHERE tenant_id = $1`, [t])).rows).toEqual([]); });
      await asApp({ t, ws: otherWs }, async (q) => { expect((await q(`SELECT id FROM ${T}`)).rows).toEqual([]); });
      await asApp({ t: otherT, ws }, async (q) => { expect((await q(`SELECT id FROM ${T}`)).rows).toEqual([]); });
      await asApp(null, async (q) => { await failsClosed(() => q(`SELECT id FROM ${T}`)); });
    });

    it('a wrong tenant / workspace / no context cannot INSERT into this tenant', async () => {
      const ins = (q: (s: string, p?: unknown[]) => Promise<any>) => q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity) VALUES ($1,$2,$3,$4,$5,'issue',1)`, [t, ws, biz, item, wh]);
      await asApp({ t: otherT, ws: otherWs }, async (q) => { await expect(ins(q)).rejects.toThrow(/row-level security/i); });
      await asApp({ t, ws: otherWs }, async (q) => { await expect(ins(q)).rejects.toThrow(/row-level security/i); });
      await asApp(null, async (q) => { await expect(ins(q)).rejects.toThrow(/row-level security|invalid input syntax for type uuid/i); });
    });

    it('a wrong tenant cannot mutate: UPDATE and DELETE match zero rows, and the content is unchanged', async () => {
      const before = await snapshot();
      await asApp({ t: otherT, ws: otherWs }, async (q) => {
        expect((await q(`UPDATE ${T} SET quantity = 0 WHERE id = $1`, [rowId])).rowCount).toBe(0);
        expect((await q(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rowCount).toBe(0);
      });
      expect(await snapshot()).toBe(before);
    });
  });

  describe('the table owner no longer bypasses RLS', () => {
    it('contrast: a non-superuser, non-BYPASSRLS OWNER sees every tenant\'s rows when RLS is NOT forced (the gap 0186 closes)', async () => {
      await asOwner(false, async (q) => { expect((await q(`SELECT count(*)::int n FROM ${T} WHERE tenant_id = $1`, [t])).rows[0].n).toBeGreaterThan(0); });
    });

    it('with FORCE the same owner sees nothing without a tenant context, only its own tenant with one, and cannot insert across tenants', async () => {
      await asOwner(true, async (q) => {
        await failsClosed(async () => ({ rows: (await q(`SELECT id FROM ${T}`)).rows }));
        await q('SAVEPOINT s0');
        await q(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [otherT, otherWs]);
        expect((await q(`SELECT count(*)::int n FROM ${T} WHERE tenant_id = $1`, [t])).rows[0].n).toBe(0);
        await q(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [t, ws]);
        expect((await q(`SELECT count(*)::int n FROM ${T} WHERE tenant_id = $1`, [t])).rows[0].n).toBeGreaterThan(0);
        await q('SAVEPOINT s');
        await expect(q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity) VALUES ($1,$2,$3,$4,$5,'issue',1)`, [otherT, otherWs, biz, item, wh])).rejects.toThrow(/row-level security/i);
      });
    });

    it('the owner test role was only ever borrowed: ownership and FORCE are back to the real values after the rolled-back transactions', async () => {
      const r = (await admin.query(`SELECT pg_get_userbyid(relowner) o, relforcerowsecurity f FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0];
      expect(r.o).not.toBe(OWNER_ROLE);
      expect(r.f).toBe(true);
    });
  });

  describe('regressions: 0184 append-only and 0183 cost/currency are unchanged', () => {
    it('UPDATE, DELETE and TRUNCATE are still refused for the admin and the application role', async () => {
      await expect(admin.query(`UPDATE ${T} SET quantity = 99 WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      await expect(admin.query(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('DELETE'));
      await expect(admin.query(`TRUNCATE ${T}`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await asApp({ t, ws }, async (q) => { await expect(q(`UPDATE ${T} SET quantity = 99 WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('UPDATE')); });
      await asApp({ t, ws }, async (q) => { await expect(q(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('DELETE')); });
      const trg = (await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
      expect(trg).toEqual([{ tgname: 'forbid_mutation_inventory_movements' }, { tgname: 'forbid_truncate_inventory_movements' }]);
    });

    it('cost/currency pairing and format are still enforced, and a paired cost still inserts', async () => {
      await expect(insertAdmin({ unit_cost: 5 })).rejects.toThrow(/unit_cost_currency_presence/);
      await expect(insertAdmin({ unit_cost_currency: 'USD' })).rejects.toThrow(/unit_cost_currency_presence/);
      await expect(insertAdmin({ unit_cost: 1, unit_cost_currency: 'usd' })).rejects.toThrow(/unit_cost_currency_format/);
      expect((await insertAdmin({ unit_cost: 2, unit_cost_currency: 'GBP' })).rows).toHaveLength(1);
      const c = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname LIKE 'inventory_movements_unit_cost_currency_%' ORDER BY conname`)).rows;
      expect(c).toEqual([{ conname: 'inventory_movements_unit_cost_currency_format', convalidated: true }, { conname: 'inventory_movements_unit_cost_currency_presence', convalidated: false }]);
    });

    it('test-only privileged cleanup still works (superuser, replica switch) and is not available to the application role', async () => {
      const t2 = randomUUID();
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Scratch 0186',$2,'active','test')`, [t2, `fr2-${t2}`]);
      const w2 = randomUUID(); const b2 = randomUUID(); const i2 = randomUUID(); const h2 = randomUUID();
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [w2, t2, `ws-${w2}`]);
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'S',$4,'active')`, [b2, t2, w2, `s-${b2}`]);
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'I')`, [i2, t2, w2, b2, `sku-${i2}`]);
      await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'W')`, [h2, t2, w2, b2, `wh-${h2}`]);
      await insertAdmin({ tenant_id: t2, workspace_id: w2, business_id: b2, inventory_item_id: i2, warehouse_id: h2 });
      await deleteMovementsForTenants(admin, [t2]);
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE tenant_id = $1`, [t2])).rows[0].n).toBe(0);
      await expect(app.query(`SET session_replication_role = 'replica'`)).rejects.toThrow(/permission denied/i);
    });
  });

  describe('history and migration safety', () => {
    it('historical rows are unchanged by (re)applying the migration', async () => {
      const before = await snapshot();
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect(await snapshot()).toBe(before);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0186_force_rls_inventory_movements.sql'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT relforcerowsecurity f FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0].f).toBe(true);
    });
  });
});
