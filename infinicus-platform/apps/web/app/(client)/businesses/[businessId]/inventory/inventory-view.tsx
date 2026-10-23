'use client';

import type { Resource } from '../../../../../lib/client/resource';
import { FLAG_TEXT, flagCounts, formatMovement, formatQuantity, INVENTORY_LIMIT, mayBeTruncated, stockFlag, type InventoryResponse, type InventoryRow } from '../../../../../lib/client/inventory';

function Qty({ value }: { value: number }) {
  const text = formatQuantity(value);
  return text === null ? <span className="notice danger" role="alert">unavailable</span> : <span>{text}</span>;
}

function Row({ row }: { row: InventoryRow }) {
  const flag = stockFlag(row);
  return <tr>
    <th scope="row">{row.itemName}<br /><small>{row.sku}</small></th>
    <td>{row.warehouseName}</td>
    <td><Qty value={row.quantityOnHand} /></td>
    <td><Qty value={row.quantityReserved} /></td>
    <td><Qty value={row.quantityAvailable} /></td>
    <td>{row.reorderPoint > 0 ? <Qty value={row.reorderPoint} /> : 'not set'}</td>
    <td>{formatMovement(row.lastMovementAt)}</td>
    <td>{flag === 'none' ? <span className="visually-hidden">no flag</span> : <strong>{FLAG_TEXT[flag]}</strong>}</td>
  </tr>;
}

/** Read-only: every quantity is the Business Operations balance for that row; nothing is added up, edited or ordered from here. */
export function InventoryView({ resource }: { resource: Resource<InventoryResponse> }) {
  return <div className="inventory-view" aria-live="polite" aria-busy={resource.kind === 'loading'}>
    {resource.kind === 'loading' ? <p role="status">Loading stock levels…</p> : null}
    {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
    {resource.kind === 'ok' && resource.data.items.length === 0
      ? <p className="empty-state">No stock is recorded for this business yet.</p> : null}
    {resource.kind === 'ok' && resource.data.items.length > 0 ? (() => {
      const rows = resource.data.items;
      const counts = flagCounts(rows);
      return <section className="card" aria-labelledby="stock-heading">
        <h2 id="stock-heading">Stock by item and warehouse</h2>
        <dl className="kpis">
          <div><dt>Rows shown</dt><dd>{counts.rows}</dd></div>
          <div><dt>None available</dt><dd>{counts.noneAvailable}</dd></div>
          <div><dt>At or below reorder point</dt><dd>{counts.atOrBelowReorderPoint}</dd></div>
        </dl>
        {mayBeTruncated(rows)
          ? <p className="notice" role="status">Showing the first {INVENTORY_LIMIT} rows by item name. There may be more that are not listed here.</p> : null}
        <p><small>Available is on hand minus reserved. &ldquo;At or below reorder point&rdquo; is shown when a reorder point is set and available is at or below it. This screen only shows stock; it does not order or change it.</small></p>
        <table className="stock">
          <caption>Quantities are in each item&apos;s own unit and are not added together.</caption>
          <thead><tr>
            <th scope="col">Item</th><th scope="col">Warehouse</th><th scope="col">On hand</th><th scope="col">Reserved</th>
            <th scope="col">Available</th><th scope="col">Reorder point</th><th scope="col">Last movement</th><th scope="col">Flag</th>
          </tr></thead>
          <tbody>{rows.map((r) => <Row key={r.id} row={r} />)}</tbody>
        </table>
      </section>;
    })() : null}
  </div>;
}
