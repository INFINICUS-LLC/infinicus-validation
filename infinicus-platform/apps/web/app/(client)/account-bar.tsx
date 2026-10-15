'use client';

import { useAuth } from './auth-provider';

/** Who is signed in, which workspace is selected, and the way out. Shown only once a backend session and workspace list exist. */
export function AccountBar() {
  const { state, signOut } = useAuth();
  if (state.status !== 'ready') return null;
  const current = state.scope ? state.memberships.find((m) => m.workspaceId === state.scope!.workspaceId) : null;
  return (
    <div className="notice" role="region" aria-label="Account">
      Signed in as <strong>{state.email}</strong>
      {current ? <> &middot; {current.tenantName} / {current.workspaceName} &middot; <a href="/workspaces">Change workspace</a></> : <> &middot; <a href="/workspaces">Choose a workspace</a></>}
      {' '}
      <button type="button" className="secondary" onClick={() => { void signOut(); }}>Sign out</button>
    </div>
  );
}
