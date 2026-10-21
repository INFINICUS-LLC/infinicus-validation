import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useParams: () => ({ businessId: '33333333-3333-4333-8333-333333333333' }) }));

import { ApiError, ApiUnavailableError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { AMOUNT_REFUSED, CLOSE_CONFLICT, OPEN_CONFLICT, RegisterController, parseCashAmount, type RegisterState } from '../lib/client/register';
import { openRegisterSchema, registerSessionSchema, registerSummarySchema, type RegisterSession, type RegisterSummary } from '../lib/client/schemas';
import { RegisterPanelView, type RegisterPanelProps } from '../app/(client)/businesses/[businessId]/counter/register-panel';
import { OrderPanelView } from '../app/(client)/businesses/[businessId]/counter/order-panel';

const scope: Scope = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222' };
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '00000000-0000-4000-8000-000000000777';
const html = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, '');

const session = (over: Partial<RegisterSession> = {}): RegisterSession => ({ id: SESSION_ID, registerName: 'Main Register', currencyCode: 'KWD', status: 'open', openingCash: 25, closingCash: null, expectedCash: null, variance: null, openedAt: 'a', closedAt: null, ...over });
const summaryOf = (s: RegisterSession, over: Partial<RegisterSummary> = {}): RegisterSummary => ({ session: s, ordersPlanned: 1, ordersCompleted: 2, ordersVoided: 0, completedSalesTotal: 1.625, tenders: { cash: 1.125, card: 0.5, other: 0 }, expectedCash: 26.125, ...over });

interface Call { method: 'GET' | 'POST'; path: string; body: unknown; key: string | undefined }
/** In-memory stand-in for the register API; a repeated Idempotency-Key replays the first answer like the real server. */
class FakeRegisterApi implements ApiClient {
  calls: Call[] = [];
  current: RegisterSession | null = null;
  failNext: { error: Error; applied: boolean } | null = null;
  private replays = new Map<string, unknown>();

  private async handle(method: 'GET' | 'POST', path: string, init: RequestInitLite<unknown> = {}): Promise<unknown> {
    this.calls.push({ method, path, body: init.body, key: init.idempotencyKey });
    if (method === 'POST' && init.idempotencyKey && this.replays.has(init.idempotencyKey)) return JSON.parse(JSON.stringify(this.replays.get(init.idempotencyKey)));
    const fail = this.failNext;
    if (fail && !fail.applied) { this.failNext = null; throw fail.error; }
    let result: unknown;
    if (method === 'GET' && path.endsWith('/open')) result = { session: this.current };
    else if (method === 'GET' && path.endsWith('/summary')) result = summaryOf(this.current!);
    else if (method === 'POST' && path.endsWith('/close')) {
      const b = init.body as { closingCash: number };
      this.current = session({ status: 'closed', closingCash: b.closingCash, expectedCash: 25, variance: b.closingCash - 25, closedAt: 'z' });
      result = this.current; this.current = null;
    } else {
      this.current = session({ openingCash: (init.body as { openingCash: number }).openingCash });
      result = this.current;
    }
    if (method === 'POST' && init.idempotencyKey) this.replays.set(init.idempotencyKey, JSON.parse(JSON.stringify(result)));
    if (fail && fail.applied) { this.failNext = null; throw fail.error; }
    return JSON.parse(JSON.stringify(result));
  }
  get = <T,>(path: string, init?: RequestInitLite<T>) => this.handle('GET', path, init as RequestInitLite<unknown>) as Promise<T>;
  post = <T,>(path: string, init?: RequestInitLite<T>) => this.handle('POST', path, init as RequestInitLite<unknown>) as Promise<T>;
  delete = <T,>(): Promise<T> => Promise.reject(new Error('not used'));
}
function setup() {
  const api = new FakeRegisterApi();
  let n = 0;
  return { api, c: new RegisterController(api, scope, BUSINESS, () => `key-${++n}`) };
}

describe('register controller (POS-4)', () => {
  it('the schemas accept the API shape and fail loudly on drift', () => {
    expect(registerSessionSchema.safeParse(session()).success).toBe(true);
    expect(registerSessionSchema.safeParse(session({ currencyCode: null })).success).toBe(true);     // a session opened before currencies were recorded
    expect(registerSessionSchema.safeParse({ ...session(), openingCash: '25' }).success).toBe(false);
    expect(registerSessionSchema.safeParse({ ...session(), currencyCode: 'kwd' }).success).toBe(false);
    expect(openRegisterSchema.safeParse({ session: null }).success).toBe(true);
    expect(registerSummarySchema.safeParse(summaryOf(session())).success).toBe(true);
    expect(registerSummarySchema.safeParse({ ...summaryOf(session()), ordersCompleted: '2' }).success).toBe(false);
  });

  it('parses a typed cash amount strictly: digits and at most four decimals, nothing else', () => {
    expect(parseCashAmount('25')).toBe(25);
    expect(parseCashAmount(' 10.125 ')).toBe(10.125);
    for (const bad of ['', '-1', '1,5', '1e3', '0x10', 'abc', '1.23456', '.5', '5.', '1 000']) expect(parseCashAmount(bad), bad).toBeNull();
  });

  it('loads a closed register, opens it with a float, then shows the server session and summary', async () => {
    const { api, c } = setup();
    await c.load();
    expect(c.getState()).toMatchObject({ loaded: true, session: null, summary: null });
    expect(await c.open(25)).toBe(true);
    expect(c.getState().session).toMatchObject({ id: SESSION_ID, openingCash: 25, currencyCode: 'KWD' });
    expect(c.getState().summary).toMatchObject({ ordersCompleted: 2, completedSalesTotal: 1.625 });
    const post = api.calls.find((x) => x.method === 'POST')!;
    expect(post).toMatchObject({ path: `/v1/businesses/${BUSINESS}/register-sessions`, body: { openingCash: 25 }, key: 'key-1' });
  });

  it('closes the open register once and keeps the reconciliation to show', async () => {
    const { api, c } = setup();
    await c.load(); await c.open(25);
    expect(await c.close(24.5)).toBe(true);
    expect(c.getState()).toMatchObject({ session: null, summary: null });
    expect(c.getState().justClosed).toMatchObject({ closingCash: 24.5, expectedCash: 25, variance: -0.5 });
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/businesses/${BUSINESS}/register-sessions/${SESSION_ID}/close`, body: { closingCash: 24.5 } });
    expect(await c.close(1)).toBe(false);                                         // nothing open: nothing sent
  });

  it('does not open while a register is open, and ignores a second tap while an action runs', async () => {
    const { api, c } = setup();
    await c.load(); await c.open(10);
    const before = api.calls.length;
    expect(await c.open(10)).toBe(false);
    expect(api.calls).toHaveLength(before);
  });

  it('after a lost answer, retry reuses the SAME key and the register is opened once', async () => {
    const { api, c } = setup();
    await c.load();
    api.failNext = { error: new ApiUnavailableError(), applied: true };
    expect(await c.open(25)).toBe(false);
    expect(c.getState().retryable).toBe(true);
    expect(await c.open(30)).toBe(false);                                         // blocked while unresolved
    expect(await c.retry()).toBe(true);
    const posts = api.calls.filter((x) => x.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].key).toBe(posts[0].key);
    expect(c.getState().session?.openingCash).toBe(25);
  });

  it('gives plain sentences for a 409 and a 400, never the raw server text, and is not retryable', async () => {
    const a = setup(); await a.c.load();
    a.api.failNext = { error: new ApiError(409, 'X', 'business ... has no declared currency'), applied: false };
    expect(await a.c.open(1)).toBe(false);
    expect(a.c.getState()).toMatchObject({ message: OPEN_CONFLICT, retryable: false });
    const b = setup(); await b.c.load();
    b.api.failNext = { error: new ApiError(400, 'X', 'opening cash has more decimal places'), applied: false };
    expect(await b.c.open(1.2345)).toBe(false);
    expect(b.c.getState()).toMatchObject({ message: AMOUNT_REFUSED, retryable: false });
    const d = setup(); await d.c.load(); await d.c.open(5);
    d.api.failNext = { error: new ApiError(409, 'X', 'already closed'), applied: false };
    expect(await d.c.close(5)).toBe(false);
    expect(d.c.getState().message).toBe(CLOSE_CONFLICT);
  });
});

const baseState: RegisterState = { loaded: true, session: null, summary: null, justClosed: null, busy: false, message: null, retryable: false };
const noop = () => undefined;
const panel = (state: Partial<RegisterState> = {}, over: Partial<RegisterPanelProps> = {}) =>
  html(<RegisterPanelView state={{ ...baseState, ...state }} cashText="" cashValid={false} confirmingClose={false} onCashChange={noop} onOpen={noop} onAskClose={noop} onCancelClose={noop} onConfirmClose={noop} onRetry={noop} onDiscard={noop} {...over} />);

describe('register panel (POS-4, server-rendered output)', () => {
  it('a closed register explains itself and offers a labelled starting-cash field and Open register (off until the amount is valid)', () => {
    const out = panel();
    expect(out).toContain('The register is closed');
    expect(out).toContain('Starting cash');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Open register/);
    expect(panel({}, { cashText: '25', cashValid: true })).not.toMatch(/<button[^>]*disabled[^>]*>Open register/);
  });

  it('shows nothing but a loading line before the first answer', () => {
    const out = panel({ loaded: false });
    expect(out).toContain('Loading the register');
    expect(out).not.toContain('Open register');
  });

  it('an open register shows its name, currency, float and the server summary; closing asks for counted cash', () => {
    const s = session();
    const out = panel({ session: s, summary: summaryOf(s) });
    expect(out).toContain('Main Register');
    expect(out).toContain('(KWD)');
    expect(out).toContain('KWD 25.000');
    expect(out).toContain('2 completed, 1 open, 0 voided');
    expect(out).toContain('Sales KWD 1.625');
    expect(out).toContain('Taken: cash KWD 1.125, card KWD 0.500, other KWD 0.000.');
    expect(out).toContain('Cash that should be in the drawer: <strong>KWD 26.125</strong>');
    expect(out).toContain('Counted cash');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Close register/);
  });

  it('closing needs a confirmation that repeats the counted amount in the currency', () => {
    const out = panel({ session: session() }, { cashText: '24.5', cashValid: true, confirmingClose: true });
    expect(out).toContain('aria-label="Confirm closing the register"');
    expect(out).toContain('KWD 24.500');
    expect(out).toContain('Confirm: close register');
    expect(out).not.toContain('>Close register<');
  });

  it('a session opened before currencies were recorded warns that it must be closed and reopened', () => {
    expect(panel({ session: session({ currencyCode: null }) })).toContain('opened before currencies were recorded');
  });

  it('shows the reconciliation of the register just closed', () => {
    const out = panel({ justClosed: session({ status: 'closed', closingCash: 24.5, expectedCash: 25, variance: -0.5 }) });
    expect(out).toContain('Register closed. Counted KWD 24.500, expected KWD 25.000, difference KWD -0.500.');
  });

  it('while an action runs every control is disabled and the region is busy; a retryable failure offers Retry and Discard', () => {
    const busy = panel({ session: session(), busy: true }, { cashText: '1', cashValid: true });
    expect(busy).toContain('aria-busy="true"');
    expect((busy.match(/<button[^>]*>/g) ?? []).every((b) => b.includes('disabled'))).toBe(true);
    const retry = panel({ session: session(), retryable: true, message: 'The service could not be reached. Check your connection and try again.' });
    expect(retry).toContain('role="alert"');
    expect(retry).toContain('Retry');
    expect(retry).toContain('Discard and reload');
  });
});

describe('order panel with the register state (POS-4)', () => {
  const props = { state: { order: null, busy: false, message: null, retryable: false }, openOrders: [], onStart: noop, onRemove: noop, onRetry: noop, onDiscard: noop, onOpen: noop };
  it('New order is off, with the reason, when the register is closed; on when open or not yet known', () => {
    const closed = html(<OrderPanelView {...props} registerOpen={false} />);
    expect(closed).toMatch(/<button[^>]*disabled[^>]*>New order/);
    expect(closed).toContain('Open the register to take orders.');
    expect(html(<OrderPanelView {...props} registerOpen />)).not.toMatch(/<button[^>]*disabled[^>]*>New order/);
    expect(html(<OrderPanelView {...props} />)).not.toMatch(/<button[^>]*disabled[^>]*>New order/);
  });
});

describe('register summary identity', () => {
  it('a pending summary must not replace the next loaded register session summary', async () => {
    const { api, c } = setup();
    const previous = session(); api.current = previous;
    await c.load();
    const originalGet = api.get;
    let resolve!: (value: RegisterSummary) => void;
    const delayed = new Promise<RegisterSummary>(done => { resolve = done; });
    let intercept = true;
    api.get = <T,>(path: string, init?: RequestInitLite<T>): Promise<T> => {
      if (path.endsWith('/summary') && intercept) { intercept = false; return delayed as Promise<T>; }
      return originalGet(path, init);
    };
    const pending = c.refreshSummary();
    expect(await c.close(25)).toBe(true);
    const nextId = '77777777-7777-4777-8777-777777777777';
    api.current = session({ id: nextId, openingCash: 50 });
    await c.load();
    expect(c.getState().summary?.session.id).toBe(nextId);
    resolve(summaryOf(previous, { expectedCash: 999 })); await pending;
    expect(c.getState().summary?.session.id).toBe(nextId);
  });
  it('does not restore a summary after the register closes', async () => {
    const { api, c } = setup(); api.current = session(); await c.load();
    let resolve!: (value: RegisterSummary) => void;
    const delayed = new Promise<RegisterSummary>(done => { resolve = done; });
    api.get = <T,>(): Promise<T> => delayed as Promise<T>;
    const pending = c.refreshSummary();
    expect(await c.close(25)).toBe(true);
    resolve(summaryOf(session())); await pending;
    expect(c.getState().session).toBeNull();
    expect(c.getState().summary).toBeNull();
  });
  it('keeps the newest same-session summary when responses arrive out of order', async () => {
    const { api, c } = setup(); api.current = session(); await c.load();
    let first!: (value: RegisterSummary) => void;
    let second!: (value: RegisterSummary) => void;
    const a = new Promise<RegisterSummary>(done => { first = done; });
    const b = new Promise<RegisterSummary>(done => { second = done; });
    let n = 0; api.get = <T,>(): Promise<T> => (++n === 1 ? a : b) as Promise<T>;
    const old = c.refreshSummary(); const latest = c.refreshSummary();
    second(summaryOf(session(), { expectedCash: 40 })); await latest;
    first(summaryOf(session(), { expectedCash: 30 })); await old;
    expect(c.getState().summary?.expectedCash).toBe(40);
  });
  it('ignores a summary for a different session', async () => {
    const { api, c } = setup(); api.current = session(); await c.load();
    api.get = async <T,>(): Promise<T> => summaryOf(session({ id: '77777777-7777-4777-8777-777777777777' }), { expectedCash: 999 }) as T;
    await c.refreshSummary();
    expect(c.getState().summary?.session.id).toBe(SESSION_ID);
    expect(c.getState().summary?.expectedCash).toBe(26.125);
  });
  it('refuses a load whose summary belongs to a different session', async () => {
    const { api, c } = setup();
    api.get = async <T,>(path: string): Promise<T> => (path.endsWith('/open') ? { session: session() } : summaryOf(session({ id: '77777777-7777-4777-8777-777777777777' }))) as T;
    await c.load();
    expect(c.getState()).toMatchObject({ loaded: false, session: null, summary: null, busy: false });
    expect(c.getState().message).toContain('unexpected format');
  });
});
