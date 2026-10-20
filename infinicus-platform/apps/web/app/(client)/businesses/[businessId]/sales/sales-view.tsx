'use client';

import type { SalesHistoryState } from '../../../../../lib/client/salesHistory';
import type { ReactNode } from 'react';
import { defaultFormatDate } from '../../../../../lib/client/receipt';
import { formatMoney } from '../../../../../lib/client/currency';

interface Props {
  state: SalesHistoryState;
  receiptContent?: ReactNode;
  onRefresh: () => void;
  onOlder: () => void;
  onNewer: () => void;
  onReceipt: (id: string) => void;
  onCloseReceipt: () => void;
}

/** Read-only: uses server totals and the existing receipt renderer, with no sale/payment mutation controls. */
export function SalesHistoryView({ state, receiptContent, onRefresh, onOlder, onNewer, onReceipt, onCloseReceipt }: Props) {
  return <div className="sales-history">
    <section className="card" aria-labelledby="sales-heading" aria-busy={state.busy}>
      <h2 id="sales-heading">Completed sales</h2>
      <p>Most recent first. Open a sale to view or reprint its recorded receipt.</p>
      <button type="button" className="secondary" onClick={onRefresh} disabled={state.busy}>Refresh sales</button>
      {state.busy ? <p role="status">Loading sales…</p> : null}
      {state.message ? <p className="notice danger" role="alert">{state.message}</p> : null}
      {!state.busy && !state.message && state.orders.length === 0 ? <p className="empty-state">No completed sales on this page.</p> : null}
      <ul className="open-orders" aria-label="Completed sales">
        {state.orders.map(order => <li key={order.id}>
          <span><strong>{order.orderNumber}</strong><br />{defaultFormatDate(order.createdAt)}</span>
          <span className="line-total">{order.currencyCode} {formatMoney(order.totalAmount, order.currencyCode)}</span>
          <button type="button" className="secondary" aria-label={`View receipt for ${order.orderNumber}`} aria-pressed={state.selectedId === order.id} onClick={() => onReceipt(order.id)} disabled={state.busy}>View receipt</button>
        </li>)}
      </ul>
      <nav aria-label="Sales pages">
        <button type="button" className="secondary" onClick={onNewer} disabled={state.busy || !state.hasNewer}>Newer sales</button>{' '}
        <button type="button" className="secondary" onClick={onOlder} disabled={state.busy || !state.hasOlder}>Older sales</button>
      </nav>
    </section>
    {state.receipt?.kind === 'loading' ? <p role="status">Loading receipt… <button type="button" className="secondary" onClick={onCloseReceipt}>Close receipt</button></p> : null}
    {state.receipt?.kind === 'error' ? <p className="notice danger" role="alert">{state.receipt.message}{' '}
      <button type="button" className="secondary" onClick={() => { if (state.selectedId) onReceipt(state.selectedId); }}>Retry receipt</button>{' '}
      <button type="button" className="secondary" onClick={onCloseReceipt}>Close receipt</button>
    </p> : null}
    {state.receipt?.kind === 'ok' ? receiptContent : null}
  </div>;
}
