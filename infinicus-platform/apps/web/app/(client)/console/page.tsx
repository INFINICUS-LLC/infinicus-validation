'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { useAuth } from '../auth-provider';
import { StateNotice } from '../state-notice';
import { ApiError, ApiUnavailableError } from '../../../lib/client/apiClient';

const sessionSchema = z.object({ user: z.object({ id: z.string().uuid(), email: z.string(), status: z.string() }), sessionId: z.string().uuid() });
type Check = { kind: 'checking' } | { kind: 'ok'; status: string } | { kind: 'failed'; message: string };

export default function ConsolePage() {
  const { state, api } = useAuth();
  const router = useRouter();
  const [check, setCheck] = useState<Check>({ kind: 'checking' });

  useEffect(() => {
    if (state.status === 'signed-out') router.replace('/sign-in');
    else if (state.status === 'ready' && !state.scope) router.replace('/workspaces');
  }, [state, router]);

  const ready = state.status === 'ready' && state.scope !== null;
  useEffect(() => {
    if (!ready || !api) return;
    let cancelled = false;
    api.get('/v1/auth/session', { schema: sessionSchema })
      .then((session) => { if (!cancelled) setCheck({ kind: 'ok', status: session.user.status }); })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCheck({ kind: 'failed', message: error instanceof ApiUnavailableError ? 'The service could not be reached.' : error instanceof ApiError ? `The service refused the request (${error.status}).` : 'The connection check failed.' });
      });
    return () => { cancelled = true; };
  }, [ready, api]);

  if (state.status !== 'ready' || !state.scope) return <StateNotice state={state} />;
  const current = state.memberships.find((m) => m.workspaceId === state.scope!.workspaceId);

  return (
    <div className="card">
      <h1>Console</h1>
      <p>Workspace: <strong>{current?.tenantName} / {current?.workspaceName}</strong></p>
      <p role="status" aria-live="polite">
        Connection to the INFINICUS service:{' '}
        {check.kind === 'checking' ? 'checking…' : check.kind === 'ok' ? `connected (account ${check.status})` : check.message}
      </p>
      <p className="empty-state">The decision workflow screens move onto this API in the next block.</p>
    </div>
  );
}
