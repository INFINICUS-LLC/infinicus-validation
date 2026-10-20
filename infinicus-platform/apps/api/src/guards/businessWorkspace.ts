import type { FastifyRequest } from 'fastify';
import { BusinessRepository } from '@infinicus/database';

const businesses = new BusinessRepository();

/** Runs after authentication/context/permission checks and before idempotency can replay a tenant-scoped response.
 * POS route schemas validate businessId before preHandlers run. Visibility always comes from authenticated context.
 */
export async function requireBusinessWorkspace(request: FastifyRequest): Promise<void> {
  const { businessId } = request.params as { businessId: string };
  await businesses.getForWorkspace(request.ctx!, businessId);
}
