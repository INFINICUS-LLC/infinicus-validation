/**
 * Receipt for a completed sale (POS-6a). Pure: it only re-arranges what the server already returned for the order and formats it for reading and printing.
 * Nothing is added up or recomputed here (the total, the amounts applied and the change are the server's numbers, shown with the currency's exact decimal
 * places), a receipt exists only for a COMPLETED order, and a payment reference that looks like a card number is never printed (the server refuses those,
 * this is a second guard).
 */
import { formatMoney } from './currency';
import type { Order } from './schemas';
import { looksLikeCardNumber, TENDER_LABELS } from './tender';

export interface ReceiptLine { description: string; quantityText: string; unitText: string; totalText: string }
export interface ReceiptPayment { label: string; appliedText: string; receivedText: string | null; referenceText: string | null }
export interface Receipt {
  businessName: string | null;
  orderNumber: string;
  dateText: string;
  currencyCode: string;
  lines: ReceiptLine[];
  totalText: string;
  payments: ReceiptPayment[];
  changeText: string | null;
}

export interface ReceiptOptions {
  /** The business's legal name when known; the receipt header is simply omitted otherwise. */
  businessName?: string | null;
  /** Formats the order date for display. Defaults to the reader's own time zone; tests pass a fixed one. */
  formatDate?: (iso: string) => string;
}

const quantityFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 3 });
const REFERENCE_HIDDEN = 'reference hidden';

/** Day and time in the reader's own time zone, or the raw text when it is not a date. */
export function defaultFormatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** The receipt of a completed order, or null for any other state (an open, voided or failed order has no sale to receipt). */
export function buildReceipt(order: Order, options: ReceiptOptions = {}): Receipt | null {
  if (order.operationalStatus !== 'completed') return null;
  const ccy = order.currencyCode;
  const plain = (n: number): string => formatMoney(n, ccy);
  const money = (n: number): string => `${ccy} ${plain(n)}`;
  const name = options.businessName?.trim();
  return {
    businessName: name ? name : null,
    orderNumber: order.orderNumber,
    dateText: (options.formatDate ?? defaultFormatDate)(order.orderDate),
    currencyCode: ccy,
    lines: order.lineItems.map((l) => ({
      description: l.description,
      quantityText: quantityFormat.format(l.quantity),
      unitText: plain(l.unitPrice),
      totalText: plain(l.lineTotal),
    })),
    totalText: money(order.totalAmount),
    payments: [...order.payments].sort((x, y) => x.position - y.position).map((p) => ({
      label: TENDER_LABELS[p.method],
      appliedText: money(p.amountApplied),
      receivedText: p.method === 'cash' && p.changeGiven > 0 ? money(p.amountTendered) : null,
      referenceText: p.reference ? (looksLikeCardNumber(p.reference) ? REFERENCE_HIDDEN : p.reference) : null,
    })),
    changeText: order.changeDue > 0 ? money(order.changeDue) : null,
  };
}
