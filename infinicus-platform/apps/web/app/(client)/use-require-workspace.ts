'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Scope } from '../../lib/client/apiClient';
import { useAuth } from './auth-provider';

/** Sends a signed-out visitor to /sign-in and a signed-in one without a selected workspace to /workspaces. `scope` is non-null only when the page may render. */
export function useRequireWorkspace(): { scope: Scope | null } {
  const { state } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'signed-out') router.replace('/sign-in');
    else if (state.status === 'ready' && !state.scope) router.replace('/workspaces');
  }, [state, router]);
  return { scope: state.status === 'ready' ? state.scope : null };
}
