'use client';

import { defaultFormatDate } from '../../../../../lib/client/receipt';
import {
  buildPrinter, CONNECTION_LABELS, FAILURE_LABELS, KIND_LABELS, PRINTER_NAME_MAX, TRIGGER_LABELS,
  type PrinterConnection, type PrinterDraft, type PrinterKind, type PrintersState,
} from '../../../../../lib/client/printers';

export interface PrintersViewProps {
  state: PrintersState;
  offline?: boolean;
  draft: PrinterDraft;
  confirmRetireId: string | null;
  onDraftChange: (draft: PrinterDraft) => void;
  onAdd: () => void;
  onMakeDefault: (printerId: string) => void;
  onAskRetire: (printerId: string | null) => void;
  onConfirmRetire: (printerId: string) => void;
  onRefresh: () => void;
}

/** Presentational (no data access). Changes need an owner or admin; the server decides and says so. Nothing here holds a printer address. */
export function PrintersView({ state, offline = false, draft, confirmRetireId, onDraftChange, onAdd, onMakeDefault, onAskRetire, onConfirmRetire, onRefresh }: PrintersViewProps) {
  const locked = state.busy || offline;
  const check = buildPrinter(draft);
  const nameOf = (id: string | null): string => (id === null ? 'Browser (no registered printer)' : state.printers.find((p) => p.id === id)?.name ?? 'Removed printer');
  const active = state.printers.filter((p) => p.status === 'active');
  const retired = state.printers.filter((p) => p.status === 'retired');
  return (
    <div className="printers">
      {offline ? <p className="notice" role="status">You are offline. Printer changes need a connection.</p> : null}
      {state.message ? <p className="notice danger" role="alert">{state.message}</p> : null}
      {state.notice ? <p className="notice" role="status">{state.notice}</p> : null}

      <section className="card" aria-labelledby="printers-heading" aria-busy={state.busy}>
        <h2 id="printers-heading">Printers</h2>
        <p>The first printer of each kind is its default. The receipt printer&apos;s paper width is used when printing receipts; the kitchen printer&apos;s for kitchen tickets. The printer&apos;s network, Bluetooth or USB address is set in the device app, not here.</p>
        <button type="button" className="secondary" onClick={onRefresh} disabled={state.busy}>Refresh</button>
        {state.busy && !state.loaded ? <p role="status">Loading printers…</p> : null}
        {state.loaded && !state.message && state.printers.length === 0 ? <p className="empty-state">No printers yet. Receipts and kitchen tickets use the browser&apos;s own print dialog until you add one.</p> : null}
        <ul className="open-orders" aria-label="Printers">
          {active.map((p) => (
            <li key={p.id}>
              <span><strong>{p.name}</strong>{p.isDefault ? <> <span className="badge">Default</span></> : null}<br />{KIND_LABELS[p.kind]} &middot; {CONNECTION_LABELS[p.connection]} &middot; {p.paperMm} mm</span>
              {confirmRetireId === p.id ? (
                <span>
                  <button type="button" onClick={() => onConfirmRetire(p.id)} disabled={locked}>Confirm: retire {p.name}</button>{' '}
                  <button type="button" className="secondary" onClick={() => onAskRetire(null)} disabled={state.busy}>Cancel</button>
                </span>
              ) : (
                <span>
                  {!p.isDefault ? <><button type="button" className="secondary" aria-label={`Make ${p.name} the default ${p.kind} printer`} onClick={() => onMakeDefault(p.id)} disabled={locked}>Make default</button>{' '}</> : null}
                  <button type="button" className="secondary" aria-label={`Retire ${p.name}`} onClick={() => onAskRetire(p.id)} disabled={locked}>Retire</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {retired.length > 0 ? (
          <>
            <h3>Retired</h3>
            <ul className="open-orders" aria-label="Retired printers">
              {retired.map((p) => <li key={p.id}><span>{p.name}<br />{KIND_LABELS[p.kind]} &middot; {CONNECTION_LABELS[p.connection]} &middot; {p.paperMm} mm &middot; retired {p.retiredAt ? defaultFormatDate(p.retiredAt) : ''}</span></li>)}
            </ul>
          </>
        ) : null}
      </section>

      <section className="card" aria-labelledby="add-printer-heading">
        <h2 id="add-printer-heading">Add a printer</h2>
        <label>Name <input type="text" value={draft.name} maxLength={PRINTER_NAME_MAX + 20} onChange={(e) => onDraftChange({ ...draft, name: e.target.value })} disabled={locked} /></label>{' '}
        <label>Prints <select value={draft.kind} onChange={(e) => onDraftChange({ ...draft, kind: e.target.value as PrinterKind })} disabled={locked}>
          {(Object.keys(KIND_LABELS) as PrinterKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>{' '}
        <label>Connection <select value={draft.connection} onChange={(e) => onDraftChange({ ...draft, connection: e.target.value as PrinterConnection })} disabled={locked}>
          {(Object.keys(CONNECTION_LABELS) as PrinterConnection[]).map((c) => <option key={c} value={c}>{CONNECTION_LABELS[c]}</option>)}</select></label>{' '}
        <label>Paper <select value={draft.paperMm} onChange={(e) => onDraftChange({ ...draft, paperMm: e.target.value === '58' ? 58 : 80 })} disabled={locked}>
          <option value={80}>80 mm</option><option value={58}>58 mm</option></select></label>{' '}
        <label><input type="checkbox" checked={draft.isDefault} onChange={(e) => onDraftChange({ ...draft, isDefault: e.target.checked })} disabled={locked} /> Make it the default {draft.kind} printer</label>
        {draft.name !== '' && !check.ok ? <p className="notice danger" role="alert">{check.reason}</p> : null}
        <p><button type="button" onClick={onAdd} disabled={locked || !check.ok}>Add printer</button></p>
      </section>

      <section className="card" aria-labelledby="print-log-heading">
        <h2 id="print-log-heading">Recent prints</h2>
        <p>The last prints, newest first: whether they worked, and how they were sent. The log holds no receipt content.</p>
        {state.loaded && state.jobs.length === 0 ? <p className="empty-state">No prints recorded yet.</p> : null}
        <ul className="open-orders" aria-label="Recent prints">
          {state.jobs.map((j) => (
            <li key={j.id}>
              <span><strong>{KIND_LABELS[j.kind]}</strong> &middot; {TRIGGER_LABELS[j.trigger]}<br />{defaultFormatDate(j.createdAt)} &middot; {j.printedVia === 'device' ? 'Device app' : 'Browser'} &middot; {nameOf(j.printerId)}</span>
              <span className={j.outcome === 'failed' ? 'notice danger' : undefined}>{j.outcome === 'succeeded' ? 'Printed' : `Failed: ${j.failureCode ? FAILURE_LABELS[j.failureCode] : 'Other problem'}`}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
