'use client';

import type { Resource } from '../../../../../lib/client/resource';
import {
  formatOrderTotal, isPoStatus, mayBeTruncated, PO_STATUSES, PURCHASING_LIMIT, statusText, utcDate,
  type PoStatus, type PurchaseOrdersResponse, type SuppliersResponse,
} from '../../../../../lib/client/purchasing';

export interface PurchasingViewProps {
  orders: Resource<PurchaseOrdersResponse>;
  suppliers: Resource<SuppliersResponse>;
  status: PoStatus | null;
  onStatus: (status: PoStatus | null) => void;
}

function Total({ amount, code }: { amount: number; code: string }) {
  const text = formatOrderTotal(amount, code);
  return text === null ? <span className="notice danger" role="alert">amount unavailable</span> : <span>{code} {text}</span>;
}

const Truncated = () => <p className="notice" role="status">Showing the first {PURCHASING_LIMIT} rows. There may be more that are not listed here.</p>;

function Orders({ resource, status, onStatus }: Pick<PurchasingViewProps, 'status' | 'onStatus'> & { resource: PurchasingViewProps['orders'] }) {
  return <section className="card" aria-labelledby="po-heading">
    <h2 id="po-heading">Purchase orders</h2>
    <p><label>Show <select value={status ?? ''} onChange={(e) => onStatus(isPoStatus(e.target.value) ? e.target.value : null)}>
      <option value="">All statuses</option>
      {PO_STATUSES.map((s) => <option key={s} value={s}>{statusText(s)}</option>)}
    </select></label></p>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading purchase orders…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.purchaseOrders.length === 0
        ? <p className="empty-state">{status ? `No ${statusText(status).toLowerCase()} purchase orders.` : 'No purchase orders are recorded for this business yet.'}</p> : null}
      {resource.kind === 'ok' && resource.data.purchaseOrders.length > 0 ? <>
        {mayBeTruncated(resource.data.purchaseOrders.length) ? <Truncated /> : null}
        <table className="purchasing">
          <caption>Newest first. Totals are in each order&apos;s own currency and are not added together.</caption>
          <thead><tr><th scope="col">Order</th><th scope="col">Supplier</th><th scope="col">Ordered</th><th scope="col">Expected</th><th scope="col">Total</th><th scope="col">Status</th><th scope="col">Approved</th></tr></thead>
          <tbody>{resource.data.purchaseOrders.map((po) => <tr key={po.id}>
            <th scope="row">{po.poNumber}</th>
            <td>{po.supplierName}</td>
            <td>{utcDate(po.orderDate)}</td>
            <td>{po.expectedDate === null ? 'not set' : utcDate(po.expectedDate)}</td>
            <td><Total amount={po.totalAmount} code={po.currencyCode} /></td>
            <td>{statusText(po.poStatus)}</td>
            <td>{po.approvedAt === null ? 'not approved' : utcDate(po.approvedAt)}</td>
          </tr>)}</tbody>
        </table>
      </> : null}
    </div>
  </section>;
}

function Suppliers({ resource }: { resource: PurchasingViewProps['suppliers'] }) {
  return <section className="card" aria-labelledby="sup-heading">
    <h2 id="sup-heading">Suppliers</h2>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading suppliers…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.suppliers.length === 0 ? <p className="empty-state">No suppliers are recorded for this business yet.</p> : null}
      {resource.kind === 'ok' && resource.data.suppliers.length > 0 ? <>
        {mayBeTruncated(resource.data.suppliers.length) ? <Truncated /> : null}
        <table className="purchasing">
          <thead><tr><th scope="col">Supplier</th><th scope="col">Code</th><th scope="col">Status</th><th scope="col">Risk</th><th scope="col">Latest performance score</th></tr></thead>
          <tbody>{resource.data.suppliers.map((s) => <tr key={s.id}>
            <th scope="row">{s.name}</th>
            <td>{s.supplierCode}</td>
            <td>{s.status}</td>
            <td>{s.riskStatus}</td>
            <td>{s.latestPerformanceScore === null ? 'not scored yet' : <>{s.latestPerformanceScore}{s.latestPerformanceAt ? ` (${utcDate(s.latestPerformanceAt)})` : ''}</>}</td>
          </tr>)}</tbody>
        </table>
      </> : null}
    </div>
  </section>;
}

/** Read-only: every figure is Business Operations' for that row. The only control chooses which purchase-order status to list. */
export function PurchasingView({ orders, suppliers, status, onStatus }: PurchasingViewProps) {
  return <div className="purchasing-view">
    <Orders resource={orders} status={status} onStatus={onStatus} />
    <Suppliers resource={suppliers} />
    <p><small>This screen only shows purchasing. It does not order, approve, receive or pay.</small></p>
  </div>;
}
