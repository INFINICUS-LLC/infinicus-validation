/** POS2-04-S2 configuration boundary. This does not apply a sale effect or write stock. */
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

export interface PosInventoryMappingCommand {
  businessId: string;
  catalogProductId: string;
  inventoryItemId?: string;
  warehouseId?: string;
  /** Supply this only to deactivate the currently active mapping for catalogProductId. */
  deactivateMappingId?: string;
  correlationId: string;
}

export interface PosInventoryMappingResult { mappingId: string; changed: boolean }

export class PosInventoryMappingRepository {
  /**
   * The function checks the trusted transaction scope, current actor membership and existing bo:admin permission,
   * serializes per product, and writes immutable transition history. No public route is exposed in S2.
   */
  async configure(ctx: TenantContext, input: PosInventoryMappingCommand): Promise<PosInventoryMappingResult> {
    if (!input.deactivateMappingId && (!input.inventoryItemId || !input.warehouseId)) {
      throw new Error('inventory item and warehouse are required for mapping creation');
    }
    return withTenantTransaction(ctx, async client => {
      const result = await client.query<{ mapping_id: string; changed: boolean }>(
        `SELECT * FROM business_operations.configure_pos_inventory_mapping($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.catalogProductId,
          input.inventoryItemId ?? null, input.warehouseId ?? null, ctx.userId, input.correlationId, input.deactivateMappingId ?? null],
      );
      return { mappingId: result.rows[0].mapping_id, changed: result.rows[0].changed };
    });
  }
}
