'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useBusinessId } from '../use-business-id';
import { NEW_PRINTER, PrintersController, type PrinterDraft, type PrintersState } from '../../../../../lib/client/printers';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useOnline } from '../counter/connection';
import { PrintersView } from './printers-view';

const EMPTY: PrintersState = { printers: [], jobs: [], loaded: false, busy: true, message: null, notice: null };

export default function PrintersPage() {
  const { state, api } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const controller = useMemo(() => (api && scope && businessId ? new PrintersController(api, scope, businessId) : null), [api, scope, businessId]);
  const printers = useSyncExternalStore(
    (listener) => (controller ? controller.subscribe(listener) : () => undefined),
    () => (controller ? controller.getState() : EMPTY),
    () => EMPTY,
  );
  useEffect(() => { if (controller) void controller.refresh(); }, [controller]);
  const online = useOnline();
  const [draft, setDraft] = useState<PrinterDraft>(NEW_PRINTER);
  const [confirmRetireId, setConfirmRetireId] = useState<string | null>(null);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return (
    <div>
      <h1>Printers and print log</h1>
      <PrintersView
        state={printers}
        offline={!online}
        draft={draft}
        confirmRetireId={confirmRetireId}
        onDraftChange={setDraft}
        onAdd={() => { if (controller) void controller.create(draft).then((ok) => { if (ok) setDraft(NEW_PRINTER); }); }}
        onMakeDefault={(id) => { if (controller) void controller.makeDefault(id); }}
        onAskRetire={setConfirmRetireId}
        onConfirmRetire={(id) => { if (controller) void controller.retire(id).then(() => setConfirmRetireId(null)); }}
        onRefresh={() => { if (controller) void controller.refresh(); }}
      />
    </div>
  );
}
