import { createHash } from 'node:crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FACTS = 100;
const iso = (value: string | Date) => new Date(value).toISOString();

export interface InventoryAttributionInput {
  businessId: string;
  inventoryItemId: string;
  balanceId: string;
  warehouseId: string;
  executionId: string;
  baselineOpenedAt: string;
  windowClosedAt: string;
}

export interface InventoryAttributionEvidence {
  policyChanges: { id: string; balanceId: string; completedAt: string; evidenceDigest: string }[];
  adjustments: { id: string; movementType: string; quantity: string; occurredAt: string; createdAt: string }[];
  truncated: boolean;
  digest: string;
  capturedAt: string;
}

/** BO read port for possible confounders. Any adjustment is conservatively included; no unapproved size threshold is invented. */
export class InventoryAttributionEvidenceRepository {
  async read(ctx: TenantContext, input: InventoryAttributionInput): Promise<InventoryAttributionEvidence> {
    for (const [name, id] of Object.entries({ businessId: input.businessId, inventoryItemId: input.inventoryItemId,
      balanceId: input.balanceId, warehouseId: input.warehouseId, executionId: input.executionId })) {
      if (!UUID.test(id)) throw new Error(`attribution evidence requires lowercase UUID: ${name}`);
    }
    const start = new Date(input.baselineOpenedAt).getTime(); const end = new Date(input.windowClosedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('attribution evidence requires ordered bounds');
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{
        captured_at: Date;
        balance_exists: boolean;
        policy_changes: { id: string; balance_id: string; execution_completed_at: string; evidence_digest: string }[];
        adjustments: { id: string; movement_type: string; quantity: string; occurred_at: string; created_at: string }[];
      }>(
        `WITH target AS (
           SELECT 1 FROM business_operations.inventory_balances
            WHERE id = $5 AND tenant_id = $1 AND workspace_id = $2 AND business_id = $3
              AND inventory_item_id = $4 AND warehouse_id = $6
         ), policies AS (
           SELECT id, balance_id, execution_completed_at, evidence_digest
             FROM business_operations.authorized_action_executions
            WHERE EXISTS (SELECT 1 FROM target) AND tenant_id = $1 AND workspace_id = $2 AND business_id = $3
              AND balance_id = $5 AND target_kind = 'inventory_item' AND target_id = $4::text
              AND action_type_code = 'inventory_reorder_policy_update' AND action_type_schema_version = '1'
              AND outcome = 'SUCCEEDED' AND mutation_result = 'APPLIED' AND id <> $7
              AND execution_completed_at > $8::timestamptz AND execution_completed_at <= $9::timestamptz
            ORDER BY execution_completed_at, id LIMIT 101
         ), adjustments AS (
           SELECT id, movement_type, quantity::text AS quantity, occurred_at, created_at
             FROM business_operations.inventory_movements
            WHERE EXISTS (SELECT 1 FROM target) AND tenant_id = $1 AND workspace_id = $2 AND business_id = $3
              AND inventory_item_id = $4 AND warehouse_id = $6
              AND movement_type IN ('adjustment','cycle_count','write_off')
              AND occurred_at > $8::timestamptz AND occurred_at <= $9::timestamptz
            ORDER BY occurred_at, id LIMIT 101
         )
         SELECT clock_timestamp() AS captured_at, EXISTS (SELECT 1 FROM target) AS balance_exists,
                coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.execution_completed_at,p.id) FROM policies p), '[]'::jsonb) AS policy_changes,
                coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.occurred_at,a.id) FROM adjustments a), '[]'::jsonb) AS adjustments`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.inventoryItemId, input.balanceId,
          input.warehouseId, input.executionId, input.baselineOpenedAt, input.windowClosedAt]);
      const row = result.rows[0];
      if (!row.balance_exists) throw new Error('attribution target is missing or out of scope');
      const policies = row.policy_changes.slice(0, MAX_FACTS).map((p) => ({
        id: p.id, balanceId: p.balance_id, completedAt: iso(p.execution_completed_at), evidenceDigest: p.evidence_digest,
      }));
      const adjustments = row.adjustments.slice(0, MAX_FACTS).map((a) => ({
        id: a.id, movementType: a.movement_type, quantity: a.quantity,
        occurredAt: iso(a.occurred_at), createdAt: iso(a.created_at),
      }));
      const truncated = row.policy_changes.length > MAX_FACTS || row.adjustments.length > MAX_FACTS;
      const payload = { businessId: input.businessId, inventoryItemId: input.inventoryItemId,
        balanceId: input.balanceId, warehouseId: input.warehouseId, executionId: input.executionId,
        baselineOpenedAt: iso(input.baselineOpenedAt), windowClosedAt: iso(input.windowClosedAt),
        policies, adjustments, truncated };
      return { policyChanges: policies, adjustments, truncated,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
        capturedAt: iso(row.captured_at) };
    });
  }
}
