'use client';

import type { Receipt } from '../../../../../lib/client/receipt';

/** Presentational receipt (no data access). Printing uses the browser's own print dialog: the print stylesheet shows only this block. */
export function ReceiptView({ receipt, onClose, onPrint = () => window.print() }: { receipt: Receipt; onClose: () => void; onPrint?: () => void }) {
  return (
    <section className="receipt card" aria-labelledby="receipt-heading">
      <h2 id="receipt-heading">Receipt</h2>
      {receipt.businessName ? <p className="receipt-business"><strong>{receipt.businessName}</strong></p> : null}
      <p className="receipt-meta">{receipt.orderNumber}<br />{receipt.dateText}</p>
      <ul className="receipt-lines" aria-label="Receipt lines">
        {receipt.lines.map((l, i) => (
          <li key={i} className="receipt-row">
            {l.kind === 'discount'
              ? <span>{l.description}</span>
              : <span>{l.quantityText} &times; {l.description} <span className="receipt-unit">@ {l.unitText}</span></span>}
            <span>{l.totalText}</span>
          </li>
        ))}
      </ul>
      <p className="receipt-row receipt-total"><strong>Total</strong><strong>{receipt.totalText}</strong></p>
      {receipt.payments.length > 0 ? (
        <ul className="receipt-lines" aria-label="Receipt payments">
          {receipt.payments.map((p, i) => (
            <li key={i} className="receipt-row">
              <span>{p.label}{p.receivedText ? ` (received ${p.receivedText})` : ''}{p.referenceText ? `, ref ${p.referenceText}` : ''}</span>
              <span>{p.appliedText}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {receipt.changeText ? <p className="receipt-row"><span>Change</span><span>{receipt.changeText}</span></p> : null}
      <p className="receipt-actions">
        <button type="button" onClick={onPrint}>Print receipt</button>{' '}
        <button type="button" className="secondary" onClick={onClose}>Close receipt</button>
      </p>
    </section>
  );
}
