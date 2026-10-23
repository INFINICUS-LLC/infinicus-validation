'use client';

import { useMemo } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { workforcePath, workforceSchema } from '../../../../../lib/client/workforce';
import { StaffView } from './staff-view';

export default function StaffPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const path = useMemo(() => (businessId ? workforcePath(businessId) : null), [businessId]);
  const { resource } = useScopedResource(scope && path ? path : null, workforceSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Staff</h1>
    <StaffView resource={resource} />
  </div>;
}
