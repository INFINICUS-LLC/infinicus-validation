'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { ApiClient, Scope } from '../../../../../lib/client/apiClient';
import { formatAmount } from '../../../../../lib/client/counter';
import { OrderSession, type OrderSessionState } from '../../../../../lib/client/orders';
import type { Order } from '../../../../../lib/client/schemas';

/** One order session per business and workspace; it is rebuilt when either changes. */
export function useOrderSession(api: ApiClient | null, scope: Scope | null, businessId: string | null): { session: OrderSession | null; state: OrderSessionState } {
  const tenantId = scope?.tenantId;
  const workspaceId = scope?.workspaceId;
  const session = useMemo(
    () => (api && tenantId && workspaceId && businessId ? new OrderSession(api, { tenantId, workspaceId }, businessId) : null),
    [api, tenantId, workspaceId, businessId],
  );
  const empty = useMemo<OrderSessionState>(() => ({ order: null, busy: false, message: null, retryable: false }), []);
  const state = useSyncExternalStore(
    (listener) => (session ? session.subscribe(listener) : () => undefined),
    () => (session ? session.getState() : empty),
    () => empty,
  );
  return { session, state };
}

export interface OrderPanelProps {
  state: OrderSessionState;
  openOrders: readonly Order[];
  onStart: () => void;
  onRemove: (lineItemId: string) => void;
  onRetry: () => void;
  onDiscard: () => void;
  onOpen: (orderId: string) => void;
}

/** Presentational order panel (no data access). Every amount shown is the server's. Buttons are disabled while an action is in flight. */
export function OrderPanelView({ state, openOrders, onStart, onRemove, onRetry, onDiscard, onOpen }: OrderPanelProps) {
  const { order, busy, message, retryable } = state;
  const resumable = openOrders.filter((o) => o.id !== order?.id);
  return (
    <section className="counter-order card" aria-labelledby="order-heading" aria-busy={busy}>
      <h2 id="order-heading">Order</h2>
      {message ? (
        <p className="notice danger" role="alert">
          {message}
          {retryable ? (
            <>
              {' '}<button type="button" onClick={onRetry} disabled={busy}>Retry</button>{' '}
              <button type="button" className="secondary" onClick={onDiscard} disabled={busy}>Discard and reload</button>
            </>
          ) : null}
        </p>
      ) : null}
      {!order ? (
        <p className="empty-state">No order open. Start a new order, or resume an open one below.</p>
      ) : (
        <>
          <p><strong>{order.orderNumber}</strong> <span className="status-badge">{order.operationalStatus}</span></p>
          {order.lineItems.length === 0 ? (
            <p className="empty-state">No items yet. Choose a product to add it.</p>
          ) : (
            <ul className="order-lines" aria-label="Order lines">
              {order.lineItems.map((line) => (
                <li key={line.id}>
                  <span>{line.quantity} &times; {line.description}</span>{' '}
                  <span className="line-total">{formatAmount(line.lineTotal)}</span>{' '}
                  <button type="button" className="secondary" aria-label={`Remove ${line.description}`} onClick={() => onRemove(line.id)} disabled={busy || retryable || order.operationalStatus !== 'planned'}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <p className="order-total" role="status" aria-live="polite">Total <strong>{formatAmount(order.totalAmount)}</strong></p>
        </>
      )}
      <p><button type="button" onClick={onStart} disabled={busy || retryable}>New order</button></p>
      {resumable.length > 0 ? (
        <>
          <h3>Open orders</h3>
          <ul className="open-orders" aria-label="Open orders">
            {resumable.map((o) => (
              <li key={o.id}>
                <span>{o.orderNumber}</span> <span className="line-total">{formatAmount(o.totalAmount)}</span>{' '}
                <button type="button" className="secondary" aria-label={`Open ${o.orderNumber}`} onClick={() => onOpen(o.id)} disabled={busy || retryable}>Open</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
