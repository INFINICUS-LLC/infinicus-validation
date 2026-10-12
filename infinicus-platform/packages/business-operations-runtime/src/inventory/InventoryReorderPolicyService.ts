/**
 * Data-capture Block E - the canonical Business Operations path for deliberately configuring a balance's reorder policy.
 *
 * It runs the `configure_inventory_reorder_policy` command through the single BO command writer (OperationalCommandExecutor) inside one
 * tenant-scoped transaction. There is no HTTP route and no ABA/DAL path to this write; the authorized-package path (P0-6c) will reuse the
 * same command. Permission checks belong to the caller that exposes it.
 */
import { withTenantTransaction, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor, type ReorderPolicyConfigurationResult } from '../OperationalCommandExecutor.js';
import type { ConfigureInventoryReorderPolicyCommand } from '../types.js';

export class InventoryReorderPolicyService {
  constructor(private readonly executor = new OperationalCommandExecutor()) {}

  async configure(ctx: TenantContext, command: ConfigureInventoryReorderPolicyCommand): Promise<ReorderPolicyConfigurationResult> {
    return withTenantTransaction(ctx, (client) => this.executor.configureInventoryReorderPolicy(client, ctx, command));
  }
}
