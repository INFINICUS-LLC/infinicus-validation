import { cookies } from 'next/headers';
import { ensurePool } from './db';
import { resolveContext, type ContextResult } from './context';

export const SESSION_COOKIE = 'inf_session';
export const WORKSPACE_COOKIE = 'inf_workspace';

/** Reads the HttpOnly session cookie and the workspace selector, then resolves the context server-side. */
export async function requireServerContext(permissions: readonly string[]): Promise<ContextResult> {
  // cookies() first: it marks the page dynamic, so nothing here (or the database) is touched during `next build`.
  const jar = await cookies();
  ensurePool();
  return resolveContext(
    { sessionToken: jar.get(SESSION_COOKIE)?.value, workspaceClaim: jar.get(WORKSPACE_COOKIE)?.value },
    permissions,
  );
}
