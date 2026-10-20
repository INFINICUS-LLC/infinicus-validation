import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { buildReceipt, defaultFormatDate } from '../lib/client/receipt';
import { ReceiptView } from '../app/(client)/businesses/[businessId]/counter/receipt-view';
import { OrderPanelView, type OrderPanelProps } from '../app/(client)/businesses/[businessId]/counter/order-panel';
import type { Order } from '../lib/client/schemas';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixedDate = (iso: string) => `D(${iso})`;

const order = (over: Partial<Order> = {}): Order => ({
  id: id(1), businessId: id(2), customerId: null, orderNumber: 'ORD-0007', orderDate: '2026-10-19T17:30:00.000Z', currencyCode: 'KWD', registerSessionId: id(3),
  totalAmount: 4.25, operationalStatus: 'completed', createdAt: '2026-10-19T17:30:00.000Z', updatedAt: '2026-10-19T17:31:00.000Z',
  lineItems: [
    { id: id(10), lineNumber: 1, itemType: 'product', productId: id(20), description: 'Espresso', quantity: 2, unitPrice: 1.125, lineTotal: 2.25 },
    { id: id(11), lineNumber: 2, itemType: 'product', productId: id(21), description: 'Cake', quantity: 1, unitPrice: 2, lineTotal: 2 },
  ],
  payments: [{ id: id(30), position: 1, method: 'cash', currencyCode: 'KWD', amountTendered: 5, amountApplied: 4.25, changeGiven: 0.75, reference: null, createdAt: '2026-10-19T17:31:00.000Z' }],
  changeDue: 0.75,
  ...over,
});

describe('buildReceipt (pure: re-arranges the server order, adds up nothing)', () => {
  it('retains all four supported quantity decimal places on original receipts and reprints', () => {
    const r = buildReceipt(order({ lineItems: [{ ...order().lineItems[0], quantity: 0.0001 }] }));
    expect(r!.lines[0].quantityText).toBe('0.0001');
  });
  it('a completed KWD sale shows three-decimal amounts, the cash received and the change', () => {
    const r = buildReceipt(order(), { businessName: 'Acme Café', formatDate: fixedDate });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ businessName: 'Acme Café', orderNumber: 'ORD-0007', dateText: 'D(2026-10-19T17:30:00.000Z)', currencyCode: 'KWD', totalText: 'KWD 4.250', changeText: 'KWD 0.750' });
    expect(r!.lines).toEqual([
      { kind: 'item', description: 'Espresso', quantityText: '2', unitText: '1.125', totalText: '2.250' },
      { kind: 'item', description: 'Cake', quantityText: '1', unitText: '2.000', totalText: '2.000' },
    ]);
    expect(r!.payments).toEqual([{ label: 'Cash', appliedText: 'KWD 4.250', receivedText: 'KWD 5.000', referenceText: null }]);
  });

  it('a zero-decimal currency shows whole amounts', () => {
    const r = buildReceipt(order({ currencyCode: 'JPY', totalAmount: 300, changeDue: 0, lineItems: [{ ...order().lineItems[0], quantity: 1, unitPrice: 300, lineTotal: 300 }], payments: [{ ...order().payments[0], method: 'card', currencyCode: 'JPY', amountTendered: 300, amountApplied: 300, changeGiven: 0 }] }), { formatDate: fixedDate });
    expect(r!.totalText).toBe('JPY 300');
    expect(r!.lines[0].totalText).toBe('300');
    expect(r!.payments[0]).toEqual({ label: 'Card', appliedText: 'JPY 300', receivedText: null, referenceText: null });
    expect(r!.changeText).toBeNull();
  });

  it('only a COMPLETED order has a receipt: open, voided and any other state give null', () => {
    for (const status of ['planned', 'authorized', 'executed', 'failed', 'reversed'] as const) expect(buildReceipt(order({ operationalStatus: status }))).toBeNull();
  });

  it('the total is the server total even when the lines do not add up to it (nothing is recomputed in the browser)', () => {
    const r = buildReceipt(order({ totalAmount: 99, lineItems: [order().lineItems[0]] }), { formatDate: fixedDate });
    expect(r!.totalText).toBe('KWD 99.000');
  });

  it('a card-number-like reference is never printed; an ordinary slip number is', () => {
    const withRef = (reference: string) => buildReceipt(order({ payments: [{ ...order().payments[0], reference }] }), { formatDate: fixedDate })!.payments[0].referenceText;
    expect(withRef('4111 1111 1111 1111')).toBe('reference hidden');
    expect(withRef('4111-1111-1111-1111')).toBe('reference hidden');
    expect(withRef('SLIP-8841')).toBe('SLIP-8841');
    expect(JSON.stringify(buildReceipt(order({ payments: [{ ...order().payments[0], reference: '4111111111111111' }] }), { formatDate: fixedDate }))).not.toContain('4111');
  });

  it('payments are listed in the order they were entered; a blank business name leaves no header', () => {
    const second = { ...order().payments[0], id: id(31), position: 2, method: 'other' as const, amountApplied: 1, amountTendered: 1, changeGiven: 0 };
    const first = { ...order().payments[0], position: 1, method: 'card' as const, amountApplied: 3.25, amountTendered: 3.25, changeGiven: 0 };
    const r = buildReceipt(order({ payments: [second, first], changeDue: 0 }), { businessName: '   ', formatDate: fixedDate })!;
    expect(r.payments.map((p) => p.label)).toEqual(['Card', 'Other']);
    expect(r.businessName).toBeNull();
    expect(buildReceipt(order(), { businessName: null, formatDate: fixedDate })!.businessName).toBeNull();
  });

  it('fractional quantities keep up to three decimals; an unreadable date is shown as received', () => {
    const r = buildReceipt(order({ orderDate: 'not a date', lineItems: [{ ...order().lineItems[0], quantity: 1.5 }] }))!;
    expect(r.lines[0].quantityText).toBe('1.5');
    expect(r.dateText).toBe('not a date');
    expect(defaultFormatDate('2026-10-19T17:30:00.000Z')).toMatch(/2026/);
  });
});

describe('receipt: discount lines (POS-6b)', () => {
  const withDiscount = order({
    totalAmount: 2.25,
    lineItems: [...order().lineItems, { id: id(12), lineNumber: 3, itemType: 'discount', productId: null, description: 'Discount: Staff meal', quantity: 1, unitPrice: -2, lineTotal: -2 }],
  });

  it('a discount line is marked as a discount and shows its negative amount; product lines are unchanged', () => {
    const r = buildReceipt(withDiscount, { formatDate: fixedDate })!;
    expect(r.lines.map((l) => l.kind)).toEqual(['item', 'item', 'discount']);
    expect(r.lines[2]).toMatchObject({ description: 'Discount: Staff meal', totalText: '-2.000' });
    expect(r.totalText).toBe('KWD 2.250');   // the server's total, not a sum computed here
  });

  it('is printed as money off: description and amount, without "1 ×" or an "@ unit price"', () => {
    const r = buildReceipt(withDiscount, { formatDate: fixedDate })!;
    const out = renderToString(<ReceiptView receipt={r} onClose={() => undefined} onPrint={() => undefined} />).replace(/<!-- -->/g, '');
    expect(out).toContain('Discount: Staff meal');
    expect(out).toContain('-2.000');
    expect(out).not.toContain('1 × Discount');
    expect(out).not.toContain('@ -2.000');
    expect(out).toContain('2 × Espresso');
  });
});

describe('ReceiptView (presentational)', () => {
  const receipt = buildReceipt(order(), { businessName: 'Acme Café', formatDate: fixedDate })!;
  const html = renderToString(<ReceiptView receipt={receipt} onClose={() => undefined} onPrint={() => undefined} />).replace(/<!-- -->/g, '');

  it('shows the business, order, lines, total, payment, change and the print and close buttons', () => {
    for (const text of ['Receipt', 'Acme Café', 'ORD-0007', 'D(2026-10-19T17:30:00.000Z)', 'Espresso', 'KWD 4.250', 'Cash (received KWD 5.000)', 'Change', 'KWD 0.750', 'Print receipt', 'Close receipt']) expect(html).toContain(text);
    expect(html).toContain('aria-labelledby="receipt-heading"');
  });

  it('omits the business line when there is no name and the change line when no change is due', () => {
    const bare = buildReceipt(order({ changeDue: 0 }), { formatDate: fixedDate })!;
    const out = renderToString(<ReceiptView receipt={bare} onClose={() => undefined} onPrint={() => undefined} />).replace(/<!-- -->/g, '');
    expect(out).not.toContain('receipt-business');
    expect(out).not.toContain('>Change<');
  });
});

describe('order panel: View receipt button', () => {
  const panel = (props: Partial<OrderPanelProps>, o: Order | null = order()) =>
    renderToString(<OrderPanelView state={{ order: o, busy: false, message: null, retryable: false }} openOrders={[]} onStart={() => undefined} onRemove={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} onOpen={() => undefined} {...props} />).replace(/<!-- -->/g, '');

  it('a completed sale offers View receipt only when a handler is given and the receipt is not already open', () => {
    expect(panel({ onViewReceipt: () => undefined })).toContain('View receipt');
    expect(panel({})).not.toContain('View receipt');
    expect(panel({ onViewReceipt: () => undefined, receiptOpen: true })).not.toContain('View receipt');
  });

  it('an open or voided order never offers a receipt', () => {
    expect(panel({ onViewReceipt: () => undefined }, order({ operationalStatus: 'planned', payments: [], changeDue: 0 }))).not.toContain('View receipt');
    expect(panel({ onViewReceipt: () => undefined }, order({ operationalStatus: 'failed', payments: [], changeDue: 0 }))).not.toContain('View receipt');
  });
});
