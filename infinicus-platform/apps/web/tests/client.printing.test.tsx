import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createOnceGuard, escapeHtml, FRAME_LINGER_MS, FRAME_LOAD_TIMEOUT_MS, printReceiptDocument, receiptToHtml, type PrintEnv, type PrintFrame } from '../lib/client/printing';
import { PrintSettingsPanel } from '../app/(client)/businesses/[businessId]/counter/print-settings';
import { ReceiptView } from '../app/(client)/businesses/[businessId]/counter/receipt-view';
import type { Receipt } from '../lib/client/receipt';

const receipt: Receipt = {
  businessName: 'Cafe <Nour> & Sons', orderNumber: 'ORD-0042', dateText: '20 Oct 2026, 10:00', currencyCode: 'KWD',
  lines: [
    { kind: 'item', description: 'Latte "large"', quantityText: '2', unitText: 'KWD 1.250', totalText: 'KWD 2.500' },
    { kind: 'discount', description: 'Discount: Staff', quantityText: '1', unitText: '-KWD 0.500', totalText: '-KWD 0.500' },
  ],
  totalText: 'KWD 2.000',
  payments: [{ label: 'Cash', appliedText: 'KWD 2.000', receivedText: 'KWD 5.000', referenceText: null }],
  changeText: 'KWD 3.000',
};

describe('receiptToHtml', () => {
  it('escapes every piece of text, so a name cannot inject markup', () => {
    const html = receiptToHtml(receipt, 80);
    expect(html).toContain('Cafe &lt;Nour&gt; &amp; Sons');
    expect(html).toContain('Latte &quot;large&quot;');
    expect(html).not.toContain('<Nour>');
    expect(escapeHtml(`<script>alert('x')</script>`)).toBe('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
  });
  it('forbids scripts and network loads with a content-security-policy', () => {
    expect(receiptToHtml(receipt)).toContain(`default-src 'none'`);
    expect(receiptToHtml(receipt)).not.toContain('<script');
  });
  it('sizes the page to the paper width', () => {
    expect(receiptToHtml(receipt, 80)).toContain('width: 80mm');
    expect(receiptToHtml(receipt, 80)).toContain('@page { margin: 0; }');
    expect(receiptToHtml(receipt, 80)).not.toContain('@page { size');
    expect(receiptToHtml(receipt, 58)).toContain('width: 58mm');
  });
  it('shows lines, discount without quantity, total, payment and change; omits absent parts', () => {
    const html = receiptToHtml(receipt);
    for (const t of ['ORD-0042', '2 &times;', 'KWD 2.500', 'Discount: Staff', '-KWD 0.500', 'Total', 'KWD 2.000', 'Cash', 'received', 'Change', 'KWD 3.000']) expect(html, t).toContain(t);
    expect(html).not.toContain('1 &times; <bdi>Discount');
    const bare = receiptToHtml({ ...receipt, businessName: null, payments: [], changeText: null });
    expect(bare).not.toContain('class="c biz"');
    expect(bare).not.toContain('Change');
  });
  it('right-to-left names line up (dir=auto)', () => { expect(receiptToHtml({ ...receipt, businessName: 'مقهى النور' })).toContain('dir="auto"><bdi>مقهى النور</bdi>'); });
});

class FakeFrame implements PrintFrame {
  srcdoc = ''; onload: (() => void) | null = null; removed = 0; printed = 0;
  contentWindow: PrintFrame['contentWindow'] = { focus: () => undefined, print: () => { this.printed += 1; }, onafterprint: null };
  remove(): void { this.removed += 1; }
}
class FakeEnv implements PrintEnv {
  frame = new FakeFrame(); timers: { fn: () => void; ms: number }[] = [];
  createFrame = (): PrintFrame => this.frame;
  setTimeout = (fn: () => void, ms: number): unknown => { this.timers.push({ fn, ms }); return this.timers.length; };
  fire(ms: number): void { for (const t of this.timers.filter((x) => x.ms === ms)) t.fn(); }
}

describe('printReceiptDocument', () => {
  it('loads the document, prints once, and finishes when the browser reports printing done', async () => {
    const env = new FakeEnv();
    const p = printReceiptDocument('<p>x</p>', env);
    expect(env.frame.srcdoc).toBe('<p>x</p>');
    env.frame.onload?.(); env.frame.onload?.();
    expect(env.frame.printed).toBe(1);
    env.frame.contentWindow?.onafterprint?.();
    expect(await p).toEqual({ ok: true });
    expect(env.frame.removed).toBe(1);
  });
  it('silent printing (no after-print event) still finishes after the linger time', async () => {
    const env = new FakeEnv();
    const p = printReceiptDocument('x', env);
    env.frame.onload?.();
    env.fire(FRAME_LINGER_MS);
    expect(await p).toEqual({ ok: true });
  });
  it('fails when the frame never loads, cleaning up', async () => {
    const env = new FakeEnv();
    const p = printReceiptDocument('x', env);
    env.fire(FRAME_LOAD_TIMEOUT_MS);
    expect(await p).toMatchObject({ ok: false });
    expect(env.frame.removed).toBe(1);
    expect(env.frame.printed).toBe(0);
  });
  it('fails when the browser refuses to print or the frame cannot be created', async () => {
    const env = new FakeEnv();
    env.frame.contentWindow = { focus: () => undefined, print: () => { throw new Error('blocked'); }, onafterprint: null };
    const p = printReceiptDocument('x', env);
    env.frame.onload?.();
    expect(await p).toMatchObject({ ok: false });
    const broken: PrintEnv = { createFrame: () => { throw new Error('no dom'); }, setTimeout: () => 0 };
    expect(await printReceiptDocument('x', broken)).toMatchObject({ ok: false });
  });
  it('a late load after the timeout does not print', async () => {
    const env = new FakeEnv();
    const p = printReceiptDocument('x', env);
    env.fire(FRAME_LOAD_TIMEOUT_MS);
    await p;
    env.frame.onload?.();
    expect(env.frame.printed).toBe(0);
  });
});

describe('createOnceGuard', () => {
  it('is true the first time per key only', () => {
    const once = createOnceGuard();
    expect([once('a'), once('a'), once('b'), once('a')]).toEqual([true, false, true, false]);
  });
});

describe('ReceiptView printing', () => {
  const html = (autoPrint: boolean) => renderToString(<ReceiptView receipt={receipt} onClose={() => undefined} autoPrint={autoPrint} />).replace(/<!-- -->/g, '');
  it('always offers Print receipt, enabled before anything is sent, with no status message yet', () => {
    const out = html(false);
    expect(out).toContain('>Print receipt</button>');
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Print receipt/);
    expect(out).not.toContain('role="status"');
    expect(out).not.toContain('role="alert"');
  });
});

describe('PrintSettingsPanel', () => {
  const html = (auto: boolean, paperMm: 58 | 80) => renderToString(<PrintSettingsPanel settings={{ auto, paperMm }} onChange={() => undefined} />).replace(/<!-- -->/g, '');
  it('shows the automatic-printing box (off by default) and the paper choice, and says it is not remembered', () => {
    expect(html(false, 80)).not.toContain('checked');
    expect(html(true, 80)).toContain('checked');
    expect(html(false, 58)).toMatch(/<option value="58" selected/);
    expect(html(false, 80)).toContain('until this tab is closed');
  });
});
