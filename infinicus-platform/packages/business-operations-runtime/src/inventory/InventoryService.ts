import {
  InventoryBalanceRepository,
  type InventoryBalance,
  type TenantContext,
  withTenantTransaction,
} from '@infinicus/database';

export interface InventoryBalanceView {
  id: string;
  inventoryItemId: string;
  warehouseId: string;
  itemName: string;
  sku: string;
  warehouseName: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  reorderPoint: number;
  reorderQuantity: number;
  lastMovementAt: Date | null;
}

export class InventoryService {
  constructor(private readonly balances = new InventoryBalanceRepository()) {}

  async getBalance(
    ctx: TenantContext,
    businessId: string,
    inventoryItemId: string,
    warehouseId: string
  ): Promise<InventoryBalance> {
    const balance = await this.balances.findByItemAndWarehouse(ctx, inventoryItemId, warehouseId);
    if (balance.businessId !== businessId) throw new Error('InventoryBalance not found');
    return balance;
  }

  async listBalances(
    ctx: TenantContext,
    businessId: string,
    limit = 50
  ): Promise<InventoryBalanceView[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT b.id, b.inventory_item_id, b.warehouse_id,
                i.name AS item_name, i.sku,
                w.name AS warehouse_name,
                b.quantity_on_hand, b.quantity_reserved, b.quantity_available,
                b.reorder_point, b.reorder_quantity, b.last_movement_at
         FROM business_operations.inventory_balances b
         JOIN platform.inventory_items i ON i.id = b.inventory_item_id
         JOIN platform.warehouses w ON w.id = b.warehouse_id
         WHERE b.business_id = $1
         ORDER BY i.name, w.name
         LIMIT $2`,
        [businessId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        inventoryItemId: row.inventory_item_id as string,
        warehouseId: row.warehouse_id as string,
        itemName: row.item_name as string,
        sku: row.sku as string,
        warehouseName: row.warehouse_name as string,
        quantityOnHand: Number(row.quantity_on_hand),
        quantityReserved: Number(row.quantity_reserved),
        quantityAvailable: Number(row.quantity_available),
        reorderPoint: Number(row.reorder_point),
        reorderQuantity: Number(row.reorder_quantity),
        lastMovementAt: row.last_movement_at as Date | null,
      }));
    });
  }

  /**
   * BUILD-32 intentionally does not expose InventoryBalanceRepository.adjustQuantity().
   * Stock-changing commands must be routed through an auditable inventory-movement
   * transaction before this service exposes a mutation API.
   */
}
