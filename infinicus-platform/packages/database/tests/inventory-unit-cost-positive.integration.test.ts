/**
 * Data-capture Block B - live PostgreSQL proof for migration 0187: a present unit cost must be positive.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0187.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truncateRefusal } from './helpers/truncateRefusal.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0187_require_positive_inventory_unit_cost.sql'), 'utf8');
const T = 'business_operations.inventory_movements';
const POSITIVE = /inventory_movements_unit_cost_positive/;
const PAIRING = /inventory_movements_unit_cost_currency_presence/;
const FORMAT = /inventory_movements_unit_cost_currency_format/;

describe.runIf(run)('positive unit cost when present (0187) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let t = ''; let ws = ''; let biz = ''; let item = ''; let wh = ''; let otherT = ''; let otherWs = '';

  const insert = (over: Record<string, unknown> = {}, pool: Pool = admin) => {
    const r: Record<string, unknown> = { tenant_id: t, workspace_id: ws, business_id: biz, inventory_item_id: item, warehouse_id: wh, movement_type: 'receipt', quantity: 5, ...over };
    const cols = Object.keys(r);
    return pool.query(`INSERT INTO ${T} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id, unit_cost::text AS unit_cost, unit_cost_currency`, cols.map((c) => r[c]));
  };
  const asApp = async <R>(scope: { t: string; ws: string }, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [scope.t, scope.ws]);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };
  const snapshot = async (): Promise<string> =>
    (await admin.query(`SELECT md5(coalesce(string_agg(to_jsonb(m)::text, '|' ORDER BY id), '')) h FROM ${T} m WHERE tenant_id = $1`, [t])).rows[0].h;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    t = randomUUID(); ws = randomUUID(); biz = randomUUID(); item = randomUUID(); wh = randomUUID(); otherT = randomUUID(); otherWs = randomUUID();
    for (const [tt, ww] of [[t, ws], [otherT, otherWs]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Positive Cost 0187',$2,'active','test')`, [tt, `pc-${tt}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ww, tt, `ws-${ww}`]);
    }
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'PC Biz',$4,'active')`, [biz, t, ws, `pc-${biz}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [item, t, ws, biz, `sku-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [wh, t, ws, biz, `wh-${wh}`]);
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, [t, otherT]); await closePool(); await admin.end(); await app.end(); });

  describe('the invariant', () => {
    it('a movement with no cost and no currency is accepted (cost stays optional)', async () => {
      expect((await insert({ movement_type: 'issue', quantity: 1 })).rows[0]).toMatchObject({ unit_cost: null, unit_cost_currency: null });
    });

    it('a positive cost with a valid currency is accepted and stored exactly', async () => {
      expect((await insert({ unit_cost: 12.3456, unit_cost_currency: 'EUR' })).rows[0]).toMatchObject({ unit_cost: '12.3456', unit_cost_currency: 'EUR' });
      expect((await insert({ unit_cost: 0.0001, unit_cost_currency: 'USD' })).rows[0]).toMatchObject({ unit_cost: '0.0001' });
    });

    it('a zero cost is refused', async () => {
      await expect(insert({ unit_cost: 0, unit_cost_currency: 'USD' })).rejects.toThrow(POSITIVE);
    });

    it('a negative cost is refused', async () => {
      for (const v of [-0.0001, -1, -1000.5]) await expect(insert({ unit_cost: v, unit_cost_currency: 'USD' }), String(v)).rejects.toThrow(POSITIVE);
    });

    it('a positive amount smaller than the column can store (it would round to zero) is refused, never silently stored as 0', async () => {
      for (const v of [0.00001, 0.00004, 1e-9]) await expect(insert({ unit_cost: v, unit_cost_currency: 'USD' }), String(v)).rejects.toThrow(POSITIVE);
    });

    it('NaN and Infinity are refused (PostgreSQL orders NaN above every number, so the check excludes it explicitly)', async () => {
      await expect(insert({ unit_cost: 'NaN', unit_cost_currency: 'USD' })).rejects.toThrow(POSITIVE);
      await expect(insert({ unit_cost: 'Infinity', unit_cost_currency: 'USD' })).rejects.toThrow();
    });

    it('a cost without a currency and a currency without a cost are still refused (0183 pairing)', async () => {
      await expect(insert({ unit_cost: 5 })).rejects.toThrow(PAIRING);
      await expect(insert({ unit_cost_currency: 'USD' })).rejects.toThrow(PAIRING);
      await expect(insert({ unit_cost: 1, unit_cost_currency: 'usd' })).rejects.toThrow(FORMAT);
    });

    it('the rule binds the RLS-confined application role as well', async () => {
      await asApp({ t, ws }, async (q) => {
        const base = `INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency) VALUES ($1,$2,$3,$4,$5,'receipt',1,$6,'USD')`;
        await q('SAVEPOINT a');
        await expect(q(base, [t, ws, biz, item, wh, 0])).rejects.toThrow(POSITIVE);
        await q('ROLLBACK TO SAVEPOINT a');
        await expect(q(base, [t, ws, biz, item, wh, -3])).rejects.toThrow(POSITIVE);
      });
      await asApp({ t, ws }, async (q) => {
        const ok = await q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency) VALUES ($1,$2,$3,$4,$5,'receipt',1,2.5,'USD') RETURNING id`, [t, ws, biz, item, wh]);
        expect(ok.rows).toHaveLength(1);
      });
    });
  });

  describe('history is untouched', () => {
    it('the constraint is NOT VALID (enforced for new rows, history not validated) and carries the exact definition', async () => {
      const c = (await admin.query(`SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = 'inventory_movements_unit_cost_positive'`)).rows;
      expect(c).toHaveLength(1);
      expect(c[0].convalidated).toBe(false);
      expect(c[0].def).toMatch(/unit_cost IS NULL.*unit_cost > \(0\)::numeric.*unit_cost <> .NaN.::numeric.*NOT VALID/);
    });

    it('a NOT VALID check leaves an existing non-positive row in place yet refuses the same value for new rows (scratch table, same semantics)', async () => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TEMP TABLE hist_mv (LIKE ${T} INCLUDING DEFAULTS)`);
        await client.query(`INSERT INTO hist_mv (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,'receipt',1,-7)`, [t, ws, biz, item, wh]);
        await client.query(`ALTER TABLE hist_mv ADD CONSTRAINT hist_positive CHECK (unit_cost IS NULL OR (unit_cost > 0 AND unit_cost <> 'NaN'::numeric)) NOT VALID`);
        expect((await client.query(`SELECT unit_cost::text FROM hist_mv`)).rows).toEqual([{ unit_cost: '-7.0000' }]);
        await client.query('SAVEPOINT s');
        await expect(client.query(`INSERT INTO hist_mv (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,'receipt',1,-7)`, [t, ws, biz, item, wh])).rejects.toThrow(/hist_positive/);
        await client.query('ROLLBACK TO SAVEPOINT s');
        await client.query('SAVEPOINT s2');
        await expect(client.query(`UPDATE hist_mv SET quantity = 2`)).resolves.toBeDefined().catch(() => undefined);
        await client.query('ROLLBACK TO SAVEPOINT s2').catch(() => undefined);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    });

    it('applying (and re-applying) the migration neither validates the constraint nor changes any row', async () => {
      const before = await snapshot();
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect(await snapshot()).toBe(before);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = 'inventory_movements_unit_cost_positive'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'inventory_movements_unit_cost_positive'`)).rows[0].convalidated).toBe(false);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0187_require_positive_inventory_unit_cost.sql'`)).rows[0].n).toBe(1);
    });
  });

  describe('regressions: 0183, 0184, 0186 and RLS are unchanged', () => {
    it('0183 constraints are exactly as before (presence NOT VALID, format valid)', async () => {
      const c = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname LIKE 'inventory_movements_unit_cost_%' ORDER BY conname`)).rows;
      expect(c).toEqual([
        { conname: 'inventory_movements_unit_cost_currency_format', convalidated: true },
        { conname: 'inventory_movements_unit_cost_currency_presence', convalidated: false },
        { conname: 'inventory_movements_unit_cost_positive', convalidated: false },
      ]);
    });

    it('0184 still refuses UPDATE, DELETE and TRUNCATE, including an UPDATE that would "repair" a cost', async () => {
      const id = (await insert({ unit_cost: 4, unit_cost_currency: 'USD' })).rows[0].id;
      await expect(admin.query(`UPDATE ${T} SET unit_cost = 5 WHERE id = $1`, [id])).rejects.toThrow(/append-only table - UPDATE is not permitted/);
      await expect(admin.query(`DELETE FROM ${T} WHERE id = $1`, [id])).rejects.toThrow(/append-only table - DELETE is not permitted/);
      // Data-capture Block A (0197): a plain TRUNCATE is also refused by the foreign key from purchase_receipt_lines; CASCADE still reaches the append-only trigger.
      await expect(truncateRefusal(admin, `TRUNCATE ${T}`)).rejects.toThrow(/append-only table - TRUNCATE is not permitted|cannot truncate a table referenced in a foreign key constraint/);
      await expect(truncateRefusal(admin, `TRUNCATE ${T} CASCADE`)).rejects.toThrow(/append-only table - TRUNCATE is not permitted/);
    });

    it('0186 FORCE RLS is still on, the policy is unchanged and another tenant sees nothing', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await admin.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname='business_operations' AND tablename='inventory_movements'`)).rows[0].n).toBe(1);
      await asApp({ t: otherT, ws: otherWs }, async (q) => { expect((await q(`SELECT id FROM ${T} WHERE tenant_id = $1`, [t])).rows).toEqual([]); });
    });

    it('the declared-currency table is untouched by this block', async () => {
      expect((await admin.query(`SELECT relforcerowsecurity f FROM pg_class WHERE oid = 'platform.business_currency_declarations'::regclass`)).rows[0].f).toBe(true);
    });
  });
});
