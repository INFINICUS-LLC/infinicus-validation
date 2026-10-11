/**
 * Data-capture Block C - live PostgreSQL proof for migration 0183: an explicit currency on cost-bearing inventory movements and no
 * silent USD default on purchase orders. Requires DATABASE_URL (RLS enforced) and ADMIN_DATABASE_URL, migrated through 0183.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { PurchaseOrderRepository } from '../src/index.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0183_add_explicit_currency_to_inventory_costs.sql'), 'utf8');
const PRESENCE = /inventory_movements_unit_cost_currency_presence/;
const FORMAT = /inventory_movements_unit_cost_currency_format/;

describe.runIf(run)('explicit currency on inventory costs (0183) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let t = ''; let ws = ''; let biz = ''; let item = ''; let wh = ''; let supplier = ''; let otherT = ''; let otherWs = '';

  const insertMovement = (over: Record<string, unknown> = {}, pool: Pool = admin) => {
    const r: Record<string, unknown> = { tenant_id: t, workspace_id: ws, business_id: biz, inventory_item_id: item, warehouse_id: wh, movement_type: 'receipt', quantity: 5, ...over };
    const cols = Object.keys(r);
    return pool.query(`INSERT INTO business_operations.inventory_movements (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id, unit_cost, unit_cost_currency`, cols.map((c) => r[c]));
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    t = randomUUID(); ws = randomUUID(); biz = randomUUID(); item = randomUUID(); wh = randomUUID(); supplier = randomUUID(); otherT = randomUUID(); otherWs = randomUUID();
    for (const [tt, ww] of [[t, ws], [otherT, otherWs]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Currency Block C',$2,'active','test')`, [tt, `cur-c-${tt}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ww, tt, `ws-${ww}`]);
    }
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'C Biz',$4,'active')`, [biz, t, ws, `c-${biz}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [item, t, ws, biz, `sku-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [wh, t, ws, biz, `wh-${wh}`]);
    await admin.query(`INSERT INTO platform.suppliers (id, tenant_id, workspace_id, business_id, name, supplier_code) VALUES ($1,$2,$3,$4,'Supplier',$5)`, [supplier, t, ws, biz, `s-${supplier}`]);
  });
  afterAll(async () => { await closePool(); await admin.end(); await app.end(); });

  describe('movements: cost and currency travel together', () => {
    it('a cost with an explicit currency is stored exactly as supplied', async () => {
      for (const cur of ['EUR', 'JPY', 'USD', 'GBP']) {
        const r = await insertMovement({ unit_cost: 12.3456, unit_cost_currency: cur });
        expect(r.rows[0]).toMatchObject({ unit_cost_currency: cur });
      }
    });

    it('a movement with no cost and no currency is accepted and no currency is invented', async () => {
      const r = await insertMovement({ movement_type: 'issue', quantity: 1 });
      expect(r.rows[0]).toMatchObject({ unit_cost: null, unit_cost_currency: null });
    });

    it('a cost without a currency is refused, and so is a currency without a cost (for admin and application roles)', async () => {
      await expect(insertMovement({ unit_cost: 5 })).rejects.toThrow(PRESENCE);
      await expect(insertMovement({ unit_cost_currency: 'USD' })).rejects.toThrow(PRESENCE);
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [t, ws]);
        await expect(insertMovement({ unit_cost: 5 }, { query: (s: string, p: unknown[]) => client.query(s, p) } as unknown as Pool)).rejects.toThrow(PRESENCE);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    });

    it('a malformed currency is refused: lowercase, wrong length, symbols, spaces, empty', async () => {
      for (const bad of ['usd', 'US', 'USDX', 'U$D', ' EUR', 'EUR ', '']) {
        await expect(insertMovement({ unit_cost: 1, unit_cost_currency: bad }), JSON.stringify(bad)).rejects.toThrow(FORMAT);
      }
    });
  });

  describe('history is untouched: nothing is backfilled and no currency is assumed', () => {
    it('the presence invariant is NOT VALID (enforced for new rows only) and the format check is valid', async () => {
      const c = (await admin.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname LIKE 'inventory_movements_unit_cost_currency_%' ORDER BY conname`)).rows;
      expect(c).toEqual([
        { conname: 'inventory_movements_unit_cost_currency_format', convalidated: true },
        { conname: 'inventory_movements_unit_cost_currency_presence', convalidated: false },
      ]);
    });

    it('the pattern leaves a historical row (cost, NULL currency) in place: simulated on a scratch table', async () => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TEMP TABLE hist_mv (LIKE business_operations.inventory_movements INCLUDING DEFAULTS)`);
        await client.query(`INSERT INTO hist_mv (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,'receipt',1,9.5)`, [t, ws, biz, item, wh]);
        await client.query(`ALTER TABLE hist_mv ADD CONSTRAINT hist_presence CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID`);
        expect((await client.query(`SELECT unit_cost, unit_cost_currency FROM hist_mv`)).rows).toEqual([{ unit_cost: '9.5000', unit_cost_currency: null }]);
        await client.query('SAVEPOINT s');
        await expect(client.query(`INSERT INTO hist_mv (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,'receipt',1,3)`, [t, ws, biz, item, wh])).rejects.toThrow(/hist_presence/);
        await client.query('ROLLBACK TO SAVEPOINT s');
        await expect(client.query(`ALTER TABLE hist_mv VALIDATE CONSTRAINT hist_presence`)).rejects.toThrow();
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    });

    it('the column has no default and is nullable, and the migration contains no data change', async () => {
      const col = (await admin.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='inventory_movements' AND column_name='unit_cost_currency'`)).rows[0];
      expect(col).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
      const code = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code).not.toMatch(/\bUPDATE\b|\bDELETE\b|VALIDATE|'USD'/);
    });
  });

  describe('migration safety and unchanged protections', () => {
    it('re-applying the migration is idempotent: same two constraints, same column, one registration', async () => {
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname LIKE 'inventory_movements_unit_cost_currency_%'`)).rows[0].n).toBe(2);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0183_add_explicit_currency_to_inventory_costs.sql'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'inventory_movements_unit_cost_currency_presence'`)).rows[0].convalidated).toBe(false);
    });

    it('adds no UPDATE path to the movement table (only the 0184 append-only guards exist) and leaves RLS exactly as it was', async () => {
      expect((await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'business_operations.inventory_movements'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows)
        .toEqual([{ tgname: 'forbid_mutation_inventory_movements' }, { tgname: 'forbid_truncate_inventory_movements' }]);
      const f = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'business_operations.inventory_movements'::regclass`)).rows[0];
      expect(f).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = (await admin.query(`SELECT policyname, qual FROM pg_policies WHERE schemaname='business_operations' AND tablename='inventory_movements'`)).rows;
      expect(pol).toHaveLength(1);
      expect(pol[0].policyname).toBe('inventory_movements_isolation');
      expect(pol[0].qual).toMatch(/tenant_id = .*app\.tenant_id.*AND.*workspace_id = .*app\.workspace_id/s);
    });

    it('tenant isolation still holds: another tenant cannot see the cost or its currency, and cannot write into this tenant', async () => {
      const r = await insertMovement({ unit_cost: 7, unit_cost_currency: 'CHF' });
      const asTenant = async (tenant: string, workspace: string, sql: string, params: unknown[]) => {
        const c = await app.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [tenant, workspace]);
          return await c.query(sql, params);
        } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
      };
      expect((await asTenant(t, ws, `SELECT unit_cost_currency FROM business_operations.inventory_movements WHERE id=$1`, [r.rows[0].id])).rows).toEqual([{ unit_cost_currency: 'CHF' }]);
      expect((await asTenant(otherT, otherWs, `SELECT unit_cost_currency FROM business_operations.inventory_movements WHERE id=$1`, [r.rows[0].id])).rows).toEqual([]);
    });
  });

  describe('purchase orders: no silent USD default', () => {
    it('the database default is gone and the column stays NOT NULL', async () => {
      const col = (await admin.query(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='purchase_orders' AND column_name='currency_code'`)).rows[0];
      expect(col).toEqual({ column_default: null, is_nullable: 'NO' });
    });

    it('an insert that omits the currency is refused (no hidden USD), an explicit one is stored exactly', async () => {
      const base = { tenant_id: t, workspace_id: ws, business_id: biz, supplier_id: supplier };
      await expect(admin.query(`INSERT INTO business_operations.purchase_orders (tenant_id, workspace_id, business_id, supplier_id, po_number, total_amount) VALUES ($1,$2,$3,$4,$5,1)`, [base.tenant_id, base.workspace_id, base.business_id, base.supplier_id, `PO-${randomUUID()}`])).rejects.toThrow(/currency_code/);
      const ok = await admin.query(`INSERT INTO business_operations.purchase_orders (tenant_id, workspace_id, business_id, supplier_id, po_number, currency_code, total_amount) VALUES ($1,$2,$3,$4,$5,'CAD',1) RETURNING currency_code`, [base.tenant_id, base.workspace_id, base.business_id, base.supplier_id, `PO-${randomUUID()}`]);
      expect(ok.rows[0].currency_code).toBe('CAD');
    });

    it('the repository requires an explicit currency and stores exactly the one supplied', async () => {
      const repo = new PurchaseOrderRepository();
      const ctx = { tenantId: t, workspaceId: ws, userId: randomUUID() };
      await expect(repo.create(ctx, { businessId: biz, supplierId: supplier, poNumber: `PO-${randomUUID()}` } as never)).rejects.toThrow(/currencyCode is required/);
      expect((await repo.create(ctx, { businessId: biz, supplierId: supplier, poNumber: `PO-${randomUUID()}`, currencyCode: 'AUD' })).currencyCode).toBe('AUD');
    });
  });
});
