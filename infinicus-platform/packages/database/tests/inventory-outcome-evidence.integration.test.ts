import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { InventoryOutcomeEvidenceRepository } from '../src/repositories/bo/InventoryOutcomeEvidenceRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const bounds = { baselineOpenedAt: '2026-10-19T00:00:00.000Z', baselineClosedAt: '2026-10-20T00:00:00.000Z',
  windowOpenedAt: '2026-10-20T00:00:00.000Z', windowClosedAt: '2026-10-21T00:00:00.000Z' };

describe.runIf(run)('BO inventory outcome evidence port', () => {
  let admin: Pool;
  let ctx: TenantContext;
  let businessId: string;
  let itemId: string;
  let warehouseId: string;
  const reader = new InventoryOutcomeEvidenceRepository();

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    const tenantId = randomUUID(); const workspaceId = randomUUID(); businessId = randomUUID();
    itemId = randomUUID(); warehouseId = randomUUID();
    ctx = { tenantId, workspaceId, userId: randomUUID() };
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'OM source',$2,'active','test')`, [tenantId, `om-${tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'OM source',$3,'active')`, [workspaceId, tenantId, `om-${workspaceId}`]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'OM source',$4,'active')`, [businessId, tenantId, workspaceId, `om-${businessId}`]);
    await admin.query(`INSERT INTO platform.inventory_items (id,tenant_id,workspace_id,business_id,sku,name) VALUES ($1,$2,$3,$4,$5,'OM item')`, [itemId, tenantId, workspaceId, businessId, `om-${itemId}`]);
    await admin.query(`INSERT INTO platform.warehouses (id,tenant_id,workspace_id,business_id,warehouse_code,name) VALUES ($1,$2,$3,$4,$5,'OM warehouse')`, [warehouseId, tenantId, workspaceId, businessId, `om-${warehouseId}`]);
    await admin.query(`INSERT INTO business_operations.inventory_balances (tenant_id,workspace_id,business_id,inventory_item_id,warehouse_id) VALUES ($1,$2,$3,$4,$5)`, [tenantId, workspaceId, businessId, itemId, warehouseId]);
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const input = () => ({ businessId, inventoryItemId: itemId, ...bounds });
  const issue = (occurredAt: string, quantity: number, warehouse = warehouseId) => admin.query(
    `INSERT INTO business_operations.inventory_movements
      (tenant_id,workspace_id,business_id,inventory_item_id,warehouse_id,movement_type,quantity,occurred_at)
      VALUES ($1,$2,$3,$4,$5,'issue',$6,$7)`,
    [ctx.tenantId, ctx.workspaceId, businessId, itemId, warehouse, quantity, occurredAt]);

  it('returns exact scoped issue events and a stable digest without treating them as stock-outs', async () => {
    await issue('2026-10-19T12:00:00.000Z', 2);
    await issue('2026-10-20T12:00:00.000Z', 3);
    const first = await reader.readIssues(ctx, input());
    const second = await reader.readIssues(ctx, input());
    expect(first).toMatchObject({ targetStatus: 'single_balance', truncated: false, baseline: [{ quantity: '2.0000' }], window: [{ quantity: '3.0000' }] });
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
    await issue('2026-10-20T18:00:00.000Z', 1);
    expect((await reader.readIssues(ctx, input())).digest).not.toBe(first.digest);
  });

  it('fails closed for a different tenant or ambiguous item balance', async () => {
    const foreign = { ...ctx, tenantId: randomUUID(), workspaceId: randomUUID() };
    expect((await reader.readIssues(foreign, input())).targetStatus).toBe('missing');
    const anotherWarehouse = randomUUID();
    await admin.query(`INSERT INTO platform.warehouses (id,tenant_id,workspace_id,business_id,warehouse_code,name) VALUES ($1,$2,$3,$4,$5,'OM warehouse 2')`,
      [anotherWarehouse, ctx.tenantId, ctx.workspaceId, businessId, `om-${anotherWarehouse}`]);
    await admin.query(`INSERT INTO business_operations.inventory_balances (tenant_id,workspace_id,business_id,inventory_item_id,warehouse_id) VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, ctx.workspaceId, businessId, itemId, anotherWarehouse]);
    expect((await reader.readIssues(ctx, input())).targetStatus).toBe('ambiguous');
  });
});
