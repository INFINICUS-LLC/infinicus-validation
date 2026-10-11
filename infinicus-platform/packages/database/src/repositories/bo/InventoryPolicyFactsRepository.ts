// Block B2b: READ-ONLY Business Operations facts for the inventory policy evaluator.
//
// This repository selects the BO-owned operational facts the approved rule set names and nothing else: the inventory item, its balances,
// its most recent receipt movement and its trailing demand. It mutates nothing, imports no ABA / workflow code and applies no rule. Every
// fact is read in ONE SQL statement, so the whole snapshot is internally consistent (a single MVCC snapshot), and the clock used for the
// demand window is the database clock read in that same statement. Numeric columns are returned as exact decimal TEXT (never as binary
// floats). The caller (the evaluator) interprets them; nothing is repaired, rounded or defaulted here.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface InventoryPolicyFactsItem { id: string; status: string; unitOfMeasure: string }
export interface InventoryPolicyFactsBalance { id: string; warehouseId: string; reorderPoint: string; reorderQuantity: string }
export interface InventoryPolicyFactsReceipt {
  movementId: string;
  /** ISO-8601 UTC, millisecond. */
  occurredAt: string;
  /** Exact decimal text as stored, or 'NaN'; null when the receipt carries no cost. */
  unitCost: string | null;
  unitCostCurrency: string | null;
}
export interface InventoryPolicyFactsDemand {
  /** Number of qualifying movements in the window. */
  count: number;
  /** Sum of the magnitudes (absolute quantities) as exact decimal text. */
  sumOfMagnitudes: string;
}
export interface InventoryPolicyFactsSnapshot {
  /** Database time (ms, ISO UTC) at which the snapshot was taken; also the window end. */
  capturedAt: string;
  windowStartsAt: string;
  windowDays: number;
  demandMovementTypes: string[];
  /** null when the item does not exist in the caller's tenant, workspace and business. */
  item: InventoryPolicyFactsItem | null;
  balances: InventoryPolicyFactsBalance[];
  latestReceipt: InventoryPolicyFactsReceipt | null;
  demand: InventoryPolicyFactsDemand;
}

export interface LoadInventoryPolicyFactsInput {
  businessId: string;
  inventoryItemId: string;
  windowDays: number;
  demandMovementTypes: readonly string[];
}

const iso = (v: unknown): string => new Date(String(v)).toISOString();

export class InventoryPolicyFactsRepository {
  async loadSnapshot(ctx: TenantContext, input: LoadInventoryPolicyFactsInput): Promise<InventoryPolicyFactsSnapshot> {
    if (!UUID.test(input.businessId) || !UUID.test(input.inventoryItemId)) throw new Error('InventoryPolicyFacts: businessId and inventoryItemId must be lowercase UUIDs');
    if (!Number.isInteger(input.windowDays) || input.windowDays < 1) throw new Error('InventoryPolicyFacts: windowDays must be a positive integer');
    if (input.demandMovementTypes.length === 0) throw new Error('InventoryPolicyFacts: at least one demand movement type is required');
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `WITH clock AS (
           SELECT date_trunc('milliseconds', clock_timestamp()) AS now_ts
         ), win AS (
           SELECT now_ts, now_ts - ($5::int * interval '1 day') AS starts_ts FROM clock
         ), it AS (
           SELECT id, status, unit_of_measure FROM platform.inventory_items
            WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4
         ), bal AS (
           SELECT b.id, b.warehouse_id, b.reorder_point::text AS reorder_point, b.reorder_quantity::text AS reorder_quantity
             FROM business_operations.inventory_balances b
            WHERE b.inventory_item_id = $1 AND b.tenant_id = $2 AND b.workspace_id = $3 AND b.business_id = $4
            ORDER BY b.warehouse_id
         ), rcpt AS (
           SELECT m.id, m.occurred_at, m.unit_cost::text AS unit_cost, m.unit_cost_currency
             FROM business_operations.inventory_movements m
            WHERE m.inventory_item_id = $1 AND m.tenant_id = $2 AND m.workspace_id = $3 AND m.business_id = $4 AND m.movement_type = 'receipt'
            ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1
         ), dem AS (
           SELECT count(*)::int AS n, coalesce(sum(abs(m.quantity)), 0)::text AS total
             FROM business_operations.inventory_movements m, win
            WHERE m.inventory_item_id = $1 AND m.tenant_id = $2 AND m.workspace_id = $3 AND m.business_id = $4
              AND m.movement_type = ANY($6::text[]) AND m.occurred_at > win.starts_ts AND m.occurred_at <= win.now_ts
         )
         SELECT (SELECT now_ts FROM win) AS captured_at, (SELECT starts_ts FROM win) AS window_starts_at,
                (SELECT to_jsonb(it) FROM it) AS item,
                coalesce((SELECT jsonb_agg(to_jsonb(bal)) FROM bal), '[]'::jsonb) AS balances,
                (SELECT to_jsonb(rcpt) FROM rcpt) AS receipt,
                (SELECT n FROM dem) AS demand_count, (SELECT total FROM dem) AS demand_sum`,
        [input.inventoryItemId, ctx.tenantId, ctx.workspaceId, input.businessId, input.windowDays, [...input.demandMovementTypes]],
      );
      const row = r.rows[0];
      const item = row.item as { id: string; status: string; unit_of_measure: string } | null;
      const receipt = row.receipt as { id: string; occurred_at: string; unit_cost: string | null; unit_cost_currency: string | null } | null;
      return {
        capturedAt: iso(row.captured_at),
        windowStartsAt: iso(row.window_starts_at),
        windowDays: input.windowDays,
        demandMovementTypes: [...input.demandMovementTypes],
        item: item === null ? null : { id: item.id, status: item.status, unitOfMeasure: item.unit_of_measure },
        balances: (row.balances as { id: string; warehouse_id: string; reorder_point: string; reorder_quantity: string }[])
          .map((b) => ({ id: b.id, warehouseId: b.warehouse_id, reorderPoint: b.reorder_point, reorderQuantity: b.reorder_quantity })),
        latestReceipt: receipt === null ? null : { movementId: receipt.id, occurredAt: iso(receipt.occurred_at), unitCost: receipt.unit_cost, unitCostCurrency: receipt.unit_cost_currency },
        demand: { count: row.demand_count as number, sumOfMagnitudes: row.demand_sum as string },
      };
    });
  }
}
