'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useParams } from 'next/navigation';
import { z } from 'zod';
import { SalesHistoryController, type SalesHistoryState } from '../../../../../lib/client/salesHistory';
import { businessListSchema } from '../../../../../lib/client/schemas';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { SalesHistoryView } from './sales-view';

const idSchema = z.string().uuid();
const EMPTY: SalesHistoryState = { orders: [], busy: true, message: null, hasOlder: false, hasNewer: false, selectedId: null, receipt: null };

export default function SalesPage() {
  const { state, api } = useAuth();
  const { scope } = useRequireWorkspace();
  const params = useParams<{ businessId: string }>();
  const businessId = idSchema.safeParse(params.businessId).success ? params.businessId : null;
  // Optional receipt heading only; no business name is guessed if the list does not contain this business.
  const businesses = useScopedResource(scope && businessId ? '/v1/businesses' : null, businessListSchema);
  const history = useMemo(() => api && scope && businessId ? new SalesHistoryController(api, scope, businessId) : null, [api, scope, businessId]);
  const historyState = useSyncExternalStore(
    listener => history ? history.subscribe(listener) : () => undefined,
    () => history ? history.getState() : EMPTY,
    () => EMPTY,
  );
  useEffect(() => { if (history) void history.refresh(); }, [history]);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  const businessName = businesses.resource.kind === 'ok' ? businesses.resource.data.items.find(b => b.id === businessId)?.legalName ?? null : null;
  return <div>
    <h1>Sales history</h1>
    <p><a href={`/businesses/${businessId}/counter`}>&larr; Back to counter</a></p>
    <SalesHistoryView state={historyState} businessName={businessName}
      onRefresh={() => { if (history) void history.refresh(); }}
      onOlder={() => { if (history) void history.older(); }}
      onNewer={() => { if (history) void history.newer(); }}
      onReceipt={id => { if (history) void history.openReceipt(id); }}
      onCloseReceipt={() => history?.closeReceipt()} />
  </div>;
}
