'use client';

import { useEffect, useRef, useState } from 'react';
import type { Receipt } from '../../../../../lib/client/receipt';
import { createOnceGuard, DEFAULT_PRINT_SETTINGS, PRINT_FAILED, PRINT_SENDING, PRINT_SENT, type PaperMm, type PrintOutcome } from '../../../../../lib/client/printing';
import { printReceiptDetailed, type DetailedOutcome } from '../../../../../lib/client/deviceBridge';

/** One automatic print per receipt for the life of the page, however often the receipt is re-shown or re-rendered. */
const firstAutoPrint = createOnceGuard();

/**
 * Presentational receipt (no data access). Printing sends a thermal-paper version of the receipt from a hidden frame (see lib/client/printing). When
 * `autoPrint` is set (the cashier switched on automatic printing) it prints once, as soon as the receipt is shown, i.e. after the server confirmed the sale.
 * A failed print never affects the sale: the receipt stays on screen with a message and Print receipt tries again.
 */
export function ReceiptView({ receipt, onClose, onPrint, autoPrint = false, paperMm = DEFAULT_PRINT_SETTINGS.paperMm, onPrinted }: {
  receipt: Receipt; onClose: () => void; onPrint?: (receipt: Receipt) => Promise<PrintOutcome>; autoPrint?: boolean; paperMm?: PaperMm;
  /** Told how every print attempt ended (for the print-job log); the log is best effort and never affects printing. */
  onPrinted?: (info: { automatic: boolean; outcome: DetailedOutcome | PrintOutcome }) => void;
}) {
  const [status, setStatus] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'failed'; text: string }>({ kind: 'idle', text: '' });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const print = (automatic = false): void => {
    setStatus({ kind: 'sending', text: PRINT_SENDING });
    const attempt: Promise<DetailedOutcome | PrintOutcome> = onPrint ? onPrint(receipt) : printReceiptDetailed(receipt, paperMm, { automatic });
    attempt.then(
      (outcome) => { onPrinted?.({ automatic, outcome }); if (mounted.current) setStatus(outcome.ok ? { kind: 'sent', text: PRINT_SENT } : { kind: 'failed', text: PRINT_FAILED }); },
      () => { onPrinted?.({ automatic, outcome: { ok: false, reason: PRINT_FAILED, code: 'other' } }); if (mounted.current) setStatus({ kind: 'failed', text: PRINT_FAILED }); },
    );
  };
  const printRef = useRef(print);
  printRef.current = print;
  useEffect(() => { if (autoPrint && firstAutoPrint(receipt.orderNumber)) printRef.current(true); }, [autoPrint, receipt.orderNumber]);
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
      {status.kind !== 'idle' ? <p className={status.kind === 'failed' ? 'notice danger' : 'notice'} role={status.kind === 'failed' ? 'alert' : 'status'}>{status.text}</p> : null}
      <p className="receipt-actions">
        <button type="button" onClick={() => print()} disabled={status.kind === 'sending'}>Print receipt</button>{' '}
        <button type="button" className="secondary" onClick={onClose}>Close receipt</button>
      </p>
    </section>
  );
}
