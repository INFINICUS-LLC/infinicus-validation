'use client';

import { useMemo } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { declaredCurrencyHistoryPath, declaredCurrencyHistorySchema, declaredCurrencyPath, declaredCurrencySchema } from '../../../../../lib/client/businessAdministration';
import { BusinessView } from './business-view';

export default function BusinessPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const currentPath = useMemo(() => (businessId ? declaredCurrencyPath(businessId) : null), [businessId]);
  const historyPath = useMemo(() => (businessId ? declaredCurrencyHistoryPath(businessId) : null), [businessId]);
  const current = useScopedResource(scope && currentPath ? currentPath : null, declaredCurrencySchema);
  const history = useScopedResource(scope && historyPath ? historyPath : null, declaredCurrencyHistorySchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Business</h1>
    <BusinessView current={current.resource} history={history.resource} />
  </div>;
}
