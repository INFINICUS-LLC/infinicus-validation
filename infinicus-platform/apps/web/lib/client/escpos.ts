/**
 * ESC/POS receipt bytes for thermal printers (POS-8d). Pure. Used only when the counter runs inside the INFINICUS device shell, which sends the bytes to the
 * printer (network, Bluetooth or USB). Plain ESC/POS printers have no Arabic shaping and each model has its own code pages, so this encoder only accepts
 * plain printable ASCII: anything else is reported, and the caller falls back to the HTML receipt (which handles every script). The cash drawer is opened by
 * the standard drawer pulse command placed after the receipt; whether to include it is the caller's decision.
 */
import type { Receipt } from './receipt';
import type { PaperMm } from './printing';

export const COLUMNS: Readonly<Record<PaperMm, number>> = { 80: 48, 58: 32 };
export type EscPosResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

const ESC = 0x1b;
const GS = 0x1d;
const INIT = [ESC, 0x40];
const ALIGN = (n: 0 | 1) => [ESC, 0x61, n];
const BOLD = (on: boolean) => [ESC, 0x45, on ? 1 : 0];
const FEED_AND_CUT = [GS, 0x56, 0x42, 0x03];
/** Drawer pin 2, on 50 ms, off 500 ms: the pulse nearly every cash drawer expects. */
export const DRAWER_PULSE: readonly number[] = [ESC, 0x70, 0x00, 0x19, 0xfa];

const printable = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

/** Splits text into lines of at most `width` characters, at spaces where possible. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let w = word;
    while (w.length > width) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, width)); w = w.slice(width); }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else { out.push(line); line = w; }
  }
  if (line || out.length === 0) out.push(line);
  return out;
}

/** `left` on the left and `right` flush right on the last line; a long `left` wraps onto lines above. */
export function row(left: string, right: string, width: number): string[] {
  const room = Math.max(1, width - right.length - 1);
  const lines = wrap(left, room);
  const last = lines.pop() ?? '';
  return [...lines, last + ' '.repeat(Math.max(1, width - last.length - right.length)) + right];
}

export function receiptToEscPos(receipt: Receipt, paperMm: PaperMm, options: { openDrawer?: boolean } = {}): EscPosResult {
  const width = COLUMNS[paperMm];
  const texts = [receipt.businessName ?? '', receipt.orderNumber, receipt.dateText, receipt.totalText, receipt.changeText ?? '',
    ...receipt.lines.flatMap((l) => [l.description, l.quantityText, l.unitText, l.totalText]),
    ...receipt.payments.flatMap((p) => [p.label, p.appliedText, p.receivedText ?? '', p.referenceText ?? ''])];
  if (!texts.every(printable)) return { ok: false, reason: 'The receipt has characters a plain thermal printer cannot print; the HTML receipt is used instead.' };
  const rule = '-'.repeat(width);
  const out: number[] = [...INIT];
  const push = (cmd: number[]): void => { out.push(...cmd); };
  const text = (line: string): void => { for (let i = 0; i < line.length; i += 1) out.push(line.charCodeAt(i)); out.push(0x0a); };
  push(ALIGN(1));
  if (receipt.businessName) { push(BOLD(true)); for (const l of wrap(receipt.businessName, width)) text(l); push(BOLD(false)); }
  text(receipt.orderNumber); text(receipt.dateText);
  push(ALIGN(0)); text(rule);
  for (const l of receipt.lines) {
    for (const line of row(l.kind === 'discount' ? l.description : `${l.quantityText} x ${l.description} @ ${l.unitText}`, l.totalText, width)) text(line);
  }
  text(rule);
  push(BOLD(true)); for (const line of row('Total', receipt.totalText, width)) text(line); push(BOLD(false));
  if (receipt.payments.length > 0) {
    text(rule);
    for (const p of receipt.payments) {
      const detail = `${p.label}${p.receivedText ? ` (received ${p.receivedText})` : ''}${p.referenceText ? `, ref ${p.referenceText}` : ''}`;
      for (const line of row(detail, p.appliedText, width)) text(line);
    }
  }
  if (receipt.changeText) for (const line of row('Change', receipt.changeText, width)) text(line);
  push(FEED_AND_CUT);
  if (options.openDrawer) push([...DRAWER_PULSE]);
  return { ok: true, bytes: Uint8Array.from(out) };
}
