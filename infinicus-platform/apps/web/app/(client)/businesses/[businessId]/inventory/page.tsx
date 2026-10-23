'use client';

import { useMemo } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { inventoryPath, inventoryResponseSchema } from '../../../../../lib/client/inventory';
import { InventoryView } from './inventory-view';

export default function InventoryPage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const path = useMemo(() => (businessId ? inventoryPath(businessId) : null), [businessId]);
  const { resource } = useScopedResource(scope && path ? path : null, inventoryResponseSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Inventory</h1>
    <InventoryView resource={resource} />
  </div>;
}
