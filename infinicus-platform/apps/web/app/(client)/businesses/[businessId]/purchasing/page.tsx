'use client';

import { useMemo, useState } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { purchaseOrdersPath, purchaseOrdersSchema, suppliersPath, suppliersSchema, type PoStatus } from '../../../../../lib/client/purchasing';
import { PurchasingView } from './purchasing-view';

export default function PurchasingPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const [status, setStatus] = useState<PoStatus | null>(null);
  const ordersPath = useMemo(() => (businessId ? purchaseOrdersPath(businessId, status) : null), [businessId, status]);
  const suppliersUrl = useMemo(() => (businessId ? suppliersPath(businessId) : null), [businessId]);
  const orders = useScopedResource(scope && ordersPath ? ordersPath : null, purchaseOrdersSchema);
  const suppliers = useScopedResource(scope && suppliersUrl ? suppliersUrl : null, suppliersSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Purchasing</h1>
    <PurchasingView orders={orders.resource} suppliers={suppliers.resource} status={status} onStatus={setStatus} />
  </div>;
}
