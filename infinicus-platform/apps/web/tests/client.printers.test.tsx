import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ApiError, ApiUnavailableError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import {
  buildPrinter, NEW_PRINTER, PRINTER_NAME_MAX, PRINT_LOG_UNAVAILABLE, PRINTERS_FORBIDDEN, PRINTERS_NAME_TAKEN, PRINTERS_RETIRED, PRINTERS_UNAVAILABLE,
  PrintersController, type Printer, type PrintJob, type PrintersState,
} from '../lib/client/printers';
import { PrintersView, type PrintersViewProps } from '../app/(client)/businesses/[businessId]/printers/printers-view';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { tenantId: uuid(1), workspaceId: uuid(2) };
const printer = (n: number, over: Partial<Printer> = {}): Printer => ({ id: uuid(n), name: `P${n}`, kind: 'receipt', connection: 'network', paperMm: 80, isDefault: false, status: 'active', retiredAt: null, createdAt: '2026-10-20T10:00:00.000Z', ...over });
const job = (n: number, over: Partial<PrintJob> = {}): PrintJob => ({ id: uuid(100 + n), orderId: uuid(50), printerId: null, kind: 'receipt', trigger: 'automatic', outcome: 'succeeded', failureCode: null, printedVia: 'browser', createdAt: '2026-10-20T10:05:00.000Z', ...over });

describe('buildPrinter', () => {
  it('trims the name and sends the default flag only when set', () => {
    expect(buildPrinter({ ...NEW_PRINTER, name: '  Front counter ' })).toEqual({ ok: true, body: { name: 'Front counter', kind: 'receipt', connection: 'network', paperMm: 80 } });
    expect(buildPrinter({ ...NEW_PRINTER, name: 'K', kind: 'kitchen', paperMm: 58, isDefault: true })).toEqual({ ok: true, body: { name: 'K', kind: 'kitchen', connection: 'network', paperMm: 58, isDefault: true } });
  });
  it('refuses an empty or too long name', () => {
    expect(buildPrinter({ ...NEW_PRINTER, name: '   ' })).toMatchObject({ ok: false });
    expect(buildPrinter({ ...NEW_PRINTER, name: 'x'.repeat(PRINTER_NAME_MAX + 1) })).toMatchObject({ ok: false });
    expect(buildPrinter({ ...NEW_PRINTER, name: 'x'.repeat(PRINTER_NAME_MAX) })).toMatchObject({ ok: true });
  });
});

/** Answers like the server: lists from `data`, writes recorded (and optionally failing). */
class FakeApi implements ApiClient {
  data = { printers: [printer(1, { isDefault: true })], jobs: [job(1)] };
  gets: string[] = []; posts: { path: string; body: unknown; key?: string }[] = [];
  /** When set, the next printers read waits for this promise before answering (with the data as it was when asked). */
  hold: Promise<void> | null = null;
  failJobs: Error | null = null; failPrinters: Error | null = null; failWrite: Error | null = null;
  async get<T>(path: string): Promise<T> {
    this.gets.push(path);
    if (path.includes('/print-jobs')) { if (this.failJobs) throw this.failJobs; return { printJobs: this.data.jobs } as T; }
    if (this.failPrinters) throw this.failPrinters;
    const snapshot = { printers: this.data.printers };
    const wait = this.hold; this.hold = null;
    if (wait) await wait;
    return snapshot as T;
  }
  async post<T>(path: string, init: RequestInitLite<T> = {}): Promise<T> { this.posts.push({ path, body: init.body, key: init.idempotencyKey }); if (this.failWrite) throw this.failWrite; return {} as T; }
  async delete<T>(): Promise<T> { throw new Error('not used'); }
}
const controller = (api: FakeApi) => new PrintersController(api, scope, uuid(3), (() => { let n = 0; return () => `key-${(n += 1)}`; })());

describe('PrintersController', () => {
  it('loads printers and the recent print log', async () => {
    const api = new FakeApi(); const c = controller(api);
    await c.refresh();
    expect(c.getState()).toMatchObject({ loaded: true, busy: false, message: null });
    expect(c.getState().printers).toHaveLength(1);
    expect(c.getState().jobs).toHaveLength(1);
    expect(api.gets).toEqual([`/v1/businesses/${uuid(3)}/printers`, `/v1/businesses/${uuid(3)}/print-jobs?limit=50`]);
  });
  it('shows the printers even when the log cannot be loaded, says so, and explains a server without printers', async () => {
    const a = new FakeApi(); a.failJobs = new ApiError(404, 'NOT_FOUND', 'x'); const c = controller(a); await c.refresh();
    expect(c.getState().printers).toHaveLength(1);
    expect(c.getState().message).toBe(PRINT_LOG_UNAVAILABLE);
    const b = new FakeApi(); b.failPrinters = new ApiError(404, 'NOT_FOUND', 'x'); const d = controller(b); await d.refresh();
    expect(d.getState()).toMatchObject({ printers: [], jobs: [], message: PRINTERS_UNAVAILABLE, busy: false });
    const e = new FakeApi(); e.failPrinters = new ApiUnavailableError(); const f = controller(e); await f.refresh();
    expect(f.getState().message).toContain('could not be reached');
  });
  it('adds a printer with a trimmed body and an idempotency key, then reloads and says so; a bad form sends nothing', async () => {
    const api = new FakeApi(); const c = controller(api); await c.refresh();
    expect(await c.create({ ...NEW_PRINTER, name: '  Bar ' })).toBe(true);
    expect(api.posts[0]).toEqual({ path: `/v1/businesses/${uuid(3)}/printers`, body: { name: 'Bar', kind: 'receipt', connection: 'network', paperMm: 80 }, key: 'key-1' });
    expect(c.getState().notice).toBe('Printer added.');
    expect(api.gets.filter((g) => g.endsWith('/printers'))).toHaveLength(2);       // reloaded after the change
    expect(await c.create({ ...NEW_PRINTER, name: ' ' })).toBe(false);
    expect(api.posts).toHaveLength(1);
    expect(c.getState().message).not.toBeNull();
  });
  it('make default and retire post to the printer and reload', async () => {
    const api = new FakeApi(); const c = controller(api); await c.refresh();
    expect(await c.makeDefault(uuid(7))).toBe(true);
    expect(await c.retire(uuid(7))).toBe(true);
    expect(api.posts.map((p) => p.path)).toEqual([`/v1/businesses/${uuid(3)}/printers/${uuid(7)}/default`, `/v1/businesses/${uuid(3)}/printers/${uuid(7)}/retire`]);
    expect(api.posts.map((p) => p.key)).toEqual(['key-1', 'key-2']);
  });
  it('says plainly why a change was refused, in our words not the server\'s; nothing is reloaded or claimed done', async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(403, 'FORBIDDEN', 'raw server words'), PRINTERS_FORBIDDEN],
      [new ApiError(409, 'CONFLICT', 'Printer conflict: a printer named "A" already exists'), PRINTERS_NAME_TAKEN],
      [new ApiError(409, 'CONFLICT', 'Printer conflict: printer x is retired and cannot be the default'), PRINTERS_RETIRED],
    ];
    for (const [err, text] of cases) {
      const api = new FakeApi(); const c = controller(api); await c.refresh(); api.failWrite = err;
      expect(await c.makeDefault(uuid(7))).toBe(false);
      expect(c.getState()).toMatchObject({ message: text, notice: null, busy: false });
      expect(c.getState().message).not.toContain('raw server');
    }
  });
  it('a lost connection says nothing was confirmed and to check the list first', async () => {
    const api = new FakeApi(); const c = controller(api); await c.refresh(); api.failWrite = new ApiUnavailableError();
    expect(await c.create({ ...NEW_PRINTER, name: 'X' })).toBe(false);
    expect(c.getState().message).toContain('Nothing was confirmed');
  });
  it('ignores a second change while one is in flight', async () => {
    const api = new FakeApi(); const c = controller(api); await c.refresh();
    const first = c.retire(uuid(7)); const second = c.retire(uuid(8));
    expect(await second).toBe(false);
    await first;
    expect(api.posts).toHaveLength(1);
  });
  it('a late answer from an older load cannot overwrite a newer one', async () => {
    const api = new FakeApi(); const c = controller(api);
    let release: () => void = () => undefined;
    api.hold = new Promise<void>((resolve) => { release = resolve; });
    const slow = c.refresh();                                        // asks while the data is the old one, then waits
    await new Promise((r) => setTimeout(r, 0));
    api.data = { printers: [printer(9, { name: 'Newer' })], jobs: [] };
    await c.refresh();                                               // the newer load completes first
    release();
    await slow;                                                      // the older answer arrives last and must be ignored
    expect(c.getState().printers.map((p) => p.name)).toEqual(['Newer']);
  });
});

describe('PrintersView', () => {
  const base: PrintersState = { printers: [], jobs: [], loaded: true, busy: false, message: null, notice: null };
  const html = (state: Partial<PrintersState>, props: Partial<PrintersViewProps> = {}) =>
    renderToString(<PrintersView state={{ ...base, ...state }} draft={NEW_PRINTER} confirmRetireId={null} onDraftChange={() => undefined} onAdd={() => undefined} onMakeDefault={() => undefined}
      onAskRetire={() => undefined} onConfirmRetire={() => undefined} onRefresh={() => undefined} {...props} />).replace(/<!-- -->/g, '');
  const tag = (out: string, label: string) => { const end = out.indexOf(`>${label}</button>`); return end < 0 ? null : out.slice(out.lastIndexOf('<button', end), end + 1); };

  it('empty states explain what happens with no printer and no prints', () => {
    const out = html({});
    expect(out).toContain('No printers yet');
    expect(out).toContain('No prints recorded yet');
  });
  it('lists printers with kind, connection, paper and Default; the default has no Make default; retired ones are separate', () => {
    const out = html({ printers: [printer(1, { name: 'Front', isDefault: true }), printer(2, { name: 'Back', paperMm: 58, connection: 'usb' }), printer(3, { name: 'Old', status: 'retired', retiredAt: '2026-10-19T10:00:00.000Z' })] });
    expect(out).toContain('Front');
    expect(out).toContain('Default');
    expect(out).toContain('Receipt · USB · 58 mm');
    expect(out).toContain('aria-label="Make Back the default receipt printer"');
    expect(out).not.toContain('Make Front the default');
    expect(out).toContain('aria-label="Retired printers"');
    expect(out).not.toContain('Retire Old');
  });
  it('retiring takes a confirmation step', () => {
    const state = { printers: [printer(2, { name: 'Back' })] };
    expect(html(state)).not.toContain('Confirm: retire');
    expect(html(state, { confirmRetireId: uuid(2) })).toContain('Confirm: retire Back');
  });
  it('shows the print log with outcome, route and printer name, and a fixed label for a failure', () => {
    const out = html({ printers: [printer(1, { name: 'Front' })], jobs: [
      job(1, { printerId: uuid(1), printedVia: 'device' }),
      job(2, { kind: 'kitchen', trigger: 'manual', outcome: 'failed', failureCode: 'timeout' }),
    ] });
    expect(out).toContain('Device app');
    expect(out).toContain('Front');
    expect(out).toContain('Printed');
    expect(out).toContain('Sent by cashier');
    expect(out).toContain('Failed: No answer in time');
    expect(out).toContain('Browser (no registered printer)');
  });
  it('while offline or busy every change is disabled; the form refuses a blank name; no address field exists anywhere', () => {
    const printers = [printer(2, { name: 'Back' })];
    for (const out of [html({ printers }, { offline: true }), html({ printers, busy: true })]) {
      for (const label of ['Make default', 'Retire', 'Add printer']) expect(tag(out, label) ?? 'disabled=""', label).toContain('disabled');
    }
    expect(tag(html({}), 'Add printer')).toContain('disabled');
    expect(tag(html({}, { draft: { ...NEW_PRINTER, name: 'Bar' } }), 'Add printer')).not.toContain('disabled');
    expect(html({})).not.toMatch(/placeholder|IP address|MAC|192\.168/i);
    expect(html({})).toContain('address is set in the device app');
  });
  it('shows server messages as alerts and confirmations as status', () => {
    expect(html({ message: PRINTERS_FORBIDDEN })).toContain(`role="alert">${PRINTERS_FORBIDDEN}`);
    expect(html({ notice: 'Printer added.' })).toContain('role="status">Printer added.');
  });
});
