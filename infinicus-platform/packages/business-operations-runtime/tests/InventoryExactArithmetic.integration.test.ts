/**
 * POS2-04-S1: exact-decimal inventory balance arithmetic in the ONE movement writer (`OperationalCommandExecutor.applyInventoryMovement`), proven on real
 * PostgreSQL as the least-privilege application role. quantity_on_hand and movement quantity are numeric(18,4); every expected value below is compared as exact
 * database text, never with a floating-point tolerance.
 *
 * Requires DATABASE_URL (application role, grant-app-role.sh applied) and ADMIN_DATABASE_URL (operator, fixtures and assertions only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import type { OperationalCommand, OperationalCommandContext } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const MAX = '99999999999999.9999';

interface World { ctx: TenantContext; businessId: string; sibling: string; itemSibling: string; warehouse: string; warehouseSibling: string }

describe.runIf(run)('POS2-04-S1: exact inventory balance arithmetic (real PostgreSQL)', () => {
  let admin: Pool;
  let app: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  let seq = 0;
  const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await app?.end(); await admin?.end(); await closePool(); });

  async function world(): Promise<World> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID();
    tenantIds.push(tenantId);
    const slug = `ea${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    const biz = async (code: string) => (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`, [tenantId, workspaceId, code, unique(code)])).rows[0].id as string;
    const businessId = await biz('exact-biz'); const sibling = await biz('exact-sibling');
    const wh = async (b: string) => (await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`, [tenantId, workspaceId, b, unique('wh')])).rows[0].id as string;
    const w = { ctx: { tenantId, workspaceId, userId } as TenantContext, businessId, sibling, itemSibling: '', warehouse: await wh(businessId), warehouseSibling: await wh(sibling) };
    w.itemSibling = await item(w, sibling);
    return w;
  }
  const item = async (w: { ctx: TenantContext; businessId: string }, businessId = w.businessId) =>
    (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [w.ctx.tenantId, w.ctx.workspaceId, businessId, unique('sku')])).rows[0].id as string;

  const context = (w: { ctx: TenantContext; businessId: string }): OperationalCommandContext => ({
    tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'exact#0', provenanceReference: randomUUID(),
    idempotencyKey: `dal-to-bo:${randomUUID()}:1:exact#0`, actorId: 'actor-1', occurredAt: new Date().toISOString(),
  });
  const move = (w: World, itemId: string, movementType: string, quantity: unknown, warehouse = w.warehouse, ctx = w.ctx, businessId = w.businessId) =>
    withTenantTransaction(ctx, (client) => executor.executeOn(client, ctx, { type: 'record_inventory_movement', context: { ...context(w), tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId }, payload: { inventoryItemId: itemId, warehouseId: warehouse, movementType, quantity } } as unknown as OperationalCommand));
  const onHand = async (itemId: string, warehouse: string): Promise<string | null> =>
    (await admin.query(`SELECT quantity_on_hand::text AS q FROM ${BO}.inventory_balances WHERE inventory_item_id=$1 AND warehouse_id=$2`, [itemId, warehouse])).rows[0]?.q ?? null;
  const movements = async (itemId: string): Promise<{ n: number; list: string[] }> => {
    const r = await admin.query(`SELECT quantity::text AS q FROM ${BO}.inventory_movements WHERE inventory_item_id=$1 ORDER BY created_at, id`, [itemId]);
    return { n: r.rowCount ?? 0, list: r.rows.map((x) => x.q as string) };
  };
  const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'NO_ERROR'; } catch (e) { return (e as Error).message; } };

  describe('the exact arithmetic table', () => {
    it('0.1000 + 0.2000 = 0.3000, as text and as numbers', async () => {
      const w = await world(); const a = await item(w); const b = await item(w);
      await move(w, a, 'receipt', '0.1000'); await move(w, a, 'receipt', '0.2000');
      expect(await onHand(a, w.warehouse)).toBe('0.3000');
      await move(w, b, 'receipt', 0.1); await move(w, b, 'receipt', 0.2);       // the classic float trap: 0.1 + 0.2 = 0.30000000000000004
      expect(await onHand(b, w.warehouse)).toBe('0.3000');
    });
    it('1.0000 - 0.0001 = 0.9999 and 0.0001 + 0.0001 = 0.0002', async () => {
      const w = await world(); const a = await item(w); const b = await item(w);
      await move(w, a, 'receipt', '1.0000'); await move(w, a, 'issue', '0.0001');
      expect(await onHand(a, w.warehouse)).toBe('0.9999');
      await move(w, b, 'receipt', '0.0001'); await move(w, b, 'receipt', '0.0001');
      expect(await onHand(b, w.warehouse)).toBe('0.0002');
    });
    it('fifty concurrent additions of 0.0001 are exactly 0.0050, and a large balance keeps its last digit', async () => {
      const w = await world(); const a = await item(w); const b = await item(w);
      await Promise.all(Array.from({ length: 50 }, () => move(w, a, 'receipt', '0.0001')));
      expect(await onHand(a, w.warehouse)).toBe('0.0050');
      await move(w, b, 'receipt', '12345678901234.5678'); await move(w, b, 'receipt', '0.0001');
      expect(await onHand(b, w.warehouse)).toBe('12345678901234.5679');
    });
    it('the maximum representable quantity is held exactly, and one more 0.0001 is refused as overflow with nothing changed', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', MAX);
      expect(await onHand(a, w.warehouse)).toBe(MAX);
      const before = await movements(a);
      expect(await refused(move(w, a, 'receipt', '0.0001'))).toContain('exceed the maximum 99999999999999.9999');
      expect(await onHand(a, w.warehouse)).toBe(MAX);
      expect(await movements(a)).toEqual(before);
    });
    it('0.0000 - 0.0001 is refused by the non-negative policy, with no movement and the balance unchanged', async () => {
      const w = await world(); const a = await item(w);
      expect(await refused(move(w, a, 'issue', '0.0001'))).toContain('would make quantity_on_hand negative (-0.0001)');
      expect(await movements(a)).toEqual({ n: 0, list: [] });
      expect(['0.0000', null]).toContain(await onHand(a, w.warehouse));    // the balance row may be created by the refused attempt only inside its rolled-back transaction
    });
    it('a quantity of exactly the balance empties it to 0.0000; one more 0.0001 is refused', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '0.3000'); await move(w, a, 'issue', '0.3000');
      expect(await onHand(a, w.warehouse)).toBe('0.0000');
      expect(await refused(move(w, a, 'issue', '0.0001'))).toContain('negative');
    });
  });

  describe('quantities that cannot be stored exactly are refused, never rounded', () => {
    it.each([
      ['more than four decimals as text', '0.00001', 'at most 4 decimal places'],
      ['more than four decimals as a number', 0.00001, 'at most 4 decimal places'],
      ['five decimals that are not zero', '1.23456', 'at most 4 decimal places'],
      ['at the limit', '100000000000000', 'below 100000000000000'],
      ['above the limit as a number', 1e21, 'below 100000000000000'],
      ['an unsafe integer as a number', 9007199254740993, 'below 100000000000000'],
      ['an unsafe integer as text', '9007199254740993', 'below 100000000000000'],
    ])('%s', async (_name, quantity, message) => {
      const w = await world(); const a = await item(w);
      expect(await refused(move(w, a, 'receipt', quantity))).toContain(message);
      expect(await movements(a)).toEqual({ n: 0, list: [] });
    });
    it.each([['abc'], ['1e3'], [' 1'], ['1 '], [''], ['1,5'], ['--1'], ['.5'], ['5.'], [NaN], [Infinity], [-Infinity], [null], [undefined], [{}], [[1]], [true]])('refuses %j as not a decimal', async (quantity) => {
      const w = await world(); const a = await item(w);
      expect(await refused(move(w, a, 'receipt', quantity))).toBe('Inventory movement quantity must be a finite decimal.');
      expect(await movements(a)).toEqual({ n: 0, list: [] });
    });
    it('trailing zeros beyond the fourth place are the same value and are accepted; the stored value is exact', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '0.30000'); await move(w, a, 'receipt', '+0.2000');
      expect(await onHand(a, w.warehouse)).toBe('0.5000');
      expect((await movements(a)).list).toEqual(['0.3000', '0.2000']);
    });
    it('a 14-digit whole number is held exactly (it never passes through Number)', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '99999999999999'); await move(w, a, 'issue', '1');
      expect(await onHand(a, w.warehouse)).toBe('99999999999998.0000');
    });
  });

  describe('movement-type semantics are unchanged', () => {
    it('receipts, transfers in and returns add the magnitude; issues, transfers out and write-offs subtract it (a negative input is its magnitude)', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '5'); await move(w, a, 'transfer_in', '-1.5'); await move(w, a, 'return', '0.5');
      expect(await onHand(a, w.warehouse)).toBe('7.0000');
      await move(w, a, 'issue', '1'); await move(w, a, 'transfer_out', '-0.25'); await move(w, a, 'write_off', '0.75');
      expect(await onHand(a, w.warehouse)).toBe('5.0000');
      expect((await movements(a)).list).toEqual(['5.0000', '-1.5000', '0.5000', '1.0000', '-0.2500', '0.7500']);   // the movement keeps the quantity as given
    });
    it('adjustments and cycle counts are signed', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'adjustment', '0.0003'); await move(w, a, 'adjustment', '-0.0001'); await move(w, a, 'cycle_count', '0.0005');
      expect(await onHand(a, w.warehouse)).toBe('0.0007');
      expect(await refused(move(w, a, 'cycle_count', '-0.0008'))).toContain('negative (-0.0001)');
      expect(await onHand(a, w.warehouse)).toBe('0.0007');
    });
    it('the keyed movement path uses the same exact writer', async () => {
      const w = await world(); const a = await item(w);
      const sku = (await admin.query(`SELECT sku FROM platform.inventory_items WHERE id=$1`, [a])).rows[0].sku as string;
      const code = (await admin.query(`SELECT warehouse_code FROM platform.warehouses WHERE id=$1`, [w.warehouse])).rows[0].warehouse_code as string;
      const keyed = (q: unknown) => withTenantTransaction(w.ctx, (client) => executor.executeOn(client, w.ctx, { type: 'record_keyed_inventory_movement', context: context(w), payload: { inventoryItemSku: sku, warehouseCode: code, movementType: 'receipt', quantity: q } } as unknown as OperationalCommand));
      await keyed('0.1000'); await keyed(0.2);
      expect(await onHand(a, w.warehouse)).toBe('0.3000');
      expect(await refused(keyed('0.00001'))).toContain('at most 4 decimal places');
    });
  });

  describe('atomicity, concurrency and rollback', () => {
    it('a failure after the movement but before commit leaves the balance and the evidence unchanged', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '0.1000');
      const before = { bal: await onHand(a, w.warehouse), mv: await movements(a) };
      const boom = withTenantTransaction(w.ctx, async (client) => {
        await executor.executeOn(client, w.ctx, { type: 'record_inventory_movement', context: context(w), payload: { inventoryItemId: a, warehouseId: w.warehouse, movementType: 'receipt', quantity: '0.2000' } } as OperationalCommand);
        throw new Error('simulated failure before commit');
      });
      expect(await refused(boom)).toBe('simulated failure before commit');
      expect({ bal: await onHand(a, w.warehouse), mv: await movements(a) }).toEqual(before);
      await move(w, a, 'receipt', '0.2000');                                     // a retry after the rollback applies exactly once
      expect(await onHand(a, w.warehouse)).toBe('0.3000');
    });
    it('concurrent movements on one balance end at the exact committed result', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '0.5000');
      await Promise.all([
        ...Array.from({ length: 30 }, () => move(w, a, 'receipt', '0.0003')),
        ...Array.from({ length: 10 }, () => move(w, a, 'issue', '0.0007')),
      ]);
      expect(await onHand(a, w.warehouse)).toBe('0.5020');                       // 0.5 + 30 x 0.0003 - 10 x 0.0007
      expect((await movements(a)).n).toBe(41);
    });
    it('concurrent issues against too little stock: exactly the affordable ones commit, the rest are refused, nothing is half-applied', async () => {
      const w = await world(); const a = await item(w);
      await move(w, a, 'receipt', '0.0010');
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => move(w, a, 'issue', '0.0004')));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
      expect(await onHand(a, w.warehouse)).toBe('0.0002');
      expect((await movements(a)).n).toBe(3);                                    // the receipt and the two committed issues
    });
  });

  describe('scope and security are unchanged', () => {
    it('an item or warehouse of another business, or of another tenant, is refused before any effect', async () => {
      const w = await world(); const other = await world(); const a = await item(w);
      expect(await refused(move(w, w.itemSibling, 'receipt', '1'))).toContain('not found in business scope');
      expect(await refused(move(w, a, 'receipt', '1', w.warehouseSibling))).toContain('not found in business scope');
      expect(await refused(move(w, (await item(other)), 'receipt', '1'))).toContain('not found in business scope');
      expect(await movements(a)).toEqual({ n: 0, list: [] });
    });
    it('a command for another tenant\'s scope is refused', async () => {
      const w = await world(); const other = await world(); const a = await item(other);
      expect(await refused(withTenantTransaction(w.ctx, (client) => executor.executeOn(client, w.ctx, { type: 'record_inventory_movement', context: context(other), payload: { inventoryItemId: a, warehouseId: other.warehouse, movementType: 'receipt', quantity: '1' } } as OperationalCommand)))).not.toBe('NO_ERROR');
      expect(await movements(a)).toEqual({ n: 0, list: [] });
    });
    it('one tenant cannot read another tenant\'s movements or balances (row-level security as the application role)', async () => {
      const w = await world(); const other = await world(); const a = await item(w);
      await move(w, a, 'receipt', '1.2345');
      const seen = await withTenantTransaction(other.ctx, async (client) => ({
        mv: (await client.query(`SELECT 1 FROM ${BO}.inventory_movements WHERE inventory_item_id=$1`, [a])).rowCount,
        bal: (await client.query(`SELECT 1 FROM ${BO}.inventory_balances WHERE inventory_item_id=$1`, [a])).rowCount,
      }));
      expect(seen).toEqual({ mv: 0, bal: 0 });
    });
    it('the schema is what the arithmetic assumes: numeric(18,4) columns, forced row-level security on the ledger, append-only', async () => {
      const cols = await admin.query(`SELECT table_name, column_name, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema='business_operations' AND ((table_name='inventory_balances' AND column_name='quantity_on_hand') OR (table_name='inventory_movements' AND column_name='quantity'))`);
      expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}:${r.numeric_precision},${r.numeric_scale}`).sort()).toEqual(['inventory_balances.quantity_on_hand:18,4', 'inventory_movements.quantity:18,4']);
      const rls = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('business_operations.inventory_movements'::regclass,'business_operations.inventory_balances'::regclass) ORDER BY relname`);
      expect(rls.rows.every((r) => r.relrowsecurity === true)).toBe(true);
      expect(rls.rows.find((r) => r.relname === 'inventory_movements').relforcerowsecurity).toBe(true);
      const triggers = await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='business_operations.inventory_movements'::regclass AND NOT tgisinternal ORDER BY tgname`);
      expect(triggers.rows.map((r) => r.tgname)).toEqual(expect.arrayContaining(['forbid_mutation_inventory_movements', 'forbid_truncate_inventory_movements']));
    });
  });
});
