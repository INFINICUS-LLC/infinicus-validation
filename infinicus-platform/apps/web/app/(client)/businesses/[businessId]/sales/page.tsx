'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useBusinessId } from '../use-business-id';
import { SalesHistoryController, type SalesHistoryState } from '../../../../../lib/client/salesHistory';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { BusinessReceipt } from '../counter/business-receipt';
import { SalesHistoryView } from './sales-view';

const EMPTY: SalesHistoryState = { orders: [], busy: true, message: null, hasOlder: false, hasNewer: false, selectedId: null, receipt: null };

export default function SalesPage() {
  const { state, api } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const history = useMemo(() => api && scope && businessId ? new SalesHistoryController(api, scope, businessId) : null, [api, scope, businessId]);
  const historyState = useSyncExternalStore(
    listener => history ? history.subscribe(listener) : () => undefined,
    () => history ? history.getState() : EMPTY,
    () => EMPTY,
  );
  useEffect(() => { if (history) void history.refresh(); }, [history]);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Sales history</h1>
    <SalesHistoryView state={historyState} receiptContent={historyState.receipt?.kind === 'ok' ? <BusinessReceipt key={`${scope.tenantId}/${scope.workspaceId}/${businessId}`} order={historyState.receipt.data} onClose={() => history?.closeReceipt()} /> : null}
      onRefresh={() => { if (history) void history.refresh(); }}
      onOlder={() => { if (history) void history.older(); }}
      onNewer={() => { if (history) void history.newer(); }}
      onReceipt={id => { if (history) void history.openReceipt(id); }}
      onCloseReceipt={() => history?.closeReceipt()} />
  </div>;
}
