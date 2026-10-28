'use client';

import { useMemo } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { collectionRunsPath, collectionRunsSchema, dataSourcesPath, dataSourcesSchema } from '../../../../../lib/client/dataAcquisition';
import { DataView } from './data-view';

export default function DataPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const sourcesPath = useMemo(() => (businessId ? dataSourcesPath(businessId) : null), [businessId]);
  const runsPath = useMemo(() => (businessId ? collectionRunsPath(businessId) : null), [businessId]);
  const sources = useScopedResource(scope && sourcesPath ? sourcesPath : null, dataSourcesSchema);
  const runs = useScopedResource(scope && runsPath ? runsPath : null, collectionRunsSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Data</h1>
    <DataView sources={sources.resource} runs={runs.resource} />
  </div>;
}
