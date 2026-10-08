import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthorizationService } from '@infinicus/authorization';

const authzService = new AuthorizationService();

/**
 * Factory: app.requirePermission('aba:write') returns a preHandler that
 * must run after authenticate + resolveTenantContext. Delegates entirely
 * to AuthorizationService.authorize, which is fail-closed and already
 * records a permission_denied access event on every denial (BUILD-18) —
 * this plugin adds no authorization logic of its own.
 */
export default fp(async function permissionPlugin(app: FastifyInstance) {
  app.decorate('requirePermission', (permissionCode: string) => {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!request.ctx) {
        const err = new Error('requirePermission requires resolveTenantContext to run first');
        err.name = 'PermissionDeniedError';
        throw err;
      }
      await authzService.authorize(request.ctx, permissionCode);
    };
  });

  /**
   * Factory: app.requireAllPermissions(['bo:read', 'dt:read', ...]) returns a preHandler that requires EVERY listed
   * permission (AND, never OR). For routes whose response aggregates several layers, so that no single unrelated
   * permission can stand in for the others. Permissions are authorized in the order given; the first one the caller
   * lacks fails the request (fail-closed, and AuthorizationService records that denial). An empty list is a
   * programming error and throws when the route is declared, so a misconfigured route can never register as open.
   */
  app.decorate('requireAllPermissions', (permissionCodes: readonly string[]) => {
    const codes = [...new Set(permissionCodes)];
    if (codes.length === 0) throw new Error('requireAllPermissions requires at least one permission code');
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!request.ctx) {
        const err = new Error('requireAllPermissions requires resolveTenantContext to run first');
        err.name = 'PermissionDeniedError';
        throw err;
      }
      for (const code of codes) {
        await authzService.authorize(request.ctx, code);
      }
    };
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (permissionCode: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAllPermissions: (permissionCodes: readonly string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
