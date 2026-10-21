import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ApiError, ApiUnavailableError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { BRIDGE_TIMEOUT_MS, DEVICE_PRINT_FAILED, printDocumentOnDevice, type DeviceBridge, type DocumentDeps } from '../lib/client/deviceBridge';
import { buildKitchenTicket, ticketToEscPos, ticketToHtml, type KitchenTicket } from '../lib/client/kitchenTicket';
import { fetchPrintRoutes, NO_ROUTES, paperFor, printJobBody, printRoutesSchema, recordPrintJob } from '../lib/client/printJobs';
import { printReceiptDocument, type PrintEnv, type PrintFrame } from '../lib/client/printing';
import { OrderPanelView } from '../app/(client)/businesses/[businessId]/counter/order-panel';
import { PrintSettingsPanel } from '../app/(client)/businesses/[businessId]/counter/print-settings';
import type { Order } from '../lib/client/schemas';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { tenantId: uuid(1), workspaceId: uuid(2) };
const order = (over: Partial<Order> = {}): Order => ({
  id: uuid(10), businessId: uuid(3), customerId: null, orderNumber: 'ORD-0042', note: 'Table 4, no sugar', orderDate: '2026-10-20T10:00:00.000Z', currencyCode: 'USD', registerSessionId: uuid(4),
  totalAmount: 7.5, operationalStatus: 'planned', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z',
  lineItems: [
    { id: uuid(11), lineNumber: 1, itemType: 'product', productId: null, description: 'Latte <large>', quantity: 2, unitPrice: 5, lineTotal: 10 },
    { id: uuid(12), lineNumber: 2, itemType: 'discount', productId: null, description: 'Discount: Staff', quantity: 1, unitPrice: -2.5, lineTotal: -2.5 },
  ],
  payments: [], changeDue: 0, ...over,
});
const fixedDate = () => '20 Oct 2026, 10:00';

describe('kitchen ticket', () => {
  it('lists product lines only (no discount, no money) and carries the saved note', () => {
    const t = buildKitchenTicket(order(), { formatDate: fixedDate });
    expect(t).toEqual({ businessName: null, orderNumber: 'ORD-0042', dateText: '20 Oct 2026, 10:00', lines: [{ quantityText: '2', description: 'Latte <large>' }], note: 'Table 4, no sugar' });
    expect(JSON.stringify(t)).not.toMatch(/Discount|7\.5|unitPrice|total/i);
  });
  it('exists only for an order that is not voided and has a product line', () => {
    expect(buildKitchenTicket(order({ operationalStatus: 'failed' }))).toBeNull();
    expect(buildKitchenTicket(order({ operationalStatus: 'reversed' }))).toBeNull();
    expect(buildKitchenTicket(order({ lineItems: [] }))).toBeNull();
    expect(buildKitchenTicket(order({ lineItems: [order().lineItems[1]] }))).toBeNull();
    expect(buildKitchenTicket(order({ operationalStatus: 'completed' }))).not.toBeNull();
    expect(buildKitchenTicket(order({ note: '   ' }), { formatDate: fixedDate })?.note).toBeNull();
  });
  const ticket = buildKitchenTicket(order(), { formatDate: fixedDate }) as KitchenTicket;
  it('the HTML ticket is escaped, script-free and sized to the paper, with the note', () => {
    const html = ticketToHtml(ticket, 58);
    expect(html).toContain('Latte &lt;large&gt;');
    expect(html).not.toContain('<large>');
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain('width: 58mm');
    expect(html).toContain('Table 4, no sugar');
    expect(ticketToHtml({ ...ticket, note: null }, 80)).not.toContain('Note:');
  });
  it('the ESC/POS ticket holds to the paper columns, shows quantity and note, cuts, and falls back for non-ASCII', () => {
    const r = ticketToEscPos({ ...ticket, lines: [{ quantityText: '2', description: 'A very long item name that has to wrap onto another line' }] }, 58);
    if (!r.ok) throw new Error('expected ok');
    expect(Array.from(r.bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x03]);
    const text = Array.from(r.bytes).map((c) => String.fromCharCode(c)).join('');
    expect(text).toContain('2 x A very long item name');
    expect(text).toContain('Note: Table 4, no sugar');
    expect(ticketToEscPos({ ...ticket, lines: [{ quantityText: '1', description: 'قهوة' }] }, 80)).toMatchObject({ ok: false });
  });
});

describe('printDocumentOnDevice (route and failure code for the log)', () => {
  const okEscpos = ticketToEscPos(buildKitchenTicket(order(), { formatDate: fixedDate }) as KitchenTicket, 80);
  const deps = (bridge: DeviceBridge | null, browser: Promise<{ ok: true } | { ok: false; reason: string; code?: 'timeout' }> = Promise.resolve({ ok: true })) => {
    const timers: { fn: () => void; ms: number }[] = [];
    const d: DocumentDeps = { bridge, browserPrint: () => browser, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } };
    return { d, timers };
  };
  it('browser route when there is no shell or the ticket cannot be encoded; the browser failure code is kept', async () => {
    expect(await printDocumentOnDevice(okEscpos, deps(null).d)).toEqual({ ok: true, via: 'browser' });
    expect(await printDocumentOnDevice({ ok: false, reason: 'x' }, deps({ printEscPos: async () => ({ ok: true }) }).d)).toEqual({ ok: true, via: 'browser' });
    expect(await printDocumentOnDevice(okEscpos, deps(null, Promise.resolve({ ok: false, reason: 'no load', code: 'timeout' })).d)).toEqual({ ok: false, via: 'browser', reason: 'no load', code: 'timeout' });
    expect(await printDocumentOnDevice(okEscpos, deps(null, Promise.resolve({ ok: false, reason: 'x' })).d)).toMatchObject({ ok: false, code: 'other' });
  });
  it('device route: success, a refusal or throw is printer_error, silence is timeout; never retried through the browser', async () => {
    let browserCalls = 0;
    const mk = (b: DeviceBridge) => { const x = deps(b); x.d.browserPrint = async () => { browserCalls += 1; return { ok: true }; }; return x; };
    expect(await printDocumentOnDevice(okEscpos, mk({ printEscPos: async () => ({ ok: true }) }).d)).toEqual({ ok: true, via: 'device' });
    expect(await printDocumentOnDevice(okEscpos, mk({ printEscPos: async () => ({ ok: false }) }).d)).toEqual({ ok: false, via: 'device', reason: DEVICE_PRINT_FAILED, code: 'printer_error' });
    expect(await printDocumentOnDevice(okEscpos, mk({ printEscPos: async () => { throw new Error('x'); } }).d)).toMatchObject({ code: 'printer_error' });
    const silent = mk({ printEscPos: () => new Promise(() => undefined) });
    const p = printDocumentOnDevice(okEscpos, silent.d);
    silent.timers.find((t) => t.ms === BRIDGE_TIMEOUT_MS)?.fn();
    expect(await p).toMatchObject({ ok: false, via: 'device', code: 'timeout' });
    expect(browserCalls).toBe(0);
  });
  it('the browser print step reports fixed codes: a frame that never loads is a timeout', async () => {
    const frame: PrintFrame = { srcdoc: '', onload: null, contentWindow: null, remove: () => undefined };
    const timers: { fn: () => void; ms: number }[] = [];
    const env: PrintEnv = { createFrame: () => frame, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } };
    const p = printReceiptDocument('x', env);
    timers[0].fn();
    expect(await p).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('print-job log from the counter (best effort)', () => {
  class FakeApi implements ApiClient {
    posts: { path: string; body: unknown; key?: string }[] = []; gets: string[] = [];
    constructor(private readonly answer: (path: string) => unknown | Error) {}
    async get<T>(path: string): Promise<T> { this.gets.push(path); const a = this.answer(path); if (a instanceof Error) throw a; return a as T; }
    async post<T>(path: string, init: RequestInitLite<T> = {}): Promise<T> { this.posts.push({ path, body: init.body, key: init.idempotencyKey }); const a = this.answer(path); if (a instanceof Error) throw a; return a as T; }
    async delete<T>(): Promise<T> { throw new Error('not used'); }
  }
  it('builds the API body: a fixed failure code only on a failure, printer only when routed', () => {
    expect(printJobBody({ orderId: uuid(10), kind: 'receipt', trigger: 'automatic', outcome: { ok: true, via: 'device' } })).toEqual({ kind: 'receipt', trigger: 'automatic', outcome: 'succeeded', printedVia: 'device' });
    expect(printJobBody({ orderId: uuid(10), kind: 'kitchen', trigger: 'manual', outcome: { ok: false, via: 'browser', code: 'timeout' }, printerId: uuid(9) }))
      .toEqual({ kind: 'kitchen', trigger: 'manual', outcome: 'failed', printedVia: 'browser', failureCode: 'timeout', printerId: uuid(9) });
    expect(printJobBody({ orderId: uuid(10), kind: 'receipt', trigger: 'reprint', outcome: { ok: false } })).toMatchObject({ outcome: 'failed', printedVia: 'browser', failureCode: 'other' });
    expect(printJobBody({ orderId: uuid(10), kind: 'receipt', trigger: 'reprint', outcome: { ok: false, code: 'paper jam' } })).toMatchObject({ failureCode: 'other' });
  });
  it('records with an idempotency key and the order path; any failure just returns false and never throws', async () => {
    const api = new FakeApi(() => ({ id: uuid(50) }));
    expect(await recordPrintJob(api, scope, uuid(3), { orderId: uuid(10), kind: 'receipt', trigger: 'automatic', outcome: { ok: true, via: 'browser' } }, () => 'k1')).toBe(true);
    expect(api.posts[0]).toMatchObject({ path: `/v1/businesses/${uuid(3)}/orders/${uuid(10)}/print-jobs`, key: 'k1' });
    for (const err of [new ApiError(404, 'NOT_FOUND', 'x'), new ApiError(500, 'X', 'x'), new ApiUnavailableError()]) {
      expect(await recordPrintJob(new FakeApi(() => err), scope, uuid(3), { orderId: uuid(10), kind: 'kitchen', trigger: 'manual', outcome: { ok: true } })).toBe(false);
    }
  });
  it('routes: the answer when valid; no routes on any failure or a malformed answer', async () => {
    const printer = { id: uuid(9), name: 'Front', kind: 'receipt', paperMm: 58 };
    expect(await fetchPrintRoutes(new FakeApi(() => ({ receipt: printer, kitchen: null })), scope, uuid(3))).toMatchObject({ receipt: { id: uuid(9), paperMm: 58 }, kitchen: null });
    expect(await fetchPrintRoutes(new FakeApi(() => new ApiError(404, 'NOT_FOUND', 'x')), scope, uuid(3))).toEqual(NO_ROUTES);
    expect(printRoutesSchema.safeParse({ receipt: { id: 'nope', name: 'x', paperMm: 70 }, kitchen: null }).success).toBe(false);   // the API client applies this schema to every answer
    expect(printRoutesSchema.safeParse({ receipt: null, kitchen: null }).success).toBe(true);
  });
  it('the routed printer decides the paper width, else the cashier does', () => {
    expect(paperFor({ paperMm: 58 }, 80)).toBe(58);
    expect(paperFor(null, 80)).toBe(80);
  });
});

describe('counter panels for POS-8c', () => {
  const html = (props: Record<string, unknown>, o: Order = order()) =>
    renderToString(<OrderPanelView state={{ order: o, busy: false, message: null, retryable: false }} openOrders={[]} onStart={() => undefined} onRemove={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} onOpen={() => undefined} {...props} />).replace(/<!-- -->/g, '');
  it('Send to kitchen shows on an open order with a product line, is absent without a handler, disabled with no product lines or while sending', () => {
    expect(html({ onKitchen: () => undefined })).toMatch(/<button type="button" class="secondary">Send to kitchen<\/button>/);
    expect(html({})).not.toContain('Send to kitchen');
    expect(html({ onKitchen: () => undefined }, order({ lineItems: [order().lineItems[1]] }))).toMatch(/<button[^>]*disabled=""[^>]*>Send to kitchen/);
    expect(html({ onKitchen: () => undefined, kitchenStatus: { kind: 'sending', text: 'Sending…' } })).toMatch(/<button[^>]*disabled=""[^>]*>Send to kitchen/);
    expect(html({ onKitchen: () => undefined }, order({ operationalStatus: 'completed' }))).not.toContain('Send to kitchen');
  });
  it('shows the kitchen result: a status when sent, an alert when it failed', () => {
    expect(html({ onKitchen: () => undefined, kitchenStatus: { kind: 'sent', text: 'Kitchen ticket sent.' } })).toContain('role="status">Kitchen ticket sent.');
    expect(html({ onKitchen: () => undefined, kitchenStatus: { kind: 'failed', text: 'The kitchen ticket could not be printed.' } })).toContain('role="alert">The kitchen ticket could not be printed.');
  });
  it('the print settings show the routed receipt printer\'s paper instead of the choice', () => {
    const p = (routed?: 58 | 80) => renderToString(<PrintSettingsPanel settings={{ auto: false, paperMm: 80 }} onChange={() => undefined} routedPaperMm={routed} />).replace(/<!-- -->/g, '');
    expect(p()).toContain('<select');
    expect(p(58)).not.toContain('<select');
    expect(p(58)).toContain('Paper: 58 mm (from the default receipt printer)');
  });
});
