/**
 * Data-capture follow-up - live PostgreSQL proof for migration 0184: business_operations.inventory_movements is append-only.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0184.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0184_inventory_movements_append_only.sql'), 'utf8');
const APPEND_ONLY = (op: string) => new RegExp(`business_operations\\.inventory_movements: append-only table - ${op} is not permitted`);
const T = 'business_operations.inventory_movements';

describe.runIf(run)('inventory_movements is append-only (0184) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let t = ''; let ws = ''; let biz = ''; let item = ''; let wh = ''; let otherT = ''; let otherWs = ''; let emp = '';
  let rowId = ''; let costRowId = '';

  const insertMovement = (over: Record<string, unknown> = {}, pool: Pool = admin) => {
    const r: Record<string, unknown> = { tenant_id: t, workspace_id: ws, business_id: biz, inventory_item_id: item, warehouse_id: wh, movement_type: 'receipt', quantity: 5, ...over };
    const cols = Object.keys(r);
    return pool.query(`INSERT INTO ${T} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, cols.map((c) => r[c]));
  };
  /** Runs `fn` as the RLS-confined application role inside a rolled-back transaction scoped to a tenant/workspace. */
  const asApp = async <R>(tenant: string, workspace: string, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [tenant, workspace]);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };
  const snapshot = async (): Promise<string> =>
    (await admin.query(`SELECT md5(string_agg(to_jsonb(m)::text, '|' ORDER BY id)) h, count(*)::int n FROM ${T} m WHERE tenant_id = $1`, [t])).rows[0].h;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    t = randomUUID(); ws = randomUUID(); biz = randomUUID(); item = randomUUID(); wh = randomUUID(); otherT = randomUUID(); otherWs = randomUUID(); emp = randomUUID();
    for (const [tt, ww] of [[t, ws], [otherT, otherWs]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Append Only 0184',$2,'active','test')`, [tt, `ao-${tt}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ww, tt, `ws-${ww}`]);
    }
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'AO Biz',$4,'active')`, [biz, t, ws, `ao-${biz}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [item, t, ws, biz, `sku-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [wh, t, ws, biz, `wh-${wh}`]);
    await admin.query(`INSERT INTO platform.employees (id, tenant_id, workspace_id, business_id, employee_code, display_name, status) VALUES ($1,$2,$3,$4,$5,'Actor','active')`, [emp, t, ws, biz, `e-${emp.slice(0, 8)}`]);
    rowId = (await insertMovement({ movement_type: 'issue', quantity: 3, notes: 'historic' })).rows[0].id;
    costRowId = (await insertMovement({ quantity: 10, unit_cost: 4.25, unit_cost_currency: 'EUR', performed_by: emp })).rows[0].id;
  });
  afterAll(async () => {
    await deleteMovementsForTenants(admin, [t, otherT]);
    await admin.query(`DELETE FROM platform.employees WHERE id = $1`, [emp]);
    await closePool(); await admin.end(); await app.end();
  });

  describe('the guard: the established trigger pattern, on every role', () => {
    it('exactly two non-internal triggers exist, both enabled, both using business_operations.forbid_mutation', async () => {
      const q = `SELECT t.tgname, p.proname, n.nspname, (t.tgtype & 1) = 1 AS per_row, (t.tgtype & 32) = 32 AS on_truncate,
                        (t.tgtype & 4) = 4 AS on_insert, (t.tgtype & 8) = 8 AS on_delete, (t.tgtype & 16) = 16 AS on_update, (t.tgtype & 2) = 2 AS before_, t.tgenabled
                   FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE t.tgrelid = '${T}'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`;
      expect((await admin.query(q)).rows).toEqual([
        { tgname: 'forbid_mutation_inventory_movements', proname: 'forbid_mutation', nspname: 'business_operations', per_row: true, on_truncate: false, on_insert: false, on_delete: true, on_update: true, before_: true, tgenabled: 'O' },
        { tgname: 'forbid_truncate_inventory_movements', proname: 'forbid_mutation', nspname: 'business_operations', per_row: false, on_truncate: true, on_insert: false, on_delete: false, on_update: false, before_: true, tgenabled: 'O' },
      ]);
    });

    it('UPDATE of each evidence column is refused for the admin role and the application role', async () => {
      const edits: [string, unknown][] = [['unit_cost', 99], ['unit_cost_currency', 'USD'], ['quantity', 999], ['movement_type', 'adjustment'], ['notes', 'rewritten'],
        ['occurred_at', '2001-01-01T00:00:00Z'], ['reference_type', 'manual'], ['warehouse_id', wh], ['correlation_id', randomUUID()]];
      for (const [col, val] of edits) {
        await expect(admin.query(`UPDATE ${T} SET ${col} = $1 WHERE id = $2`, [val, costRowId]), `admin ${col}`).rejects.toThrow(APPEND_ONLY('UPDATE'));
        await asApp(t, ws, async (q) => { await expect(q(`UPDATE ${T} SET ${col} = $1 WHERE id = $2`, [val, costRowId]), `app ${col}`).rejects.toThrow(APPEND_ONLY('UPDATE')); });
      }
    });

    it('UPDATE that edits unit_cost and its currency together, or touches every row, is refused', async () => {
      await expect(admin.query(`UPDATE ${T} SET unit_cost = 1, unit_cost_currency = 'JPY' WHERE id = $1`, [costRowId])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      await expect(admin.query(`UPDATE ${T} SET quantity = quantity WHERE tenant_id = $1`, [t])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      await expect(admin.query(`UPDATE ${T} SET quantity = quantity`)).rejects.toThrow(APPEND_ONLY('UPDATE'));
    });

    it('DELETE is refused for the admin role and the application role, single row or bulk', async () => {
      await expect(admin.query(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('DELETE'));
      await expect(admin.query(`DELETE FROM ${T} WHERE tenant_id = $1`, [t])).rejects.toThrow(APPEND_ONLY('DELETE'));
      await asApp(t, ws, async (q) => {
        await expect(q(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('DELETE'));
      });
      await asApp(t, ws, async (q) => { await expect(q(`DELETE FROM ${T}`)).rejects.toThrow(APPEND_ONLY('DELETE')); });
    });

    it('TRUNCATE (plain and CASCADE) is refused for the admin role and the application role', async () => {
      await expect(admin.query(`TRUNCATE ${T}`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await expect(admin.query(`TRUNCATE ${T} CASCADE`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await expect(admin.query(`TRUNCATE ${T} RESTART IDENTITY`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await asApp(t, ws, async (q) => { await expect(q(`TRUNCATE ${T}`)).rejects.toThrow(); });
    });

    it('historical rows are byte-for-byte unchanged after every refused attempt', async () => {
      const before = await snapshot();
      await admin.query(`UPDATE ${T} SET quantity = 0 WHERE id = $1`, [rowId]).catch(() => undefined);
      await admin.query(`DELETE FROM ${T} WHERE id = $1`, [rowId]).catch(() => undefined);
      await admin.query(`TRUNCATE ${T}`).catch(() => undefined);
      expect(await snapshot()).toBe(before);
      const r = (await admin.query(`SELECT quantity::text q, movement_type, notes FROM ${T} WHERE id = $1`, [rowId])).rows[0];
      expect(r).toEqual({ q: '3.0000', movement_type: 'issue', notes: 'historic' });
      const c = (await admin.query(`SELECT quantity::text q, unit_cost::text uc, unit_cost_currency cur, performed_by FROM ${T} WHERE id = $1`, [costRowId])).rows[0];
      expect(c).toEqual({ q: '10.0000', uc: '4.2500', cur: 'EUR', performed_by: emp });
    });

    it('a failed UPDATE inside a transaction leaves no partial effect and the row stays readable', async () => {
      const before = await snapshot();
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await expect(c.query(`UPDATE ${T} SET quantity = 1 WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('UPDATE'));
        await c.query('ROLLBACK');
      } finally { c.release(); }
      expect(await snapshot()).toBe(before);
    });

    it('the application role cannot suspend the guard: session_replication_role and trigger DDL are not available to it', async () => {
      await expect(app.query(`SET session_replication_role = 'replica'`)).rejects.toThrow(/permission denied/i);
      await expect(app.query(`ALTER TABLE ${T} DISABLE TRIGGER forbid_mutation_inventory_movements`)).rejects.toThrow(/must be owner|permission denied/i);
      await expect(app.query(`DROP TRIGGER forbid_mutation_inventory_movements ON ${T}`)).rejects.toThrow(/must be owner|permission denied/i);
      await expect(app.query(`ALTER TABLE ${T} DISABLE TRIGGER ALL`)).rejects.toThrow(/must be owner|permission denied/i);
    });

    it('the application role does not own the table', async () => {
      const r = (await admin.query(`SELECT pg_get_userbyid(c.relowner) AS owner, current_setting('is_superuser') su FROM pg_class c WHERE c.oid = '${T}'::regclass`)).rows[0];
      const appName = (await app.query(`SELECT current_user u`)).rows[0].u;
      expect(r.owner).not.toBe(appName);
    });
  });

  describe('INSERT and Block C behaviour are unchanged', () => {
    it('plain INSERT succeeds for the admin role and for the RLS-confined application role', async () => {
      expect((await insertMovement({ movement_type: 'issue', quantity: 1 })).rows).toHaveLength(1);
      await asApp(t, ws, async (q) => {
        const r = await q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity) VALUES ($1,$2,$3,$4,$5,'issue',2) RETURNING id`, [t, ws, biz, item, wh]);
        expect(r.rows).toHaveLength(1);
      });
    });

    it('a cost with an explicit currency still inserts; a cost without a currency (and the reverse) is still refused; format still enforced', async () => {
      expect((await insertMovement({ unit_cost: 2.5, unit_cost_currency: 'GBP' })).rows).toHaveLength(1);
      await expect(insertMovement({ unit_cost: 5 })).rejects.toThrow(/inventory_movements_unit_cost_currency_presence/);
      await expect(insertMovement({ unit_cost_currency: 'USD' })).rejects.toThrow(/inventory_movements_unit_cost_currency_presence/);
      await expect(insertMovement({ unit_cost: 1, unit_cost_currency: 'usd' })).rejects.toThrow(/inventory_movements_unit_cost_currency_format/);
    });

    it('the Block C constraints are exactly as before (presence NOT VALID, format valid)', async () => {
      const c = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname LIKE 'inventory_movements_unit_cost_currency_%' ORDER BY conname`)).rows;
      expect(c).toEqual([
        { conname: 'inventory_movements_unit_cost_currency_format', convalidated: true },
        { conname: 'inventory_movements_unit_cost_currency_presence', convalidated: false },
      ]);
    });

    it('a compensating correction is a new movement: appending an adjustment works and leaves the original untouched', async () => {
      const before = (await admin.query(`SELECT to_jsonb(m)::text j FROM ${T} m WHERE id = $1`, [rowId])).rows[0].j;
      await insertMovement({ movement_type: 'adjustment', quantity: 3, reference_type: 'adjustment', reference_id: rowId });
      expect((await admin.query(`SELECT to_jsonb(m)::text j FROM ${T} m WHERE id = $1`, [rowId])).rows[0].j).toBe(before);
    });
  });

  describe('RLS and tenant isolation are unchanged', () => {
    it('policy text is the original tenant+workspace policy and FORCE RLS is deliberately not changed here', async () => {
      const f = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0];
      expect(f).toEqual({ relrowsecurity: true, relforcerowsecurity: false });
      const pol = (await admin.query(`SELECT policyname, qual FROM pg_policies WHERE schemaname='business_operations' AND tablename='inventory_movements'`)).rows;
      expect(pol).toHaveLength(1);
      expect(pol[0].policyname).toBe('inventory_movements_isolation');
      expect(pol[0].qual).toMatch(/tenant_id = .*app\.tenant_id.*AND.*workspace_id = .*app\.workspace_id/s);
    });

    it('another tenant sees none of this tenant\'s movements and cannot insert into it', async () => {
      await asApp(otherT, otherWs, async (q) => {
        expect((await q(`SELECT id FROM ${T} WHERE id = $1`, [costRowId])).rows).toEqual([]);
        await expect(q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity) VALUES ($1,$2,$3,$4,$5,'issue',1)`, [t, ws, biz, item, wh])).rejects.toThrow();
      });
      await asApp(t, ws, async (q) => { expect((await q(`SELECT unit_cost_currency FROM ${T} WHERE id = $1`, [costRowId])).rows).toEqual([{ unit_cost_currency: 'EUR' }]); });
    });

    it('another tenant\'s UPDATE and DELETE touch nothing (RLS hides the row; no mutation path appears)', async () => {
      const before = await snapshot();
      await asApp(otherT, otherWs, async (q) => {
        expect((await q(`UPDATE ${T} SET quantity = 0 WHERE id = $1`, [costRowId])).rowCount).toBe(0);
        expect((await q(`DELETE FROM ${T} WHERE id = $1`, [costRowId])).rowCount).toBe(0);
      });
      expect(await snapshot()).toBe(before);
    });
  });

  describe('referential actions and test infrastructure', () => {
    it('deleting an employee referenced by a movement is refused (the SET NULL referential action is an UPDATE)', async () => {
      await expect(admin.query(`DELETE FROM platform.employees WHERE id = $1`, [emp])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      expect((await admin.query(`SELECT performed_by FROM ${T} WHERE id = $1`, [costRowId])).rows[0].performed_by).toBe(emp);
    });

    it('every other foreign key from the movement table is ON DELETE RESTRICT (no cascade can delete evidence)', async () => {
      const r = (await admin.query(`SELECT confdeltype, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = '${T}'::regclass AND contype = 'f' ORDER BY d`)).rows;
      const nonRestrict = r.filter((x: { confdeltype: string }) => x.confdeltype !== 'r').map((x: { d: string }) => x.d);
      expect(nonRestrict).toHaveLength(1);
      expect(nonRestrict[0]).toMatch(/performed_by.*ON DELETE SET NULL/);
    });

    it('the approved test-cleanup helper removes only the named tenants\' movements, through the superuser-only replica switch', async () => {
      const scratchT = randomUUID(); const scratchW = randomUUID(); const scratchB = randomUUID(); const scratchI = randomUUID(); const scratchH = randomUUID();
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Scratch 0184',$2,'active','test')`, [scratchT, `sc-${scratchT}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [scratchW, scratchT, `ws-${scratchW}`]);
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'S',$4,'active')`, [scratchB, scratchT, scratchW, `s-${scratchB}`]);
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'I')`, [scratchI, scratchT, scratchW, scratchB, `sku-${scratchI}`]);
      await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'W')`, [scratchH, scratchT, scratchW, scratchB, `wh-${scratchH}`]);
      await insertMovement({ tenant_id: scratchT, workspace_id: scratchW, business_id: scratchB, inventory_item_id: scratchI, warehouse_id: scratchH });
      const before = await snapshot();
      await deleteMovementsForTenants(admin, [scratchT]);
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE tenant_id = $1`, [scratchT])).rows[0].n).toBe(0);
      expect(await snapshot()).toBe(before);
      // the helper does not leave the session in replica mode: the guard is active again on the same pool
      await expect(admin.query(`DELETE FROM ${T} WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY('DELETE'));
    });
  });

  describe('migration safety', () => {
    it('re-applying the migration is idempotent: same two triggers, one registration, rows untouched', async () => {
      const before = await snapshot();
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal`)).rows[0].n).toBe(2);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0184_inventory_movements_append_only.sql'`)).rows[0].n).toBe(1);
      expect(await snapshot()).toBe(before);
    });

    it('the other append-only table sharing the function (0182) is still guarded after re-declaring it', async () => {
      const n = (await admin.query(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'forbid_mutation' AND p.pronamespace = 'business_operations'::regnamespace AND NOT t.tgisinternal`)).rows[0].n;
      expect(n).toBeGreaterThanOrEqual(4); // 2 for inventory_policy_evaluations (0182) + 2 for inventory_movements (0184)
    });
  });
});
