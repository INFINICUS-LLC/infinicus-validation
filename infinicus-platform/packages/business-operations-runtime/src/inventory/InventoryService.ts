import {
  InventoryBalanceRepository,
  type InventoryBalance,
  type TenantContext,
} from '@infinicus/database';

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

  /**
   * BUILD-32 intentionally does not expose InventoryBalanceRepository.adjustQuantity().
   * Stock-changing commands must be routed through an auditable inventory-movement
   * transaction before this service exposes a mutation API.
   */
}
