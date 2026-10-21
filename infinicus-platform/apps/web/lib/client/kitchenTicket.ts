/**
 * The kitchen ticket template (POS-8c): what the kitchen needs to make the order, none of the money. Pure. Built from the order the server returned (nothing
 * is computed here); product lines only (a discount is not a kitchen matter); the cashier's note IS printed, because "no sugar" and "table 4" are exactly
 * what the kitchen needs (the note stays off the customer receipt). A ticket exists only for an order that is not voided and has at least one line.
 */
import type { Order } from './schemas';
import { defaultFormatDate } from './receipt';
import { escapeHtml, printReceiptDocument, type PaperMm } from './printing';
import { findDeviceBridge, printDocumentOnDevice, type DetailedOutcome } from './deviceBridge';
import { COLUMNS, type EscPosResult, wrap } from './escpos';

export interface KitchenTicketLine { quantityText: string; description: string }
export interface KitchenTicket { businessName: string | null; orderNumber: string; dateText: string; lines: KitchenTicketLine[]; note: string | null }

const quantityFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 4 });

export function buildKitchenTicket(order: Order, options: { businessName?: string | null; formatDate?: (iso: string) => string } = {}): KitchenTicket | null {
  if (order.operationalStatus === 'failed' || order.operationalStatus === 'reversed') return null;
  const lines = order.lineItems.filter((l) => l.itemType !== 'discount').map((l) => ({ quantityText: quantityFormat.format(l.quantity), description: l.description }));
  if (lines.length === 0) return null;
  const name = options.businessName?.trim();
  const note = order.note?.trim();
  return { businessName: name ? name : null, orderNumber: order.orderNumber, dateText: (options.formatDate ?? defaultFormatDate)(order.orderDate), lines, note: note ? note : null };
}

/** The ticket as an escaped, script-free HTML document for the browser print path (same locked-down shape as the receipt). */
export function ticketToHtml(ticket: KitchenTicket, paperMm: PaperMm): string {
  const e = escapeHtml;
  const pad = paperMm === 80 ? 4 : 5;
  const lines = ticket.lines.map((l) => `<div class="row"><b dir="ltr">${e(l.quantityText)} &times;</b> <span dir="auto"><bdi>${e(l.description)}</bdi></span></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Kitchen ${e(ticket.orderNumber)}</title>
<style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${paperMm}mm; padding: 2mm ${pad}mm 4mm; font: 14px/1.4 "Segoe UI", Tahoma, Arial, sans-serif; }
.c { text-align: center; }
.big { font-size: 20px; font-weight: 700; }
.row { padding: 2px 0; overflow-wrap: anywhere; }
.sep { border-top: 1px dashed #000; margin: 4px 0; }
.note { border: 1px solid #000; padding: 2px 4px; margin-top: 4px; overflow-wrap: anywhere; }
</style></head><body>
<div class="c">KITCHEN</div>
<div class="c big" dir="ltr">${e(ticket.orderNumber)}</div>
<div class="c" dir="auto">${e(ticket.dateText)}</div>
<div class="sep"></div>
${lines}
${ticket.note ? `<div class="sep"></div><div class="note" dir="auto"><b>Note:</b> <bdi>${e(ticket.note)}</bdi></div>` : ''}
</body></html>`;
}

const printable = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

/** The ticket as ESC/POS bytes (printable ASCII only, like the receipt; anything else falls back to the HTML ticket). Large order number, cut at the end. */
export function ticketToEscPos(ticket: KitchenTicket, paperMm: PaperMm): EscPosResult {
  const width = COLUMNS[paperMm];
  const texts = [ticket.orderNumber, ticket.dateText, ticket.note ?? '', ...ticket.lines.flatMap((l) => [l.quantityText, l.description])];
  if (!texts.every(printable)) return { ok: false, reason: 'The ticket has characters a plain thermal printer cannot print; the HTML ticket is used instead.' };
  const out: number[] = [0x1b, 0x40];
  const text = (line: string): void => { for (let i = 0; i < line.length; i += 1) out.push(line.charCodeAt(i)); out.push(0x0a); };
  out.push(0x1b, 0x61, 1); text('KITCHEN');
  out.push(0x1d, 0x21, 0x11); text(ticket.orderNumber); out.push(0x1d, 0x21, 0x00);          // double width and height for the order number
  text(ticket.dateText);
  out.push(0x1b, 0x61, 0); text('-'.repeat(width));
  out.push(0x1b, 0x45, 1);
  for (const l of ticket.lines) for (const line of wrap(`${l.quantityText} x ${l.description}`, width)) text(line);
  out.push(0x1b, 0x45, 0);
  if (ticket.note) { text('-'.repeat(width)); for (const line of wrap(`Note: ${ticket.note}`, width)) text(line); }
  out.push(0x1d, 0x56, 0x42, 0x03);
  return { ok: true, bytes: Uint8Array.from(out) };
}

export const KITCHEN_SENDING = 'Sending the ticket to the kitchen printer…';
export const KITCHEN_SENT = 'Kitchen ticket sent.';
export const KITCHEN_FAILED = 'The kitchen ticket could not be printed. The order is unchanged. Check the printer, then press Send to kitchen again.';

/** Prints a kitchen ticket the best available way: through the device shell when there is one, otherwise the browser's print path. */
export function printKitchenTicket(ticket: KitchenTicket, paperMm: PaperMm): Promise<DetailedOutcome> {
  return printDocumentOnDevice(ticketToEscPos(ticket, paperMm), {
    bridge: findDeviceBridge(),
    browserPrint: () => printReceiptDocument(ticketToHtml(ticket, paperMm)),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  });
}
