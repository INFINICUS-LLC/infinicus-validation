'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { ApiClient, Scope } from '../../../../../lib/client/apiClient';
import { formatAmount } from '../../../../../lib/client/counter';
import { OrderSession, VOID_REASON_MAX, type OrderSessionState } from '../../../../../lib/client/orders';
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
  /** Complete and void (POS-3). Optional so the earlier read-only uses of the panel keep working. */
  confirm?: 'complete' | 'void' | null;
  voidReason?: string;
  onAsk?: (kind: 'complete' | 'void') => void;
  onCancelAsk?: () => void;
  onConfirm?: () => void;
  onReasonChange?: (reason: string) => void;
  /** False when no register is open: new orders are refused by the server, so the button says why. Undefined = not known yet / not shown. */
  registerOpen?: boolean;
}

const none = (): void => undefined;

/** Presentational order panel (no data access). Every amount shown is the server's. Buttons are disabled while an action is in flight. */
export function OrderPanelView({ state, openOrders, onStart, onRemove, onRetry, onDiscard, onOpen, confirm = null, voidReason = '', onAsk = none, onCancelAsk = none, onConfirm = none, onReasonChange = none, registerOpen }: OrderPanelProps) {
  const { order, busy, message, retryable } = state;
  const planned = order?.operationalStatus === 'planned';
  const locked = busy || retryable;
  const money = (n: number): string => `${order?.currencyCode ?? ''} ${formatAmount(n, order?.currencyCode)}`.trim();
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
                  <span className="line-total">{formatAmount(line.lineTotal, order.currencyCode)}</span>{' '}
                  <button type="button" className="secondary" aria-label={`Remove ${line.description}`} onClick={() => onRemove(line.id)} disabled={busy || retryable || order.operationalStatus !== 'planned'}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <p className="order-total" role="status" aria-live="polite">Total <strong>{money(order.totalAmount)}</strong></p>
          {order.operationalStatus === 'completed' ? (
            <p className="notice" role="status">Sale recorded: {order.orderNumber}, {money(order.totalAmount)}. The order is closed.</p>
          ) : null}
          {order.operationalStatus === 'failed' ? (
            <p className="notice" role="status">Order {order.orderNumber} was voided. No sale was recorded.</p>
          ) : null}
          {planned && !confirm ? (
            <p>
              <button type="button" onClick={() => onAsk('complete')} disabled={locked || order.lineItems.length === 0}>Complete sale</button>{' '}
              <button type="button" className="secondary" onClick={() => onAsk('void')} disabled={locked}>Void order</button>
            </p>
          ) : null}
          {planned && confirm === 'complete' ? (
            <div className="confirm" role="group" aria-label="Confirm completing the sale">
              <p>Complete this sale for <strong>{money(order.totalAmount)}</strong>? This records the sale and the order can no longer be changed.</p>
              <button type="button" onClick={onConfirm} disabled={locked}>Confirm: complete sale</button>{' '}
              <button type="button" className="secondary" onClick={onCancelAsk} disabled={busy}>Cancel</button>
            </div>
          ) : null}
          {planned && confirm === 'void' ? (
            <div className="confirm" role="group" aria-label="Confirm voiding the order">
              <p>Void this order? No sale is recorded and the order can no longer be changed.</p>
              <p>
                <label htmlFor="void-reason">Reason (optional)</label>{' '}
                <input id="void-reason" type="text" maxLength={VOID_REASON_MAX} autoComplete="off" value={voidReason} onChange={(e) => onReasonChange(e.target.value)} disabled={locked} />
              </p>
              <button type="button" onClick={onConfirm} disabled={locked}>Confirm: void order</button>{' '}
              <button type="button" className="secondary" onClick={onCancelAsk} disabled={busy}>Cancel</button>
            </div>
          ) : null}
        </>
      )}
      <p>
        <button type="button" onClick={onStart} disabled={busy || retryable || registerOpen === false}>New order</button>
        {registerOpen === false ? <span className="empty-state"> Open the register to take orders.</span> : null}
      </p>
      {resumable.length > 0 ? (
        <>
          <h3>Open orders</h3>
          <ul className="open-orders" aria-label="Open orders">
            {resumable.map((o) => (
              <li key={o.id}>
                <span>{o.orderNumber}</span> <span className="line-total">{o.currencyCode} {formatAmount(o.totalAmount, o.currencyCode)}</span>{' '}
                <button type="button" className="secondary" aria-label={`Open ${o.orderNumber}`} onClick={() => onOpen(o.id)} disabled={busy || retryable}>Open</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
