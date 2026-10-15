/**
 * Workspace discovery and selection (NA-04). The list comes from the API (GET /v1/auth/memberships: the caller's own ACTIVE workspaces). A selection is
 * only a claim that is sent on later requests; the API re-verifies membership and permission on each one. The last selection is remembered for the
 * tab session as a convenience and is accepted again only if it still appears in the freshly fetched list.
 */
import { z } from 'zod';
import type { ApiClient, Scope } from './apiClient';

export const membershipsSchema = z.object({
  memberships: z.array(z.object({
    tenantId: z.string().uuid(),
    tenantName: z.string(),
    tenantStatus: z.string(),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    workspaceStatus: z.string(),
  })),
});
export type Membership = z.infer<typeof membershipsSchema>['memberships'][number];

export async function fetchMemberships(api: ApiClient): Promise<Membership[]> {
  const body = await api.get('/v1/auth/memberships', { schema: membershipsSchema });
  return body.memberships;
}

export const SCOPE_STORAGE_KEY = 'inf_web_scope_v1';

export interface TabStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const savedScopeSchema = z.object({ tenantId: z.string().uuid(), workspaceId: z.string().uuid() });

export function loadSavedScope(storage: TabStorage | null): Scope | null {
  try {
    const raw = storage?.getItem(SCOPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = savedScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function saveScope(storage: TabStorage | null, scope: Scope): void {
  try { storage?.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope)); } catch { /* storage unavailable: selection just is not remembered */ }
}
export function forgetScope(storage: TabStorage | null): void {
  try { storage?.removeItem(SCOPE_STORAGE_KEY); } catch { /* ignore */ }
}

export const sameScope = (a: Scope, b: Scope): boolean => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId;
export const scopeOf = (m: Membership): Scope => ({ tenantId: m.tenantId, workspaceId: m.workspaceId });

/** The scope to use after sign-in: the remembered one if it is still listed, else the only workspace if there is exactly one, else none (the user chooses). */
export function pickInitialScope(memberships: Membership[], saved: Scope | null): Scope | null {
  if (saved) {
    const found = memberships.find((m) => sameScope(scopeOf(m), saved));
    if (found) return scopeOf(found);
  }
  return memberships.length === 1 ? scopeOf(memberships[0]) : null;
}
