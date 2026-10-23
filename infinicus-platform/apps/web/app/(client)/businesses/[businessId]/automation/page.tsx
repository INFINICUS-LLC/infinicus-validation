'use client';

import { useMemo } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { executionHealthPath, executionHealthSchema, outcomeHealthPath, outcomeHealthSchema } from '../../../../../lib/client/automationHealth';
import { AutomationView } from './automation-view';

export default function AutomationPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const executionPath = useMemo(() => (businessId ? executionHealthPath(businessId) : null), [businessId]);
  const outcomePath = useMemo(() => (businessId ? outcomeHealthPath(businessId) : null), [businessId]);
  const execution = useScopedResource(scope && executionPath ? executionPath : null, executionHealthSchema);
  const outcome = useScopedResource(scope && outcomePath ? outcomePath : null, outcomeHealthSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Automation health</h1>
    <AutomationView execution={execution.resource} outcome={outcome.resource} />
  </div>;
}
