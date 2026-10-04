import type { PoolClient } from 'pg';
import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';

export interface EventTransactionContext {
  client: PoolClient;
  tenant: TenantContext;
}

export async function withEventTransaction<T>(
  ctx: TenantContext,
  callback: (tx: EventTransactionContext) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(ctx, async (client) => callback({ client, tenant: ctx }));
}
