import { createHash } from 'node:crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MOVEMENTS = 10_000;
const iso = (value: Date | string) => new Date(value).toISOString();

/** BO-owned, immutable issue movements. An issue proves demand, not a stock-out or a beneficial outcome. */
export interface InventoryIssueEvidence {
  id: string;
  warehouseId: string;
  quantity: string;
  occurredAt: string;
  createdAt: string;
}

export interface InventoryOutcomeEvidence {
  targetStatus: 'single_balance' | 'missing' | 'ambiguous';
  balanceId: string | null;
  warehouseId: string | null;
  baseline: InventoryIssueEvidence[];
  window: InventoryIssueEvidence[];
  truncated: boolean;
  capturedAt: string;
  /** SHA-256 of the bounded BO facts and exact query bounds, excluding the changing read timestamp. */
  digest: string;
}

export interface InventoryOutcomeEvidenceInput {
  businessId: string;
  inventoryItemId: string;
  baselineOpenedAt: string;
  baselineClosedAt: string;
  windowOpenedAt: string;
  windowClosedAt: string;
}

/** Read-only Business Operations port. No OM table or user-entered observation is consulted. */
export class InventoryOutcomeEvidenceRepository {
  async readIssues(ctx: TenantContext, input: InventoryOutcomeEvidenceInput): Promise<InventoryOutcomeEvidence> {
    if (!UUID.test(input.businessId) || !UUID.test(input.inventoryItemId)) throw new Error('inventory evidence requires scoped UUIDs');
    const bounds = [input.baselineOpenedAt, input.baselineClosedAt, input.windowOpenedAt, input.windowClosedAt].map((value) => new Date(value).getTime());
    if (bounds.some((value) => !Number.isFinite(value)) || bounds[0] >= bounds[1] || bounds[1] > bounds[2] || bounds[2] >= bounds[3]) {
      throw new Error('inventory evidence requires ordered, non-overlapping baseline and window');
    }
    return withTenantTransaction(ctx, async (client) => {
      // One statement means balance cardinality, issue rows and database time share one MVCC snapshot.
      const result = await client.query<{
        balances: { id: string; warehouse_id: string }[];
        movements: { id: string; warehouse_id: string; quantity: string; occurred_at: string; created_at: string }[];
        captured_at: Date;
      }>(
        `WITH balances AS (
           SELECT id, warehouse_id FROM business_operations.inventory_balances
            WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 AND inventory_item_id = $4
            ORDER BY id LIMIT 2
         ), movements AS (
           SELECT id, warehouse_id, quantity::text AS quantity, occurred_at, created_at
             FROM business_operations.inventory_movements
            WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 AND inventory_item_id = $4
              AND (SELECT count(*) FROM balances) = 1
              AND warehouse_id = (SELECT warehouse_id FROM balances LIMIT 1)
              AND movement_type = 'issue'
              AND ((occurred_at > $5::timestamptz AND occurred_at <= $6::timestamptz)
                OR (occurred_at > $7::timestamptz AND occurred_at <= $8::timestamptz))
            ORDER BY occurred_at, id LIMIT 10001
         )
         SELECT clock_timestamp() AS captured_at,
                coalesce((SELECT jsonb_agg(to_jsonb(b)) FROM balances b), '[]'::jsonb) AS balances,
                coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.occurred_at, m.id) FROM movements m), '[]'::jsonb) AS movements`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.inventoryItemId,
          input.baselineOpenedAt, input.baselineClosedAt, input.windowOpenedAt, input.windowClosedAt]);
      const row = result.rows[0];
      const balance = row.balances.length === 1 ? row.balances[0] : null;
      const all = row.movements.slice(0, MAX_MOVEMENTS).map((row) => ({
        id: row.id, warehouseId: row.warehouse_id, quantity: row.quantity,
        occurredAt: iso(row.occurred_at), createdAt: iso(row.created_at),
      }));
      const baselineClosedAt = bounds[1]; const windowOpenedAt = bounds[2];
      const baseline = all.filter((row) => new Date(row.occurredAt).getTime() <= baselineClosedAt);
      const window = all.filter((row) => new Date(row.occurredAt).getTime() > windowOpenedAt);
      const targetStatus = row.balances.length === 0 ? 'missing' : balance ? 'single_balance' : 'ambiguous';
      const payload = { businessId: input.businessId, inventoryItemId: input.inventoryItemId,
        balanceId: balance?.id ?? null, warehouseId: balance?.warehouse_id ?? null,
        baselineOpenedAt: iso(input.baselineOpenedAt), baselineClosedAt: iso(input.baselineClosedAt),
        windowOpenedAt: iso(input.windowOpenedAt), windowClosedAt: iso(input.windowClosedAt),
        targetStatus, baseline, window, truncated: row.movements.length > MAX_MOVEMENTS };
      return { targetStatus, balanceId: payload.balanceId, warehouseId: payload.warehouseId,
        baseline, window, truncated: payload.truncated,
        capturedAt: iso(row.captured_at),
        digest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}` };
    });
  }
}
