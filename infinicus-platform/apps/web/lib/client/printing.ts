/**
 * Receipt printing for the counter (POS-8a). Pure and framework-free; the only browser pieces (creating the hidden print frame, timers) are passed in so the
 * logic is tested without a browser.
 *
 * How it prints: the receipt is turned into a small, self-contained HTML document sized for thermal paper (80 mm or 58 mm) and printed from a hidden frame, so
 * the rest of the screen never ends up on the paper. The paper size itself comes from the receipt printer's own settings (a roll of the same width); a page cannot ask for a roll
 * of unknown length (`size: 80mm auto` is not valid CSS and browsers ignore it), so the receipt is laid out to exactly the paper width and printed with no margins. A browser always shows its print dialog UNLESS the till's browser
 * is started in "kiosk printing" mode (Chrome and Edge: the `--kiosk-printing` flag) with the receipt printer as the default printer; then the same call
 * prints at once, silently. Nothing here is stored in the browser or read from the page address: auto-print and the paper width are choices held in memory on the counter screen.
 *
 * What it does NOT do (later blocks): talk to network, Bluetooth or USB printers directly, open the cash drawer, route to kitchen printers.
 */
import type { Receipt } from './receipt';

export type PaperMm = 58 | 80;
export interface PrintSettings { auto: boolean; paperMm: PaperMm }
export const DEFAULT_PRINT_SETTINGS: PrintSettings = { auto: false, paperMm: 80 };

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * The complete receipt document for thermal paper. Every piece of text is escaped, the document carries a content-security-policy that forbids scripts, images
 * and every network load (so even a mistake in escaping could not run code), and text uses `dir="auto"` so Arabic names and notes line up correctly.
 */
export function receiptToHtml(receipt: Receipt, paperMm: PaperMm = DEFAULT_PRINT_SETTINGS.paperMm): string {
  const pad = paperMm === 80 ? 4 : 5;
  const e = escapeHtml;
  const lines = receipt.lines.map((l) => (l.kind === 'discount'
    ? `<div class="row"><span dir="auto"><bdi>${e(l.description)}</bdi></span><span dir="ltr">${e(l.totalText)}</span></div>`
    : `<div class="row"><span dir="auto">${e(l.quantityText)} &times; <bdi>${e(l.description)}</bdi> @ <span dir="ltr">${e(l.unitText)}</span></span><span dir="ltr">${e(l.totalText)}</span></div>`)).join('');
  const payments = receipt.payments.map((p) =>
    `<div class="row"><span dir="auto">${e(p.label)}${p.receivedText ? ` (received <span dir="ltr">${e(p.receivedText)}</span>)` : ''}${p.referenceText ? `, ref <bdi>${e(p.referenceText)}</bdi>` : ''}</span><span dir="ltr">${e(p.appliedText)}</span></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Receipt ${e(receipt.orderNumber)}</title>
<style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${paperMm}mm; padding: 2mm ${pad}mm 4mm; font: 12px/1.35 "Segoe UI", Tahoma, Arial, sans-serif; font-variant-numeric: tabular-nums; }
.c { text-align: center; }
.biz { font-size: 15px; font-weight: 700; }
.row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
.row > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.row > span:last-child { white-space: nowrap; }
.sep { border-top: 1px dashed #000; margin: 4px 0; }
.tot { font-weight: 700; font-size: 14px; }
</style></head><body>
${receipt.businessName ? `<div class="c biz" dir="auto"><bdi>${e(receipt.businessName)}</bdi></div>` : ''}
<div class="c" dir="ltr">${e(receipt.orderNumber)}</div>
<div class="c" dir="auto">${e(receipt.dateText)}</div>
<div class="sep"></div>
${lines}
<div class="sep"></div>
<div class="row tot"><span>Total</span><span dir="ltr">${e(receipt.totalText)}</span></div>
${payments ? `<div class="sep"></div>${payments}` : ''}
${receipt.changeText ? `<div class="row"><span>Change</span><span dir="ltr">${e(receipt.changeText)}</span></div>` : ''}
</body></html>`;
}

/** The parts of the browser the print step touches. */
export interface PrintFrame {
  srcdoc: string;
  onload: (() => void) | null;
  contentWindow: { focus(): void; print(): void; onafterprint: (() => void) | null } | null;
  remove(): void;
}
export interface PrintEnv {
  createFrame(): PrintFrame;
  setTimeout(handler: () => void, ms: number): unknown;
}
export type PrintOutcome = { ok: true } | { ok: false; reason: string };

/** Longest wait for the hidden frame to load, and how long it is kept after printing when the browser never reports that printing finished (silent printing). */
export const FRAME_LOAD_TIMEOUT_MS = 10_000;
export const FRAME_LINGER_MS = 60_000;

export const PRINT_FAILED = 'The receipt could not be sent to the printer. The sale is recorded. Check the printer, then press Print receipt.';
export const PRINT_SENT = 'Receipt sent to the printer.';
export const PRINT_SENDING = 'Sending the receipt to the printer…';

/** Prints an HTML document from a hidden frame. Resolves once the browser has handed it to the printer (or the dialog closed), or with the reason it could not. */
export function printReceiptDocument(html: string, env: PrintEnv = browserPrintEnv()): Promise<PrintOutcome> {
  return new Promise((resolve) => {
    let frame: PrintFrame | null = null;
    let settled = false;
    let loaded = false;
    const done = (outcome: PrintOutcome): void => {
      if (settled) return;
      settled = true;
      try { frame?.remove(); } catch { /* the frame is already gone */ }
      resolve(outcome);
    };
    try {
      frame = env.createFrame();
      const current = frame;
      current.onload = () => {
        if (settled || loaded) return;
        loaded = true;
        try {
          const win = current.contentWindow;
          if (!win) { done({ ok: false, reason: 'The print frame has no window.' }); return; }
          win.onafterprint = () => done({ ok: true });
          win.focus();
          win.print();
          env.setTimeout(() => done({ ok: true }), FRAME_LINGER_MS);
        } catch {
          done({ ok: false, reason: 'The browser refused to print.' });
        }
      };
      current.srcdoc = html;
      env.setTimeout(() => { if (!loaded) done({ ok: false, reason: 'The print frame did not load.' }); }, FRAME_LOAD_TIMEOUT_MS);
    } catch {
      done({ ok: false, reason: 'The print frame could not be created.' });
    }
  });
}

/** The real browser parts: a hidden, off-screen frame appended to the page. */
export function browserPrintEnv(): PrintEnv {
  return {
    createFrame: () => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.title = 'Receipt for printing';
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      return frame as unknown as PrintFrame;
    },
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  };
}

/** Print a receipt now on the chosen paper width. In a browser started with kiosk printing this prints silently; otherwise the dialog opens. */
export function printReceiptNow(receipt: Receipt, paperMm: PaperMm = DEFAULT_PRINT_SETTINGS.paperMm): Promise<PrintOutcome> {
  return printReceiptDocument(receiptToHtml(receipt, paperMm));
}

/** Lets something happen once per key: the first call for a key is true, every later call for the same key is false. */
export function createOnceGuard(): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => { if (seen.has(key)) return false; seen.add(key); return true; };
}
