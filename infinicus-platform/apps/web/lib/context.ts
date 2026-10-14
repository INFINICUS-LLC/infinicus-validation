import { AuthenticationService } from '@infinicus/authentication';
import { AuthorizationService } from '@infinicus/authorization';
import { MembershipRepository, type TenantContext } from '@infinicus/database';

/**
 * Server-authoritative request context for apps/web (AC-3 J-2).
 *
 * Identity, role and scope are derived on the server, exactly as the Stack B API does:
 *   session cookie -> AuthenticationService.validateSession (the principal)
 *   -> ACTIVE membership of THAT principal in the claimed workspace
 *   -> per-call permission check (AuthorizationService, read from the database every time).
 *
 * The browser never supplies `userId`. The workspace claim (`<tenantId>:<workspaceId>`, from a cookie) only SELECTS one of
 * the principal's own workspaces; it is accepted only when the principal holds an ACTIVE membership there, so it can never
 * create authority. URL query parameters and form fields are not read for identity or scope at all.
 */
export type ContextFailure = 'unauthenticated' | 'no_workspace' | 'forbidden';
export type ContextResult = { ok: true; ctx: TenantContext } | { ok: false; reason: ContextFailure };

export interface ContextDeps {
  validateSession(token: string): Promise<{ user: { id: string } }>;
  getMembership(ctx: TenantContext, userId: string): Promise<{ status: string }>;
  authorize(ctx: TenantContext, permissionCode: string): Promise<void>;
}

const authentication = new AuthenticationService();
const memberships = new MembershipRepository();
const authorization = new AuthorizationService();

export const defaultContextDeps: ContextDeps = {
  validateSession: (token) => authentication.validateSession(token),
  getMembership: (ctx, userId) => memberships.getByUserAndWorkspace(ctx, userId),
  authorize: (ctx, code) => authorization.authorize(ctx, code),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWorkspaceClaim(claim: string | undefined): { tenantId: string; workspaceId: string } | null {
  if (!claim) return null;
  const [tenantId, workspaceId, extra] = claim.split(':');
  if (extra !== undefined || !tenantId || !workspaceId || !UUID.test(tenantId) || !UUID.test(workspaceId)) return null;
  return { tenantId, workspaceId };
}

/** Resolves the principal and scope, then requires EVERY listed permission (AND, never OR). Fail-closed on any error. */
export async function resolveContext(
  input: { sessionToken?: string; workspaceClaim?: string },
  permissions: readonly string[],
  deps: ContextDeps = defaultContextDeps,
): Promise<ContextResult> {
  if (!input.sessionToken) return { ok: false, reason: 'unauthenticated' };
  let userId: string;
  try {
    userId = (await deps.validateSession(input.sessionToken)).user.id;
  } catch {
    return { ok: false, reason: 'unauthenticated' };
  }
  const claim = parseWorkspaceClaim(input.workspaceClaim);
  if (!claim) return { ok: false, reason: 'no_workspace' };
  const ctx: TenantContext = { tenantId: claim.tenantId, workspaceId: claim.workspaceId, userId };
  try {
    if ((await deps.getMembership(ctx, userId)).status !== 'active') return { ok: false, reason: 'forbidden' };
    for (const code of new Set(permissions)) await deps.authorize(ctx, code);
  } catch {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, ctx };
}
