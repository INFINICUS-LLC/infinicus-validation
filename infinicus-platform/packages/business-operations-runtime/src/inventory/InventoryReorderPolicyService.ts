/**
 * Data-capture Block E - the canonical Business Operations path for deliberately configuring a balance's reorder policy.
 *
 * It runs the `configure_inventory_reorder_policy` command through the single BO command writer (OperationalCommandExecutor) inside one
 * tenant-scoped transaction. The authorized-package path (P0-6c) reuses the same command. Permission checks belong to the caller that exposes it.
 *
 * AC-2 (owner ruling D2): {@link configureInitial} is the BO-owned way for a business to state its FIRST reorder policy (a balance created by Data
 * Acquisition starts UNSET at 0/0, and DAL never sets operational policy). It refuses a balance that is already configured (checked under the row
 * lock), so changing an existing policy remains an authorized action; the change and its audit record commit atomically.
 */
import { withTenantTransaction, type TenantContext } from '@infinicus/database';
import { randomUUID } from 'node:crypto';
import { OperationalCommandExecutor, type ReorderPolicyConfigurationResult } from '../OperationalCommandExecutor.js';
import type { ConfigureInventoryReorderPolicyCommand } from '../types.js';

export interface ConfigureInitialReorderPolicyRequest {
  businessId: string;
  inventoryItemId: string;
  warehouseId: string;
  reorderPoint: number;
  reorderQuantity: number;
  correlationId: string;
}

export class InventoryReorderPolicyService {
  constructor(private readonly executor = new OperationalCommandExecutor()) {}

  async configure(ctx: TenantContext, command: ConfigureInventoryReorderPolicyCommand): Promise<ReorderPolicyConfigurationResult> {
    return withTenantTransaction(ctx, (client) => this.executor.configureInventoryReorderPolicy(client, ctx, command));
  }

  /** `permissionUsed` is the permission the authenticated route authorized the request under (audit); it never comes from the body. */
  async configureInitial(ctx: TenantContext, request: ConfigureInitialReorderPolicyRequest, permissionUsed: string): Promise<ReorderPolicyConfigurationResult> {
    if (typeof permissionUsed !== 'string' || permissionUsed.length === 0) throw new Error('the authorizing permission is required for the audit record');
    return withTenantTransaction(ctx, async (client) => {
      const result = await this.executor.configureInventoryReorderPolicy(client, ctx, {
        type: 'configure_inventory_reorder_policy',
        context: {
          tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: request.businessId, correlationId: request.correlationId,
          sourceReference: 'bo-api:initial-reorder-policy', idempotencyKey: randomUUID(), actorId: ctx.userId, occurredAt: new Date().toISOString(),
        },
        payload: {
          inventoryItemId: request.inventoryItemId, warehouseId: request.warehouseId, reorderPoint: request.reorderPoint, reorderQuantity: request.reorderQuantity,
          configurationSource: 'BO_COMMAND', requireState: 'UNSET',
        },
      });
      await client.query(
        `INSERT INTO audit.audit_events
           (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
         VALUES ($1,$2,$3,'user',$4,'bo.reorder_policy.initial_configured','inventory_balance',$5,$6::jsonb,$7)`,
        [
          ctx.tenantId, ctx.workspaceId, request.businessId, ctx.userId, result.recordId,
          JSON.stringify({ permissionUsed, inventoryItemId: request.inventoryItemId, warehouseId: request.warehouseId, source: 'BO_COMMAND', before: result.before, after: result.after }),
          request.correlationId,
        ],
      );
      return result;
    });
  }
}
