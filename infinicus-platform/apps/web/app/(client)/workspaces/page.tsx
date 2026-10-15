'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../auth-provider';
import { StateNotice } from '../state-notice';
import { scopeOf } from '../../../lib/client/workspaces';

export default function WorkspacesPage() {
  const { state, selectWorkspace } = useAuth();
  const router = useRouter();

  useEffect(() => { if (state.status === 'signed-out') router.replace('/sign-in'); }, [state, router]);

  if (state.status !== 'ready') return <StateNotice state={state} />;

  return (
    <div>
      <h1>Choose a workspace</h1>
      {state.memberships.length === 0 ? (
        <p className="empty-state">You are not an active member of any workspace yet. Ask a workspace owner to invite you, or finish setting up your own business.</p>
      ) : (
        <ul className="business-list" aria-label="Your workspaces">
          {state.memberships.map((m) => {
            const selected = state.scope?.workspaceId === m.workspaceId;
            return (
              <li key={m.workspaceId}>
                <button type="button" className={selected ? undefined : 'secondary'} aria-pressed={selected} onClick={() => { if (selectWorkspace(scopeOf(m))) router.push('/console'); }}>
                  <strong>{m.tenantName}</strong> / {m.workspaceName}
                </button>{' '}
                <span className="status-badge">{m.workspaceStatus}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
