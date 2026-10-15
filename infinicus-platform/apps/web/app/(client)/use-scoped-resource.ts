'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ZodType } from 'zod';
import { fetchScoped, type Resource } from '../../lib/client/resource';
import { useAuth } from './auth-provider';

/** GET a /v1 resource in the selected workspace, validated against `schema`. Reloads when the workspace or path changes; `reload` refetches. */
export function useScopedResource<T>(path: string | null, schema: ZodType<T>): { resource: Resource<T>; reload: () => void } {
  const { state, api } = useAuth();
  const scope = state.status === 'ready' ? state.scope : null;
  const tenantId = scope?.tenantId;
  const workspaceId = scope?.workspaceId;
  const [resource, setResource] = useState<Resource<T>>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!api || !path || !tenantId || !workspaceId) return;
    let cancelled = false;
    setResource({ kind: 'loading' });
    void fetchScoped(api, path, schema, { tenantId, workspaceId }).then((result) => { if (!cancelled) setResource(result); });
    return () => { cancelled = true; };
  }, [api, path, schema, tenantId, workspaceId, nonce]);

  return { resource, reload: useCallback(() => setNonce((n) => n + 1), []) };
}
