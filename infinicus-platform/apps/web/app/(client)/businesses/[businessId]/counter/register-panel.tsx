'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { ApiClient, Scope } from '../../../../../lib/client/apiClient';
import { formatAmount } from '../../../../../lib/client/counter';
import { RegisterController, type RegisterState } from '../../../../../lib/client/register';

/** One register controller per business and workspace; it is rebuilt when either changes. */
export function useRegister(api: ApiClient | null, scope: Scope | null, businessId: string | null): { controller: RegisterController | null; state: RegisterState } {
  const tenantId = scope?.tenantId;
  const workspaceId = scope?.workspaceId;
  const controller = useMemo(
    () => (api && tenantId && workspaceId && businessId ? new RegisterController(api, { tenantId, workspaceId }, businessId) : null),
    [api, tenantId, workspaceId, businessId],
  );
  const empty = useMemo<RegisterState>(() => ({ loaded: false, session: null, summary: null, justClosed: null, busy: false, message: null, retryable: false }), []);
  const state = useSyncExternalStore(
    (listener) => (controller ? controller.subscribe(listener) : () => undefined),
    () => (controller ? controller.getState() : empty),
    () => empty,
  );
  return { controller, state };
}

export interface RegisterPanelProps {
  state: RegisterState;
  /** The cash amount being typed (kept by the page). */
  cashText: string;
  /** True once the person asked to close and must confirm. */
  confirmingClose: boolean;
  /** False when the typed amount is not a valid number (so the action buttons stay off). */
  cashValid: boolean;
  onCashChange: (text: string) => void;
  onOpen: () => void;
  onAskClose: () => void;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

/** Presentational register panel (no data access). Every amount shown is the server's. Buttons are disabled while an action is in flight. */
export function RegisterPanelView(p: RegisterPanelProps) {
  const { state } = p;
  const { session, summary, justClosed, busy, message, retryable, loaded } = state;
  const locked = busy || retryable;
  const money = (n: number, code: string | null | undefined): string => `${code ?? ''} ${formatAmount(n, code)}`.trim();
  return (
    <section className="counter-register card" aria-labelledby="register-heading" aria-busy={busy}>
      <h2 id="register-heading">Register</h2>
      {message ? (
        <p className="notice danger" role="alert">
          {message}
          {retryable ? (
            <>
              {' '}<button type="button" onClick={p.onRetry} disabled={busy}>Retry</button>{' '}
              <button type="button" className="secondary" onClick={p.onDiscard} disabled={busy}>Discard and reload</button>
            </>
          ) : null}
        </p>
      ) : null}
      {!loaded && !message ? <p role="status" aria-live="polite">Loading the register…</p> : null}
      {justClosed ? (
        <p className="notice" role="status">
          Register closed. Counted {money(justClosed.closingCash ?? 0, justClosed.currencyCode)}, expected {money(justClosed.expectedCash ?? 0, justClosed.currencyCode)}, difference {money(justClosed.variance ?? 0, justClosed.currencyCode)}.
        </p>
      ) : null}
      {loaded && !session ? (
        <>
          <p className="empty-state">The register is closed. Open it with the starting cash to take orders.</p>
          <p>
            <label htmlFor="register-cash">Starting cash</label>{' '}
            <input id="register-cash" inputMode="decimal" autoComplete="off" value={p.cashText} onChange={(e) => p.onCashChange(e.target.value)} disabled={locked} />{' '}
            <button type="button" onClick={p.onOpen} disabled={locked || !p.cashValid}>Open register</button>
          </p>
        </>
      ) : null}
      {session ? (
        <>
          <p><strong>{session.registerName}</strong> <span className="status-badge">{session.status}</span> {session.currencyCode ? <span>({session.currencyCode})</span> : null}</p>
          <p>Starting cash {money(session.openingCash, session.currencyCode)}</p>
          {session.currencyCode === null ? (
            <p className="notice danger" role="alert">This register was opened before currencies were recorded. Close it and open a new one to take orders.</p>
          ) : null}
          {summary ? (
            <p role="status" aria-live="polite">
              {summary.ordersCompleted} completed, {summary.ordersPlanned} open, {summary.ordersVoided} voided. Sales {money(summary.completedSalesTotal, session.currencyCode)}
            </p>
          ) : null}
          {summary ? (
            <p role="status" aria-live="polite">
              Taken: cash {money(summary.tenders.cash, session.currencyCode)}, card {money(summary.tenders.card, session.currencyCode)}, other {money(summary.tenders.other, session.currencyCode)}.
              {' '}Cash that should be in the drawer: <strong>{money(summary.expectedCash, session.currencyCode)}</strong>
            </p>
          ) : null}
          {!p.confirmingClose ? (
            <p>
              <label htmlFor="register-cash">Counted cash</label>{' '}
              <input id="register-cash" inputMode="decimal" autoComplete="off" value={p.cashText} onChange={(e) => p.onCashChange(e.target.value)} disabled={locked} />{' '}
              <button type="button" className="secondary" onClick={p.onAskClose} disabled={locked || !p.cashValid}>Close register</button>
            </p>
          ) : (
            <div className="confirm" role="group" aria-label="Confirm closing the register">
              <p>Close the register with counted cash <strong>{money(Number(p.cashText), session.currencyCode)}</strong>? Orders can no longer be taken until it is opened again.</p>
              <button type="button" onClick={p.onConfirmClose} disabled={locked}>Confirm: close register</button>{' '}
              <button type="button" className="secondary" onClick={p.onCancelClose} disabled={busy}>Cancel</button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
