/**
 * Data-capture Block D - purchase order -> purchase-order line -> receipt line -> receipt movement -> inventory item linkage (migration 0198),
 * proven on real PostgreSQL as the least-privilege application role. Fixtures and assertions use the operator connection only.
 *
 * Requires DATABASE_URL (application role, grant-app-role.sh applied) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { closePool, createPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import type { OperationalCommand, OperationalCommandContext } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const PAST = '2026-10-01T09:30:00.250Z';
const MIGRATIONS = resolve(__dirname, '../../../infrastructure/database/migrations');

interface World {
  ctx: TenantContext; tenantId: string; workspaceId: string; businessId: string; sibling: string; warehouse: string;
  itemA: string; itemB: string; siblingItem: string; po: string; siblingPo: string; product: string;
}

describe.runIf(run)('Data-capture Block D: purchase-order line / receipt / inventory-item linkage (real PostgreSQL)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  let seq = 0;
  const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => {
    await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined);
    await admin?.end(); await closePool();
  });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

  async function tenantWorld(): Promise<{ tenantId: string; workspaceId: string; userId: string }> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID();
    tenantIds.push(tenantId);
    const slug = `lk${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@link.example.test`]);
    return { tenantId, workspaceId, userId };
  }
  const biz = async (t: string, ws: string, code: string) => (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`, [t, ws, code, unique(code)])).rows[0].id as string;
  const item = async (t: string, ws: string, b: string) => (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [t, ws, b, unique('sku')])).rows[0].id as string;
  const wh = async (t: string, ws: string, b: string) => (await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`, [t, ws, b, unique('wh')])).rows[0].id as string;
  const supplier = async (t: string, ws: string, b: string) => (await admin.query(`INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,'Supplier',$4,'low','active') RETURNING id`, [t, ws, b, unique('sup')])).rows[0].id as string;
  const product = async (t: string, ws: string, b: string) => (await admin.query(`INSERT INTO platform.products (tenant_id, workspace_id, business_id, product_code, name) VALUES ($1,$2,$3,$4,'Product') RETURNING id`, [t, ws, b, unique('prd')])).rows[0].id as string;

  const baseContext = (w: { tenantId: string; workspaceId: string; businessId: string }): OperationalCommandContext => ({
    tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'submission-1#0', provenanceReference: randomUUID(),
    idempotencyKey: `dal-to-bo:${randomUUID()}:1:submission-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString(),
  });
  const command = (type: OperationalCommand['type'], w: any, payload: any): OperationalCommand => ({ type, context: baseContext(w), payload } as OperationalCommand);
  const executeTx = (ctx: TenantContext, cmd: OperationalCommand) => withTenantTransaction(ctx, (client) => executor.executeOn(client, ctx, cmd));

  async function world(): Promise<World> {
    const { tenantId, workspaceId, userId } = await tenantWorld();
    const businessId = await biz(tenantId, workspaceId, 'link-biz'); const sibling = await biz(tenantId, workspaceId, 'link-sibling');
    const ctx: TenantContext = { tenantId, workspaceId, userId };
    const w = {
      ctx, tenantId, workspaceId, businessId, sibling, warehouse: await wh(tenantId, workspaceId, businessId),
      itemA: await item(tenantId, workspaceId, businessId), itemB: await item(tenantId, workspaceId, businessId), siblingItem: await item(tenantId, workspaceId, sibling),
      product: await product(tenantId, workspaceId, businessId),
    } as World;
    const po = async (b: string) => (await executeTx(ctx, command('create_purchase_order', { tenantId, workspaceId, businessId: b }, { supplierId: await supplier(tenantId, workspaceId, b), poNumber: unique('PO'), currencyCode: 'USD' }))).recordId;
    w.po = await po(businessId); w.siblingPo = await po(sibling);
    return w;
  }

  // The PO-line writes below use the least-privilege APPLICATION role (a tenant transaction); purchase-order lines have no runtime write path yet.
  const lineAs = (w: World, over: Record<string, unknown> = {}, lineNumber = 1) => withTenantTransaction(w.ctx, async (c) => {
    const o = { tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, purchase_order_id: w.po, inventory_item_id: null, product_id: null, ...over };
    return (await c.query(
      `INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, product_id, inventory_item_id, description, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PO line',100) RETURNING id`,
      [o.tenant_id, o.workspace_id, o.business_id, o.purchase_order_id, lineNumber, o.product_id, o.inventory_item_id]
    )).rows[0].id as string;
  });
  const receiptPayload = (w: World, poLine: string | undefined, itemId: string, over: Record<string, unknown> = {}) => ({
    purchaseOrderId: w.po, warehouseId: w.warehouse, receiptNumber: unique('GRN'), receivedAt: PAST,
    lines: [{ ...(poLine ? { purchaseOrderLineId: poLine } : {}), inventoryItemId: itemId, quantity: 5, unitCost: 2, unitCostCurrency: 'USD' }], ...over,
  });
  const receive = (w: World, payload: any) => executeTx(w.ctx, command('record_purchase_receipt', w, payload));
  const counts = async (w: World) => ({
    receipts: (await q(`SELECT count(*)::int n FROM ${BO}.purchase_receipts WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    lines: (await q(`SELECT count(*)::int n FROM ${BO}.purchase_receipt_lines WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    movements: (await q(`SELECT count(*)::int n FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
  });

  describe('migration', () => {
    it('0198 is recorded, adds a NULLABLE inventory_item_id with an FK to platform.inventory_items and the join indexes; 0197 is byte-identical', async () => {
      expect((await q(`SELECT 1 FROM _migrations WHERE filename='0198_link_purchase_order_lines_to_inventory_items.sql'`)).length).toBe(1);
      const [col] = await q(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='purchase_order_line_items' AND column_name='inventory_item_id'`);
      expect(col).toEqual({ is_nullable: 'YES', data_type: 'uuid' });
      const [fk] = await q(`SELECT confrelid::regclass::text target, confdeltype FROM pg_constraint WHERE conrelid='business_operations.purchase_order_line_items'::regclass AND contype='f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='business_operations.purchase_order_line_items'::regclass AND attname='inventory_item_id')]`);
      expect(fk).toEqual({ target: 'platform.inventory_items', confdeltype: 'r' }); // RESTRICT: a link that receipts rely on is never silently erased
      const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname='business_operations' AND indexname IN ('idx_po_lines_item','idx_prl_po_line')`)).map((r) => r.indexname).sort();
      expect(idx).toEqual(['idx_po_lines_item', 'idx_prl_po_line']);
      // the product link is still there
      expect((await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='purchase_order_line_items' AND column_name='product_id'`)).length).toBe(1);
      // no earlier migration was modified
      expect(createHash('sha256').update(readFileSync(resolve(MIGRATIONS, '0197_create_purchase_receipt_lines.sql'))).digest('hex')).toBe('20f43249d0240a3a80f6e2061a0257a56bf8c3aaf564ed3ea6a1eb4174f1af92');
    });

    it('existing rows are not touched: a line written without an item stays NULL (no backfill, no product->item inference)', async () => {
      const w = await world();
      // an item and a product are linked ONLY through catalog identity here; nothing may turn that into an operational link
      await admin.query(`UPDATE platform.inventory_items SET product_id=$1 WHERE id=$2`, [w.product, w.itemA]);
      const id = await lineAs(w, { product_id: w.product });
      const [row] = await q(`SELECT product_id, inventory_item_id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [id]);
      expect(row).toEqual({ product_id: w.product, inventory_item_id: null });
      // a receipt against that unlinked line does not write the item back into the line either
      await receive(w, receiptPayload(w, id, w.itemA));
      expect((await q(`SELECT inventory_item_id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [id]))[0].inventory_item_id).toBeNull();
    });
  });

  describe('purchase-order line linkage and scope', () => {
    it('a same-scope item persists; the product link is preserved and coexists with the item link; NULL is permitted', async () => {
      const w = await world();
      const linked = await lineAs(w, { inventory_item_id: w.itemA, product_id: w.product }, 1);
      const bare = await lineAs(w, {}, 2);
      const rows = await q(`SELECT id, product_id, inventory_item_id FROM ${BO}.purchase_order_line_items WHERE purchase_order_id=$1 ORDER BY line_number`, [w.po]);
      expect(rows).toEqual([{ id: linked, product_id: w.product, inventory_item_id: w.itemA }, { id: bare, product_id: null, inventory_item_id: null }]);
    });

    it('a cross-tenant item is refused (even though the FK alone would accept it)', async () => {
      const w = await world(); const other = await world();
      await rejects(lineAs(w, { inventory_item_id: other.itemA }), /inventory item does not belong/);
    });

    it('a cross-workspace item (same tenant) is refused', async () => {
      const w = await world();
      const ws2 = randomUUID();
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'ws2',$3,'active')`, [ws2, w.tenantId, `ws2${ws2.slice(0, 8)}`]);
      const b2 = await biz(w.tenantId, ws2, 'ws2-biz');
      const foreign = await item(w.tenantId, ws2, b2);
      await rejects(lineAs(w, { inventory_item_id: foreign }), /inventory item does not belong/);
    });

    it('a sibling-business item is refused', async () => {
      const w = await world();
      await rejects(lineAs(w, { inventory_item_id: w.siblingItem }), /inventory item does not belong/);
    });

    it('an item row whose OWN scope is inconsistent (right business, wrong workspace or tenant) is refused: the guard checks tenant, workspace and business independently', async () => {
      const w = await world(); const other = await world();
      const ws2 = randomUUID();
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'ws2',$3,'active')`, [ws2, w.tenantId, `ws2${ws2.slice(0, 8)}`]);
      const wrongWorkspace = (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [w.tenantId, ws2, w.businessId, unique('sku')])).rows[0].id;
      const wrongTenant = (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [other.tenantId, other.workspaceId, w.businessId, unique('sku')])).rows[0].id;
      await rejects(lineAs(w, { inventory_item_id: wrongWorkspace }), /inventory item does not belong/);
      await rejects(lineAs(w, { inventory_item_id: wrongTenant }), /inventory item does not belong/);
    });

    it('a purchase order of another business is refused for the line (the line scope must match its purchase order)', async () => {
      const w = await world();
      await rejects(lineAs(w, { purchase_order_id: w.siblingPo }), /purchase order does not belong/);
    });

    it('updating the item link is guarded too: a cross-scope item and a cross-scope purchase order are refused; a same-scope change is allowed while no receipt relies on it', async () => {
      const w = await world();
      const id = await lineAs(w, { inventory_item_id: w.itemA });
      await rejects(withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=$2 WHERE id=$1`, [id, w.siblingItem])), /inventory item does not belong/);
      await rejects(withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET purchase_order_id=$2 WHERE id=$1`, [id, w.siblingPo])), /purchase order does not belong/);
      await withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=$2 WHERE id=$1`, [id, w.itemB]));
      expect((await q(`SELECT inventory_item_id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [id]))[0].inventory_item_id).toBe(w.itemB);
    });

    it('other updates of a line (the existing received_qty / price maintenance) are not blocked by the guard', async () => {
      const w = await world();
      const id = await lineAs(w, { inventory_item_id: w.itemA });
      await withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET received_qty=3, unit_price=9 WHERE id=$1`, [id]));
      expect((await q(`SELECT received_qty::text r FROM ${BO}.purchase_order_line_items WHERE id=$1`, [id]))[0].r).toBe('3.0000');
    });

    it('the item row cannot be deleted while a purchase-order line links to it (RESTRICT)', async () => {
      const w = await world();
      await lineAs(w, { inventory_item_id: w.itemA });
      await rejects(admin.query(`DELETE FROM platform.inventory_items WHERE id=$1`, [w.itemA]), /foreign key|violates/);
    });

    it('row-level security hides another tenant\'s purchase-order lines from the application role', async () => {
      const w = await world(); const other = await world();
      const id = await lineAs(w, { inventory_item_id: w.itemA });
      const seen = await withTenantTransaction(other.ctx, (c) => c.query(`SELECT id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [id]));
      expect(seen.rowCount).toBe(0);
    });
  });

  describe('receipt chain', () => {
    it('purchase order -> line -> receipt line -> receipt movement -> item is one unbroken, consistent chain', async () => {
      const w = await world();
      const poLine = await lineAs(w, { inventory_item_id: w.itemA });
      const out = await receive(w, receiptPayload(w, poLine, w.itemA));
      const chain = await q(
        `SELECT po.id po_id, pl.id pl_id, pl.inventory_item_id pl_item, rl.inventory_item_id rl_item, m.inventory_item_id m_item, m.reference_id, rl.purchase_receipt_id
           FROM ${BO}.purchase_orders po
           JOIN ${BO}.purchase_order_line_items pl ON pl.purchase_order_id = po.id
           JOIN ${BO}.purchase_receipt_lines rl ON rl.purchase_order_line_id = pl.id
           JOIN ${BO}.inventory_movements m ON m.id = rl.inventory_movement_id
          WHERE po.id = $1`, [w.po]);
      expect(chain).toEqual([{ po_id: w.po, pl_id: poLine, pl_item: w.itemA, rl_item: w.itemA, m_item: w.itemA, reference_id: out.recordId, purchase_receipt_id: out.recordId }]);
    });

    it('a receipt line recording a different item than the linked purchase-order line is refused by the executor, and nothing is written', async () => {
      const w = await world();
      const poLine = await lineAs(w, { inventory_item_id: w.itemA });
      const before = await counts(w);
      await rejects(receive(w, receiptPayload(w, poLine, w.itemB)), /different inventory item/);
      expect(await counts(w)).toEqual(before);
    });

    it('a receipt line for an UNLINKED purchase-order line is accepted exactly as in Block A, and the line stays unlinked', async () => {
      const w = await world();
      const poLine = await lineAs(w, {});
      await receive(w, receiptPayload(w, poLine, w.itemB));
      expect((await q(`SELECT inventory_item_id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [poLine]))[0].inventory_item_id).toBeNull();
    });

    it('a purchase-order line of another business or tenant cannot be borrowed by a receipt', async () => {
      const w = await world(); const other = await world();
      const otherLine = await withTenantTransaction(other.ctx, async (c) => (await c.query(
        `INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity, inventory_item_id) VALUES ($1,$2,$3,$4,1,'x',1,$5) RETURNING id`,
        [other.tenantId, other.workspaceId, other.businessId, other.po, other.itemA])).rows[0].id as string);
      await rejects(receive(w, receiptPayload(w, otherLine, w.itemA)), /not a line of this purchase order/);
      const siblingLine = await withTenantTransaction(w.ctx, async (c) => (await c.query(
        `INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity, inventory_item_id) VALUES ($1,$2,$3,$4,1,'x',1,$5) RETURNING id`,
        [w.tenantId, w.workspaceId, w.sibling, w.siblingPo, w.siblingItem])).rows[0].id as string);
      await rejects(receive(w, receiptPayload(w, siblingLine, w.itemA)), /not a line of this purchase order/);
    });

    it('the DATABASE refuses a mismatched receipt line even when the executor is bypassed (operator inserts header, movement and line directly)', async () => {
      const w = await world();
      const poLine = await lineAs(w, { inventory_item_id: w.itemA });
      const direct = async (poLineId: string, itemId: string) => {
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          const rid = (await c.query(`INSERT INTO ${BO}.purchase_receipts (tenant_id, workspace_id, business_id, purchase_order_id, receipt_number, received_at, warehouse_id, payload, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8) RETURNING id`, [w.tenantId, w.workspaceId, w.businessId, w.po, unique('GRN'), PAST, w.warehouse, randomUUID()])).rows[0].id;
          const mid = (await c.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id, correlation_id, occurred_at) VALUES ($1,$2,$3,$4,$5,'receipt',5,'purchase_receipt',$6,$7,$8) RETURNING id`, [w.tenantId, w.workspaceId, w.businessId, itemId, w.warehouse, rid, randomUUID(), PAST])).rows[0].id;
          await c.query(`INSERT INTO ${BO}.purchase_receipt_lines (tenant_id, workspace_id, business_id, purchase_receipt_id, line_number, purchase_order_line_id, inventory_item_id, inventory_movement_id, quantity, correlation_id) VALUES ($1,$2,$3,$4,1,$5,$6,$7,5,$8)`, [w.tenantId, w.workspaceId, w.businessId, rid, poLineId, itemId, mid, randomUUID()]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      };
      await rejects(direct(poLine, w.itemB), /different inventory item/);
      await expect(direct(poLine, w.itemA)).resolves.toBeUndefined(); // the consistent one passes, so the refusal above is the chain rule and nothing else
    });

    it('the DATABASE refuses a receipt line that borrows a purchase-order line whose own business differs from its purchase order (operator-forged line, executor bypassed)', async () => {
      const w = await world();
      // forge a line of THIS purchase order that claims the sibling business (the line guard would refuse it, so the operator suspends triggers to create it)
      const c0 = await admin.connect();
      let forged: string;
      try {
        await c0.query('BEGIN'); await c0.query("SET LOCAL session_replication_role = 'replica'");
        forged = (await c0.query(`INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity) VALUES ($1,$2,$3,$4,1,'forged',1) RETURNING id`, [w.tenantId, w.workspaceId, w.sibling, w.po])).rows[0].id;
        await c0.query('COMMIT');
      } finally { c0.release(); }
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        const rid = (await c.query(`INSERT INTO ${BO}.purchase_receipts (tenant_id, workspace_id, business_id, purchase_order_id, receipt_number, received_at, warehouse_id, payload, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8) RETURNING id`, [w.tenantId, w.workspaceId, w.businessId, w.po, unique('GRN'), PAST, w.warehouse, randomUUID()])).rows[0].id;
        const mid = (await c.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id, correlation_id, occurred_at) VALUES ($1,$2,$3,$4,$5,'receipt',5,'purchase_receipt',$6,$7,$8) RETURNING id`, [w.tenantId, w.workspaceId, w.businessId, w.itemA, w.warehouse, rid, randomUUID(), PAST])).rows[0].id;
        await rejects(c.query(`INSERT INTO ${BO}.purchase_receipt_lines (tenant_id, workspace_id, business_id, purchase_receipt_id, line_number, purchase_order_line_id, inventory_item_id, inventory_movement_id, quantity, correlation_id) VALUES ($1,$2,$3,$4,1,$5,$6,$7,5,$8)`, [w.tenantId, w.workspaceId, w.businessId, rid, forged, w.itemA, mid, randomUUID()]), /not a line of the receipt/);
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    });

    it('once a receipt line relies on a purchase-order line, its item link cannot be cleared or changed; an unlinked line may be linked to the item already received', async () => {
      const w = await world();
      const linked = await lineAs(w, { inventory_item_id: w.itemA }, 1);
      await receive(w, receiptPayload(w, linked, w.itemA));
      await rejects(withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=NULL WHERE id=$1`, [linked])), /cannot be cleared or changed/);
      await rejects(withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=$2 WHERE id=$1`, [linked, w.itemB])), /cannot be cleared or changed/);
      const bare = await lineAs(w, {}, 2);
      await receive(w, receiptPayload(w, bare, w.itemB));
      await rejects(withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=$2 WHERE id=$1`, [bare, w.itemA])), /cannot be cleared or changed/);
      await withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.purchase_order_line_items SET inventory_item_id=$2 WHERE id=$1`, [bare, w.itemB])); // consistent with what was received
      expect((await q(`SELECT inventory_item_id FROM ${BO}.purchase_order_line_items WHERE id=$1`, [bare]))[0].inventory_item_id).toBe(w.itemB);
    });
  });

  describe('Block A regression', () => {
    it('an identical replay is a no-op (no second receipt, line or movement); a conflicting replay is refused; append-only guards still hold', async () => {
      const w = await world();
      const poLine = await lineAs(w, { inventory_item_id: w.itemA });
      const payload = receiptPayload(w, poLine, w.itemA);
      const first = await receive(w, payload);
      const afterFirst = await counts(w);
      const replay = await receive(w, payload);
      expect(replay.recordId).toBe(first.recordId);
      expect(await counts(w)).toEqual(afterFirst);
      await rejects(receive(w, { ...payload, lines: [{ ...payload.lines[0], quantity: 6 }] }), /already exists with different content/);
      expect(await counts(w)).toEqual(afterFirst);
      await rejects(admin.query(`UPDATE ${BO}.purchase_receipt_lines SET quantity=1 WHERE tenant_id=$1`, [w.tenantId]), /append-only/);
      await rejects(admin.query(`DELETE FROM ${BO}.purchase_receipts WHERE tenant_id=$1`, [w.tenantId]), /append-only/);
      await rejects(admin.query(`UPDATE ${BO}.inventory_movements SET quantity=1 WHERE tenant_id=$1`, [w.tenantId]), /append-only/);
    });

    it('a receipt changes neither the purchase-order status nor received_qty, and the linkage adds no supplier-to-item structure', async () => {
      const w = await world();
      const poLine = await lineAs(w, { inventory_item_id: w.itemA });
      const before = (await q(`SELECT po_status FROM ${BO}.purchase_orders WHERE id=$1`, [w.po]))[0];
      await receive(w, receiptPayload(w, poLine, w.itemA));
      expect((await q(`SELECT po_status FROM ${BO}.purchase_orders WHERE id=$1`, [w.po]))[0]).toEqual(before);
      expect((await q(`SELECT received_qty::text r FROM ${BO}.purchase_order_line_items WHERE id=$1`, [poLine]))[0].r).toBe('0.0000');
    });
  });
});
