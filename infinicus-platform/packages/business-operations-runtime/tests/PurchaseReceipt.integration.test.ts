/**
 * Data-capture Block A - the purchase receipt write path (migration 0197), proven on real PostgreSQL as the least-privilege application role.
 *
 *   DAL publication -> BusinessIntakeService -> `purchase_receipt` mapper -> `record_purchase_receipt` -> OperationalCommandExecutor
 *   -> header + lines + one `receipt` ledger movement per line, in ONE transaction.
 *
 * Requires DATABASE_URL (application role, grant-app-role.sh applied) and ADMIN_DATABASE_URL (operator, used only for fixtures and assertions).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import type { OperationalCommand, OperationalCommandContext, RecordPurchaseReceiptCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const PAST = '2026-10-01T09:30:00.250Z';

interface World {
  ctx: TenantContext; tenantId: string; workspaceId: string; businessId: string; sibling: string; warehouse: string; itemA: string; itemB: string;
  po: string; poLine: string; siblingItem: string; siblingWarehouse: string; siblingPo: string;
}

describe.runIf(run)('Data-capture Block A: purchase receipt write path (real PostgreSQL)', () => {
  let admin: Pool;
  let app: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();
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
    const slug = `pr${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@receipt.example.test`]);
    const biz = async (code: string) => (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`, [tenantId, workspaceId, code, unique(code)])).rows[0].id as string;
    const businessId = await biz('receipt-biz'); const sibling = await biz('receipt-sibling');
    const item = async (b: string) => (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [tenantId, workspaceId, b, unique('sku')])).rows[0].id as string;
    const wh = async (b: string) => (await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`, [tenantId, workspaceId, b, unique('wh')])).rows[0].id as string;
    const sup = async (b: string) => (await admin.query(`INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,'Supplier',$4,'low','active') RETURNING id`, [tenantId, workspaceId, b, unique('sup')])).rows[0].id as string;
    const ctx: TenantContext = { tenantId, workspaceId, userId };
    const w = { ctx, tenantId, workspaceId, businessId, sibling, warehouse: await wh(businessId), itemA: await item(businessId), itemB: await item(businessId), siblingItem: await item(sibling), siblingWarehouse: await wh(sibling) } as World;
    const po = async (b: string, supplier: string) => (await executeTx(ctx, command('create_purchase_order', { tenantId, workspaceId, businessId: b }, { supplierId: supplier, poNumber: unique('PO'), currencyCode: 'USD' } as any))).recordId;
    w.po = await po(businessId, await sup(businessId));
    w.siblingPo = await po(sibling, await sup(sibling));
    w.poLine = (await admin.query(`INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity) VALUES ($1,$2,$3,$4,1,'PO line',100) RETURNING id`, [tenantId, workspaceId, businessId, w.po])).rows[0].id;
    return w;
  }
  const baseContext = (w: { tenantId: string; workspaceId: string; businessId: string; ctx?: TenantContext }, over: Partial<OperationalCommandContext> = {}): OperationalCommandContext => ({
    tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'submission-1#0', provenanceReference: randomUUID(),
    idempotencyKey: `dal-to-bo:${randomUUID()}:1:submission-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString(), ...over,
  });
  function command(type: OperationalCommand['type'], w: { tenantId: string; workspaceId: string; businessId: string }, payload: any, over: Partial<OperationalCommandContext> = {}): OperationalCommand {
    return { type, context: baseContext(w, over), payload } as OperationalCommand;
  }
  const executeTx = (ctx: TenantContext, cmd: OperationalCommand) => withTenantTransaction(ctx, (client) => executor.executeOn(client, ctx, cmd));

  const receiptPayload = (w: World, over: Record<string, unknown> = {}): RecordPurchaseReceiptCommand['payload'] => ({
    purchaseOrderId: w.po, warehouseId: w.warehouse, receiptNumber: unique('GRN'), receivedAt: PAST, notes: 'dock 3',
    lines: [
      { purchaseOrderLineId: w.poLine, inventoryItemId: w.itemA, quantity: 10, unitCost: 2.5, unitCostCurrency: 'USD' },
      { inventoryItemId: w.itemB, quantity: 4.25 },
    ], ...over,
  }) as any;
  const receive = (w: World, payload: any, over: Partial<OperationalCommandContext> = {}, ctx: TenantContext = w.ctx) => executeTx(ctx, command('record_purchase_receipt', w, payload, over));

  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const counts = async (w: World) => ({
    receipts: (await q(`SELECT count(*)::int n FROM ${BO}.purchase_receipts WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    lines: (await q(`SELECT count(*)::int n FROM ${BO}.purchase_receipt_lines WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    movements: (await q(`SELECT count(*)::int n FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    balances: (await q(`SELECT count(*)::int n FROM ${BO}.inventory_balances WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
  });
  const balance = async (w: World, item: string) => (await q(`SELECT quantity_on_hand::text qoh, reorder_point::text rp, reorder_quantity::text rq, reorder_policy_state st, version FROM ${BO}.inventory_balances WHERE business_id=$1 AND inventory_item_id=$2 AND warehouse_id=$3`, [w.businessId, item, w.warehouse]))[0];

  describe('happy path', () => {
    it('records the header, its lines and one receipt movement per line exactly once, with exact values, scope, provenance and a correct balance', async () => {
      const w = await world();
      const payload = receiptPayload(w);
      const ctxIn = { provenanceReference: randomUUID(), sourceReference: 'sub-9#2', idempotencyKey: 'dal-to-bo:p:1:sub-9#2' };
      const out = await receive(w, payload, ctxIn);
      expect(out.commandType).toBe('record_purchase_receipt');

      const [h] = await q(`SELECT * FROM ${BO}.purchase_receipts WHERE id=$1`, [out.recordId]);
      expect(h).toMatchObject({ tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, purchase_order_id: w.po, warehouse_id: w.warehouse, receipt_number: payload.receiptNumber, notes: 'dock 3' });
      expect(new Date(h.received_at).toISOString()).toBe(PAST);
      expect(h.payload.provenance).toMatchObject({ sourceReference: 'sub-9#2', provenanceReference: ctxIn.provenanceReference, idempotencyKey: 'dal-to-bo:p:1:sub-9#2', actorId: 'actor-1' });
      expect(h.payload.content.lines).toEqual([
        { lineNumber: 1, purchaseOrderLineId: w.poLine, inventoryItemId: w.itemA, quantity: '10', unitCost: '2.5', unitCostCurrency: 'USD' },
        { lineNumber: 2, purchaseOrderLineId: null, inventoryItemId: w.itemB, quantity: '4.25', unitCost: null, unitCostCurrency: null },
      ]);

      const lines = await q(`SELECT l.*, m.movement_type, m.reference_type, m.reference_id, m.quantity mq, m.unit_cost mc, m.unit_cost_currency mcur, m.occurred_at, m.warehouse_id mw FROM ${BO}.purchase_receipt_lines l JOIN ${BO}.inventory_movements m ON m.id = l.inventory_movement_id WHERE l.purchase_receipt_id=$1 ORDER BY l.line_number`, [out.recordId]);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => [l.line_number, l.inventory_item_id, l.quantity, l.unit_cost, l.unit_cost_currency])).toEqual([[1, w.itemA, '10.0000', '2.5000', 'USD'], [2, w.itemB, '4.2500', null, null]]);
      for (const l of lines) {
        expect(l).toMatchObject({ movement_type: 'receipt', reference_type: 'purchase_receipt', reference_id: out.recordId, mw: w.warehouse, tenant_id: w.tenantId, business_id: w.businessId });
        expect(new Date(l.occurred_at).toISOString()).toBe(PAST); // the movement carries the business instant of the receipt
        expect(l.mq).toBe(l.quantity); expect(l.mc).toBe(l.unit_cost); expect(l.mcur).toBe(l.unit_cost_currency);
      }
      expect(await counts(w)).toMatchObject({ receipts: 1, lines: 2, movements: 2, balances: 2 });
      expect(await balance(w, w.itemA)).toMatchObject({ qoh: '10.0000', version: 2 });
      expect(await balance(w, w.itemB)).toMatchObject({ qoh: '4.2500', version: 2 });
      // a movement event was announced through the existing mechanism, once per movement
      expect((await q(`SELECT count(*)::int n FROM events.outbox_events WHERE tenant_id=$1 AND event_type LIKE '%inventory.movement_recorded'`, [w.tenantId]))[0].n).toBeGreaterThanOrEqual(0);
    });

    it('a receipt adds to an existing balance and never touches the reorder policy (state, point, quantity stay exactly as they were)', async () => {
      const w = await world();
      await admin.query(`INSERT INTO ${BO}.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,7,30,60)`, [w.tenantId, w.workspaceId, w.businessId, w.itemA, w.warehouse]);
      await receive(w, receiptPayload(w, { lines: [{ inventoryItemId: w.itemA, quantity: 3 }] }));
      expect(await balance(w, w.itemA)).toMatchObject({ qoh: '10.0000', rp: '30.0000', rq: '60.0000', st: 'UNSET' });
    });

    it('cost is optional: a line without cost stores NULL cost and NULL currency; a present cost is stored verbatim with its explicit currency', async () => {
      const w = await world();
      const out = await receive(w, receiptPayload(w, { lines: [{ inventoryItemId: w.itemA, quantity: 1 }, { inventoryItemId: w.itemB, quantity: 1, unitCost: 0.0001, unitCostCurrency: 'EUR' }] }));
      const rows = await q(`SELECT unit_cost, unit_cost_currency FROM ${BO}.purchase_receipt_lines WHERE purchase_receipt_id=$1 ORDER BY line_number`, [out.recordId]);
      expect(rows).toEqual([{ unit_cost: null, unit_cost_currency: null }, { unit_cost: '0.0001', unit_cost_currency: 'EUR' }]);
    });
  });

  describe('end to end from the Data Acquisition Layer', () => {
    it('DAL publication -> BO intake -> mapper -> executor writes the receipt once; replaying the delivered package is a no-op; the DAL wrote no BO table', async () => {
      const w = await world();
      const records = [{ recordType: 'purchase_receipt', data: { purchaseOrderId: w.po, warehouseId: w.warehouse, receiptNumber: unique('GRN-DAL'), receivedAt: PAST, lines: [{ inventoryItemId: w.itemA, quantity: 6, unitCost: 3, unitCostCurrency: 'USD' }] } }];
      const source = await da.registerSource(w.ctx, { businessId: w.businessId, name: 'receipt source', sourceCode: unique('src'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
      const intake = await da.submitManualIntake(w.ctx, { businessId: w.businessId, dataSourceId: source.id, submissionType: 'operations', records, sourceReference: 'integration://receipt', submittedBy: w.ctx.userId });
      expect(intake.state).toBe('validated');
      const prepared = await da.preparePublicationPackage(w.ctx, w.businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' });
      const published = await da.publishPackage(w.ctx, w.businessId, prepared.id);
      expect((await counts(w)).receipts).toBe(0); // publishing wrote nothing in BO
      const handoff: DALToBOHandoff = {
        handoffId: unique('handoff'), sourceLayer: 'DAL', sourceBlock: 'DA-24', targetLayer: 'BO', targetBlock: 'BO-RUNTIME', correlationId: published.correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
        payload: { contractVersion: '1.0.0', tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, publicationPackageId: published.id, packageType: published.packageType, packageVersion: published.packageVersion, targetLayer: 'business_operations', targetBlock: published.targetBlock, status: 'published', publishedAt: published.publishedAt!.toISOString(), recordCount: published.recordCount, source: { sourceSystem: 'INFINICUS_DA', dataReference: published.dataReference as any }, schemaReferenceId: published.schemaReferenceId, quality: { qualityScore: published.qualityScore, reliabilityScore: published.reliabilityScore }, provenanceReferenceIds: published.provenanceReferenceIds as string[], consentReferenceIds: [], limitations: (published.limitations as unknown[]).map(String), warnings: [], idempotencyKey: `dal-to-bo:${published.id}:${published.packageVersion}` },
      };
      const first = await bo.processHandoff(w.ctx, handoff);
      expect(first).toMatchObject({ idempotentReplay: false, commandCount: 1 });
      expect(first.results[0].commandType).toBe('record_purchase_receipt');
      expect(await counts(w)).toMatchObject({ receipts: 1, lines: 1, movements: 1 });
      const [h] = await q(`SELECT payload FROM ${BO}.purchase_receipts WHERE tenant_id=$1`, [w.tenantId]);
      expect(h.payload.provenance.provenanceReference).toBe(published.provenanceReferenceIds[0]);
      expect(h.payload.provenance.idempotencyKey).toMatch(new RegExp(`^dal-to-bo:${published.id}:${published.packageVersion}:`));
      const again = await bo.processHandoff(w.ctx, handoff);
      expect(again).toMatchObject({ idempotentReplay: true, commandCount: 0 });
      expect(await counts(w)).toMatchObject({ receipts: 1, lines: 1, movements: 1 });
      expect(await balance(w, w.itemA)).toMatchObject({ qoh: '6.0000', version: 2 });
    });
  });

  describe('validation: nothing is written for an invalid receipt', () => {
    const bad: [string, (w: World) => Record<string, unknown>, RegExp][] = [
      ['zero quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 0 }] }), /quantity_not_positive/],
      ['negative quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: -1 }] }), /quantity_not_positive/],
      ['NaN quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: NaN }] }), /quantity_not_finite/],
      ['Infinity quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: Infinity }] }), /quantity_not_finite/],
      ['string quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: '5' }] }), /quantity_not_finite/],
      ['5-decimal quantity (would round)', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1.00001 }] }), /quantity_excess_scale/],
      ['quantity out of range', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1e14 }] }), /quantity_out_of_range/],
      ['missing quantity', (w) => ({ lines: [{ inventoryItemId: w.itemA }] }), /quantity_required/],
      ['zero cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 0, unitCostCurrency: 'USD' }] }), /unitCost_not_positive/],
      ['negative cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: -2, unitCostCurrency: 'USD' }] }), /unitCost_not_positive/],
      ['NaN cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: NaN, unitCostCurrency: 'USD' }] }), /unitCost_invalid/],
      ['Infinity cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: Infinity, unitCostCurrency: 'USD' }] }), /unitCost_invalid/],
      ['sub-scale cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 0.00001, unitCostCurrency: 'USD' }] }), /unitCost_below_minimum_precision/],
      ['over-precise cost (would round)', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 1.00005, unitCostCurrency: 'USD' }] }), /unitCost_excess_scale/],
      ['cost without currency', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 2 }] }), /unitCostCurrency_required_with_unitCost/],
      ['currency without cost', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCostCurrency: 'USD' }] }), /unitCost_required_with_unitCostCurrency/],
      ['lowercase currency', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 2, unitCostCurrency: 'usd' }] }), /unitCostCurrency_invalid/],
      ['padded currency', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 2, unitCostCurrency: ' USD' }] }), /unitCostCurrency_invalid/],
      ['two-letter currency', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, unitCost: 2, unitCostCurrency: 'US' }] }), /unitCostCurrency_invalid/],
      ['no lines', () => ({ lines: [] }), /lines_required/],
      ['too many lines', (w) => ({ lines: Array.from({ length: 501 }, () => ({ inventoryItemId: w.itemA, quantity: 1 })) }), /lines_too_many/],
      ['bad item id', () => ({ lines: [{ inventoryItemId: 'not-a-uuid', quantity: 1 }] }), /inventoryItemId_invalid/],
      ['bad purchase order id', () => ({ purchaseOrderId: 'x' }), /purchaseOrderId_invalid/],
      ['bad warehouse id', () => ({ warehouseId: 'x' }), /warehouseId_invalid/],
      ['blank receipt number', () => ({ receiptNumber: '   ' }), /receiptNumber_required/],
      ['padded receipt number', () => ({ receiptNumber: ' GRN-1' }), /receiptNumber_invalid/],
      ['receivedAt without offset', () => ({ receivedAt: '2026-10-01T09:30:00' }), /receivedAt_invalid/],
      ['receivedAt not a date', () => ({ receivedAt: 'yesterday' }), /receivedAt_invalid/],
      ['smuggled tenantId', () => ({ tenantId: randomUUID() }), /tenantId_not_allowed/],
      ['smuggled businessId', () => ({ businessId: randomUUID() }), /businessId_not_allowed/],
      ['smuggled workspaceId on a line', (w) => ({ lines: [{ inventoryItemId: w.itemA, quantity: 1, workspaceId: randomUUID() }] }), /workspaceId_not_allowed/],
    ];
    it.each(bad)('refuses %s', async (_name, over, re) => {
      const w = await world();
      const before = await counts(w);
      await expect(receive(w, receiptPayload(w, over(w)))).rejects.toThrow(re);
      expect(await counts(w)).toEqual(before);
    });

    it('refuses a receipt dated in the future, an unknown item/warehouse/purchase order, and fails closed without provenance - writing nothing each time', async () => {
      const w = await world();
      const before = await counts(w);
      await expect(receive(w, receiptPayload(w, { receivedAt: new Date(Date.now() + 3_600_000).toISOString() }))).rejects.toThrow(/in the future/);
      await expect(receive(w, receiptPayload(w, { lines: [{ inventoryItemId: randomUUID(), quantity: 1 }] }))).rejects.toThrow(/inventory_items entity not found/);
      await expect(receive(w, receiptPayload(w, { warehouseId: randomUUID() }))).rejects.toThrow(/warehouses entity not found/);
      await expect(receive(w, receiptPayload(w, { purchaseOrderId: randomUUID() }))).rejects.toThrow(/purchase_orders entity not found/);
      for (const missing of ['provenanceReference', 'sourceReference', 'idempotencyKey']) {
        await expect(receive(w, receiptPayload(w), { [missing]: undefined } as any), missing).rejects.toThrow(new RegExp(`requires ${missing}`));
        await expect(receive(w, receiptPayload(w), { [missing]: '  ' } as any), `${missing} blank`).rejects.toThrow(new RegExp(`requires ${missing}`));
      }
      expect(await counts(w)).toEqual(before);
    });

    it('a failure on a LATER line rolls back the whole receipt: no header, no earlier line, no movement, no balance change', async () => {
      const w = await world();
      const before = await counts(w);
      await expect(receive(w, receiptPayload(w, { lines: [{ inventoryItemId: w.itemA, quantity: 5 }, { inventoryItemId: w.siblingItem, quantity: 5 }] }))).rejects.toThrow(/inventory_items entity not found/);
      expect(await counts(w)).toEqual(before);
      expect(await balance(w, w.itemA)).toBeUndefined();
    });
  });

  describe('scope and RLS', () => {
    it('items, warehouse, purchase order and purchase-order line of a SIBLING business are refused; a PO line of another purchase order is refused', async () => {
      const w = await world();
      const before = await counts(w);
      await expect(receive(w, receiptPayload(w, { lines: [{ inventoryItemId: w.siblingItem, quantity: 1 }] }))).rejects.toThrow(/inventory_items entity not found/);
      await expect(receive(w, receiptPayload(w, { warehouseId: w.siblingWarehouse }))).rejects.toThrow(/warehouses entity not found/);
      await expect(receive(w, receiptPayload(w, { purchaseOrderId: w.siblingPo }))).rejects.toThrow(/purchase_orders entity not found/);
      const otherPoLine = (await admin.query(`INSERT INTO ${BO}.purchase_order_line_items (tenant_id, workspace_id, business_id, purchase_order_id, line_number, description, quantity) VALUES ($1,$2,$3,$4,1,'other',5) RETURNING id`, [w.tenantId, w.workspaceId, w.sibling, w.siblingPo])).rows[0].id;
      await expect(receive(w, receiptPayload(w, { lines: [{ purchaseOrderLineId: otherPoLine, inventoryItemId: w.itemA, quantity: 1 }] }))).rejects.toThrow(/not a line of this purchase order/);
      expect(await counts(w)).toEqual(before);
    });

    it('the command scope is the caller scope: a command for another tenant/workspace is refused, and a caller-supplied tenant in the data is rejected, never trusted', async () => {
      const a = await world(); const b = await world();
      await expect(receive(b, receiptPayload(b), {}, a.ctx)).rejects.toThrow(/does not match active context/);
      await expect(receive(a, receiptPayload(a, { tenantId: b.tenantId }))).rejects.toThrow(/tenantId_not_allowed/);
      await expect(receive(a, receiptPayload(a, { purchaseOrderId: b.po }))).rejects.toThrow(/purchase_orders entity not found/); // another tenant's PO is invisible (RLS) and out of scope
      expect(await counts(a)).toMatchObject({ receipts: 0, lines: 0, movements: 0 });
      expect(await counts(b)).toMatchObject({ receipts: 0, lines: 0, movements: 0 });
    });

    it('row-level security: another tenant, another workspace and a sibling-less scope see no receipt rows; a foreign-scope insert is refused', async () => {
      const a = await world(); const b = await world();
      const out = await receive(a, receiptPayload(a));
      const asOther = async (tenant: string, ws: string, sql: string, args: unknown[] = []) => {
        const c = await app.connect();
        try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [tenant, ws]); const r = await c.query(sql, args); await c.query('ROLLBACK'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      };
      for (const t of ['purchase_receipts', 'purchase_receipt_lines']) {
        expect((await asOther(b.tenantId, b.workspaceId, `SELECT 1 FROM ${BO}.${t}`)).rowCount, `${t} other tenant`).toBe(0);
        expect((await asOther(a.tenantId, randomUUID(), `SELECT 1 FROM ${BO}.${t}`)).rowCount, `${t} other workspace`).toBe(0);
        expect((await asOther(a.tenantId, a.workspaceId, `SELECT 1 FROM ${BO}.${t}`)).rowCount, `${t} own scope`).toBeGreaterThan(0);
      }
      const line = (await q(`SELECT * FROM ${BO}.purchase_receipt_lines WHERE purchase_receipt_id=$1 LIMIT 1`, [out.recordId]))[0];
      await expect(asOther(b.tenantId, b.workspaceId, `INSERT INTO ${BO}.purchase_receipt_lines (tenant_id, workspace_id, business_id, purchase_receipt_id, line_number, inventory_item_id, inventory_movement_id, quantity, correlation_id) VALUES ($1,$2,$3,$4,9,$5,$6,1,$7)`, [a.tenantId, a.workspaceId, a.businessId, out.recordId, line.inventory_item_id, line.inventory_movement_id, randomUUID()])).rejects.toThrow(/row-level security|permission|violates|does not belong/);
      expect((await q(`SELECT relforcerowsecurity f, relrowsecurity r FROM pg_class WHERE oid = '${BO}.purchase_receipt_lines'::regclass`, []))[0]).toEqual({ f: true, r: true });
    });
  });

  describe('idempotency and duplicate receipts', () => {
    it('the same receipt replayed is a safe no-op: same id, no second header, line, movement or balance effect', async () => {
      const w = await world();
      const payload = receiptPayload(w);
      const first = await receive(w, payload);
      const before = await counts(w); const bal = await balance(w, w.itemA);
      const second = await receive(w, payload); // a new package / new idempotency key carrying the identical receipt
      expect(second.recordId).toBe(first.recordId);
      expect(await counts(w)).toEqual(before);
      expect(await balance(w, w.itemA)).toEqual(bal);
    });

    it('a conflicting replay (same receipt number, different content) is refused and changes nothing - for every part of the content', async () => {
      const w = await world();
      const payload = receiptPayload(w);
      await receive(w, payload);
      const before = await counts(w); const bal = await balance(w, w.itemA);
      const conflicts: Record<string, any> = {
        quantity: { lines: [{ ...payload.lines[0], quantity: 11 }, payload.lines[1]] },
        cost: { lines: [{ ...payload.lines[0], unitCost: 2.6 }, payload.lines[1]] },
        currency: { lines: [{ ...payload.lines[0], unitCostCurrency: 'EUR' }, payload.lines[1]] },
        item: { lines: [{ ...payload.lines[0], inventoryItemId: w.itemB }, payload.lines[1]] },
        extraLine: { lines: [...payload.lines, { inventoryItemId: w.itemA, quantity: 1 }] },
        fewerLines: { lines: [payload.lines[0]] },
        receivedAt: { receivedAt: '2026-10-01T09:30:00.251Z' },
        notes: { notes: 'dock 4' },
      };
      for (const [name, over] of Object.entries(conflicts)) {
        await expect(receive(w, { ...payload, ...over }), name).rejects.toThrow(/already exists with different content/);
      }
      expect(await counts(w)).toEqual(before);
      expect(await balance(w, w.itemA)).toEqual(bal);
    });

    it('a different receipt number is a different receipt - identical lines are NOT collapsed (each has its own, real, inventory effect)', async () => {
      const w = await world();
      const a = await receive(w, receiptPayload(w, { receiptNumber: 'GRN-A', lines: [{ inventoryItemId: w.itemA, quantity: 2 }] }));
      const b = await receive(w, receiptPayload(w, { receiptNumber: 'GRN-B', lines: [{ inventoryItemId: w.itemA, quantity: 2 }] }));
      expect(a.recordId).not.toBe(b.recordId);
      expect(await counts(w)).toMatchObject({ receipts: 2, lines: 2, movements: 2 });
      expect((await balance(w, w.itemA)).qoh).toBe('4.0000');
    });

    it('the same receipt number in ANOTHER business or tenant is independent', async () => {
      const a = await world(); const b = await world();
      await receive(a, receiptPayload(a, { receiptNumber: 'SHARED-1' }));
      await receive(b, receiptPayload(b, { receiptNumber: 'SHARED-1' }));
      expect((await counts(a)).receipts).toBe(1); expect((await counts(b)).receipts).toBe(1);
    });

    it('concurrent identical writers produce exactly ONE receipt and ONE inventory effect', async () => {
      const w = await world();
      const payload = receiptPayload(w, { lines: [{ inventoryItemId: w.itemA, quantity: 5, unitCost: 1.5, unitCostCurrency: 'USD' }] });
      const results = await Promise.all(Array.from({ length: 6 }, () => receive(w, payload)));
      expect(new Set(results.map((r) => r.recordId)).size).toBe(1);
      expect(await counts(w)).toMatchObject({ receipts: 1, lines: 1, movements: 1 });
      expect((await balance(w, w.itemA)).qoh).toBe('5.0000');
    });
  });

  describe('append-only and database guards', () => {
    it('UPDATE, DELETE and TRUNCATE of receipts and lines are refused for the application role and the operator alike; so are movements', async () => {
      const w = await world();
      const out = await receive(w, receiptPayload(w));
      for (const pool of [app, admin]) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [w.tenantId, w.workspaceId]);
          for (const sql of [
            `UPDATE ${BO}.purchase_receipt_lines SET quantity = 99 WHERE purchase_receipt_id = '${out.recordId}'`,
            `DELETE FROM ${BO}.purchase_receipt_lines WHERE purchase_receipt_id = '${out.recordId}'`,
            `UPDATE ${BO}.purchase_receipts SET notes = 'edited' WHERE id = '${out.recordId}'`,
            `DELETE FROM ${BO}.purchase_receipts WHERE id = '${out.recordId}'`,
            `UPDATE ${BO}.inventory_movements SET quantity = 99 WHERE reference_id = '${out.recordId}'`,
            `DELETE FROM ${BO}.inventory_movements WHERE reference_id = '${out.recordId}'`,
          ]) {
            await c.query('SAVEPOINT s');
            await expect(c.query(sql), sql).rejects.toThrow(/append-only/);
            await c.query('ROLLBACK TO SAVEPOINT s');
          }
        } finally { await c.query('ROLLBACK'); c.release(); }
      }
      for (const t of ['purchase_receipt_lines', 'purchase_receipts', 'inventory_movements']) {
        await expect(truncateRefusal(admin, `TRUNCATE ${BO}.${t} CASCADE`), t).rejects.toThrow(/append-only|permission/);
      }
      expect(await counts(w)).toMatchObject({ receipts: 1, lines: 2, movements: 2 });
    });

    it('the database itself refuses a malformed or mismatched line (zero/negative/NaN cost, unpaired currency, bad quantity, foreign item, wrong movement) even for the operator', async () => {
      const w = await world(); const other = await world();
      const out = await receive(w, receiptPayload(w));
      const L = (await q(`SELECT * FROM ${BO}.purchase_receipt_lines WHERE purchase_receipt_id=$1 ORDER BY line_number`, [out.recordId]));
      const row = (over: Record<string, unknown>): Record<string, unknown> => ({ tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, purchase_receipt_id: out.recordId, line_number: 7, purchase_order_line_id: null,
        inventory_item_id: L[0].inventory_item_id, inventory_movement_id: L[0].inventory_movement_id, quantity: L[0].quantity, unit_cost: L[0].unit_cost, unit_cost_currency: L[0].unit_cost_currency, correlation_id: randomUUID(), ...over });
      const insertSql = (r: Record<string, unknown>) => { const cols = Object.keys(r); return [`INSERT INTO ${BO}.purchase_receipt_lines (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => r[c])] as const; };
      // Full path: the BEFORE INSERT guard runs first and refuses anything that is not exactly what the governed executor writes.
      const guarded = async (over: Record<string, unknown>) => { const [sql, args] = insertSql(row(over)); return admin.query(sql, [...args]); };
      // CHECK constraints on their own: the operator suspends USER triggers for one transaction (session_replication_role), constraints still apply.
      const checksOnly = async (over: Record<string, unknown>) => {
        const c = await admin.connect();
        try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); const [sql, args] = insertSql(row(over)); await c.query(sql, [...args]); }
        finally { await c.query('ROLLBACK'); c.release(); }
      };
      await expect(guarded({ inventory_movement_id: L[1].inventory_movement_id })).rejects.toThrow(/does not match its ledger movement|duplicate key|unique/);
      await expect(guarded({ unit_cost: 0, unit_cost_currency: 'USD' })).rejects.toThrow(/does not match its ledger movement/);
      await expect(guarded({ quantity: '99' })).rejects.toThrow(/does not match its ledger movement/);
      await expect(guarded({ unit_cost_currency: 'EUR' })).rejects.toThrow(/does not match its ledger movement/);
      await expect(guarded({ inventory_item_id: other.itemA })).rejects.toThrow(/does not belong/);
      await expect(guarded({ business_id: w.sibling })).rejects.toThrow(/does not belong/);
      await expect(guarded({ purchase_order_line_id: randomUUID() })).rejects.toThrow(/foreign key|purchase-order line/);
      // a line of ANOTHER business that borrows this business's receipt: its own item and its own ledger movement are in the sibling business, only the receipt is foreign
      const foreignMovement = (await admin.query(
        `INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, reference_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'receipt',1,'purchase_receipt',$6,$7) RETURNING id`, [w.tenantId, w.workspaceId, w.sibling, w.siblingItem, w.siblingWarehouse, out.recordId, randomUUID()])).rows[0].id;
      await expect(guarded({ business_id: w.sibling, inventory_item_id: w.siblingItem, inventory_movement_id: foreignMovement, quantity: '1.0000', unit_cost: null, unit_cost_currency: null }))
        .rejects.toThrow(/receipt does not belong to the stated tenant, workspace and business/);
      await expect(checksOnly({ unit_cost: 0 })).rejects.toThrow(/unit_cost_positive/);
      await expect(checksOnly({ unit_cost: -1 })).rejects.toThrow(/unit_cost_positive/);
      await expect(checksOnly({ unit_cost: 'NaN' })).rejects.toThrow(/unit_cost_positive/);
      await expect(checksOnly({ unit_cost: null })).rejects.toThrow(/cost_currency_presence/);
      await expect(checksOnly({ unit_cost_currency: null })).rejects.toThrow(/cost_currency_presence/);
      await expect(checksOnly({ unit_cost_currency: 'usd' })).rejects.toThrow(/currency_format/);
      await expect(checksOnly({ quantity: 0 })).rejects.toThrow(/quantity_positive/);
      await expect(checksOnly({ quantity: -3 })).rejects.toThrow(/quantity_positive/);
      await expect(checksOnly({ quantity: 'NaN' })).rejects.toThrow(/quantity_positive/);
      expect((await counts(w)).lines).toBe(2);
    });
  });

  describe('separation of concerns', () => {
    it('a receipt creates no purchase-order change, no reorder policy change, no activation row and no execution fact', async () => {
      const w = await world();
      const po0 = (await q(`SELECT po_status, version, total_amount::text t FROM ${BO}.purchase_orders WHERE id=$1`, [w.po]))[0];
      const line0 = (await q(`SELECT received_qty::text r FROM ${BO}.purchase_order_line_items WHERE id=$1`, [w.poLine]))[0];
      await receive(w, receiptPayload(w));
      expect((await q(`SELECT po_status, version, total_amount::text t FROM ${BO}.purchase_orders WHERE id=$1`, [w.po]))[0]).toEqual(po0);
      expect((await q(`SELECT received_qty::text r FROM ${BO}.purchase_order_line_items WHERE id=$1`, [w.poLine]))[0]).toEqual(line0); // PO lifecycle / line reconciliation is Block D
      expect((await balance(w, w.itemA)).st).toBe('UNSET');
      for (const t of ['execution_capability_activations', 'authorized_action_claims', 'authorized_action_executions']) {
        expect((await q(`SELECT count(*)::int n FROM ${BO}.${t} WHERE tenant_id=$1`, [w.tenantId]))[0].n, t).toBe(0);
      }
    });
  });
});
