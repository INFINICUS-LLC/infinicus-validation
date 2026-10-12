/** Test-only live-PostgreSQL world for the inventory policy evaluator and its verifier (B2b/B2c). Superuser inserts; never imported by production code. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantContext } from '@infinicus/database';

const DAY = 86_400_000;
export interface W { ctx: TenantContext; businessId: string; itemId: string; warehouseId: string }
export interface WorldOptions {
  baseline?: [number, number] | null; declared?: string | null; receipt?: { cost: string | null; currency: string | null } | null; issues?: number; issueQty?: number; status?: string;
}

/**
 * Healthy defaults: active item, one warehouse balance (baseline 100/200 unless given), declared USD, a USD receipt at unit cost 10 five
 * days ago, and 12 issues of 75 in the last 12 days (demand 900 over 90 days: reorderPoint >= 175 and reorderPoint + reorderQuantity <= 900).
 * Pass `baseline: [170, 190]` so {reorderPoint: 180, reorderQuantity: 200} is within the 25% change bounds and PASSES every dimension.
 */
export async function makePolicyWorld(admin: Pool, tenantIds: string[], o: WorldOptions = {}): Promise<W> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const businessId = randomUUID(); const itemId = randomUUID(); const warehouseId = randomUUID();
  tenantIds.push(tenantId);
  const slug = `b2b${tenantId.slice(0, 8)}`;
  await admin.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, slug, slug]);
  await admin.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [workspaceId, tenantId, slug, slug]);
  await admin.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [businessId, tenantId, workspaceId, slug, slug]);
  await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'Item',$6)`, [itemId, tenantId, workspaceId, businessId, `sku-${itemId}`, o.status ?? 'active']);
  await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, businessId, `wh-${warehouseId}`]);
  const baseline = o.baseline === undefined ? [100, 200] : o.baseline;
  if (baseline !== null) {
    await admin.query(`INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, workspaceId, businessId, itemId, warehouseId, baseline[0], baseline[1]]);
  }
  const declared = o.declared === undefined ? 'USD' : o.declared;
  if (declared !== null) {
    await admin.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id)
      VALUES ($1,$2,$3,1,$4,'EXPLICIT_DECLARATION',$5,'platform:admin',$6)`, [tenantId, workspaceId, businessId, declared, randomUUID(), randomUUID()]);
  }
  const receipt = o.receipt === undefined ? { cost: '10', currency: 'USD' } : o.receipt;
  const mv = (type: string, qty: number, cost: string | null, currency: string | null, at: Date) => admin.query(
    `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, workspaceId, businessId, itemId, warehouseId, type, qty, cost, currency, at]);
  if (receipt !== null) await mv('receipt', 500, receipt.cost, receipt.currency, new Date(Date.now() - 5 * DAY));
  for (let i = 0; i < (o.issues ?? 12); i += 1) await mv('issue', -(o.issueQty ?? 75), null, null, new Date(Date.now() - (i + 1) * DAY));
  return { ctx: { tenantId, workspaceId, userId: randomUUID() }, businessId, itemId, warehouseId };
}
