/**
 * The device-shell script that defines window.InfinicusDevice (contract v1), run in an isolated context with a fake native message port, and then driven
 * through the web counter's OWN bridge client (lib/client/deviceBridge.ts), so the contract is proved from both sides up to the native boundary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join } from 'node:path';
import { findDeviceBridge, printDocumentOnDevice, type DocumentDeps } from '../../web/lib/client/deviceBridge';
import { receiptToEscPos } from '../../web/lib/client/escpos';
import type { Receipt } from '../../web/lib/client/receipt';

const SHIM = readFileSync(join(__dirname, '../android/app/src/main/assets/infinicus-device-shim.js'), 'utf8');

interface FakePort { sent: string[]; onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: string): void; throwOnPost?: boolean }
interface Win { InfinicusDevice?: { version: number; printEscPos(d: string): Promise<{ ok: boolean; error?: string }> }; InfinicusNative?: FakePort; [k: string]: unknown }

/** A page context with the shim installed; `withPort` false = no native port (as if the listener could not be installed). */
function page(opts: { withPort?: boolean; timers?: { fn: () => void; ms: number }[] } = {}): { win: Win; port: FakePort | undefined } {
  const port: FakePort | undefined = opts.withPort === false ? undefined : { sent: [], onmessage: null, postMessage(m) { if (this.throwOnPost) throw new Error('boom'); this.sent.push(m); } };
  const timers = opts.timers;
  const sandbox: Record<string, unknown> = {
    Promise, Object, Date, Math, String, RegExp,
    setTimeout: (fn: () => void, ms: number) => { if (timers) { timers.push({ fn, ms }); return timers.length; } return setTimeout(fn, ms); },
    clearTimeout: (h: number) => { if (!timers) clearTimeout(h); },
  };
  sandbox.window = sandbox;
  if (port) sandbox.InfinicusNative = port;
  const ctx = createContext(sandbox);
  runInContext(SHIM, ctx);
  return { win: sandbox as unknown as Win, port };
}
const B64 = Buffer.from([0x1b, 0x40, 0x48, 0x69]).toString('base64');
const idOf = (m: string): string => m.split('\n')[0];

describe('window.InfinicusDevice (contract version 1)', () => {
  it('is defined with version 1 and one method, frozen, and the page cannot replace or redefine it', () => {
    const { win } = page();
    expect(win.InfinicusDevice?.version).toBe(1);
    expect(Object.keys(win.InfinicusDevice as object).sort()).toEqual(['printEscPos', 'version']);
    expect(Object.isFrozen(win.InfinicusDevice)).toBe(true);
    const original = win.InfinicusDevice;
    expect(() => { 'use strict'; (win as Record<string, unknown>).InfinicusDevice = {}; }).toThrow();
    expect(() => Object.defineProperty(win, 'InfinicusDevice', { value: {} })).toThrow();
    expect(win.InfinicusDevice).toBe(original);
    expect(Object.keys(win).includes('InfinicusDevice')).toBe(false);               // not enumerable
  });

  it('is defined only once even if the script runs again', () => {
    const { win } = page();
    const first = win.InfinicusDevice;
    runInContext(SHIM, createContext(Object.assign(win, { window: win })));
    expect(win.InfinicusDevice).toBe(first);
  });

  it('sends "<id>\\n<base64>" and resolves { ok: true } when the native side answers ok', async () => {
    const { win, port } = page();
    const p = win.InfinicusDevice!.printEscPos(B64);
    expect(port!.sent).toHaveLength(1);
    expect(port!.sent[0]).toMatch(/^[A-Za-z0-9-]{1,64}\n/);
    expect(port!.sent[0].split('\n')[1]).toBe(B64);
    port!.onmessage!({ data: `${idOf(port!.sent[0])}\nok` });
    expect(await p).toEqual({ ok: true });
  });

  it('turns a native failure code into { ok: false, error } and matches concurrent calls to their own answers', async () => {
    const { win, port } = page();
    const a = win.InfinicusDevice!.printEscPos(B64);
    const b = win.InfinicusDevice!.printEscPos(B64);
    const [idA, idB] = port!.sent.map(idOf);
    expect(idA).not.toBe(idB);
    port!.onmessage!({ data: `${idB}\nok` });
    port!.onmessage!({ data: `${idA}\nconnection_failed` });
    expect(await a).toEqual({ ok: false, error: 'connection_failed' });
    expect(await b).toEqual({ ok: true });
  });

  it('ignores replies it cannot match: unknown id, repeated reply, wrong type, no newline', async () => {
    const { win, port } = page();
    const p = win.InfinicusDevice!.printEscPos(B64);
    const id = idOf(port!.sent[0]);
    for (const data of [`zzz\nok`, 'ok', 42, null, undefined, `\nok`]) port!.onmessage!({ data });
    port!.onmessage!({ data: `${id}\nwrite_failed` });
    port!.onmessage!({ data: `${id}\nok` });             // a second answer for the same call changes nothing
    expect(await p).toEqual({ ok: false, error: 'write_failed' });
  });

  it('refuses malformed input without touching the native side', async () => {
    const { win, port } = page();
    for (const bad of ['', 'AQI', 'not base64!', 'AQID\n', 42 as unknown as string, null as unknown as string]) {
      expect(await win.InfinicusDevice!.printEscPos(bad)).toEqual({ ok: false, error: 'invalid_request' });
    }
    expect(port!.sent).toHaveLength(0);
  });

  it('settles with timeout after 12 seconds when the device never answers, and a late answer changes nothing', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const { win, port } = page({ timers });
    const p = win.InfinicusDevice!.printEscPos(B64);
    expect(timers.map((t) => t.ms)).toEqual([12000]);
    timers[0].fn();
    expect(await p).toEqual({ ok: false, error: 'timeout' });
    port!.onmessage!({ data: `${idOf(port!.sent[0])}\nok` });      // too late: no effect, no throw
  });

  it('reports not_available without a native port, and connection_failed when posting throws', async () => {
    expect(await page({ withPort: false }).win.InfinicusDevice!.printEscPos(B64)).toEqual({ ok: false, error: 'not_available' });
    const { win, port } = page();
    port!.throwOnPost = true;
    expect(await win.InfinicusDevice!.printEscPos(B64)).toEqual({ ok: false, error: 'connection_failed' });
  });

  it('does not leak anything else into the page', () => {
    const { win } = page();
    const names = Object.getOwnPropertyNames(win).filter((n) => !['Promise', 'Object', 'Date', 'Math', 'String', 'RegExp', 'setTimeout', 'clearTimeout', 'window', 'InfinicusNative', 'InfinicusDevice'].includes(n));
    expect(names).toEqual([]);
  });
});

describe('the web counter\'s own bridge client accepts it and drives it end to end', () => {
  const receipt: Receipt = {
    businessName: 'Cafe Nour', orderNumber: 'ORD-1', dateText: '21 Oct 2026', currencyCode: 'KWD',
    lines: [{ kind: 'item', description: 'Latte', quantityText: '2', unitText: 'KWD 1.250', totalText: 'KWD 2.500' }],
    totalText: 'KWD 2.500', payments: [{ label: 'Cash', appliedText: 'KWD 2.500', receivedText: 'KWD 5.000', referenceText: null }], changeText: 'KWD 2.500',
  };
  const deps = (win: Win): DocumentDeps => ({ bridge: findDeviceBridge(win), browserPrint: async () => ({ ok: true }), setTimeout: () => 0 });

  it('findDeviceBridge finds it, and the exact ESC/POS bytes of a receipt reach the native boundary unchanged', async () => {
    const { win, port } = page();
    expect(findDeviceBridge(win)).not.toBeNull();
    const escpos = receiptToEscPos(receipt, 80, { openDrawer: true });
    if (!escpos.ok) throw new Error('expected an encodable receipt');
    const result = printDocumentOnDevice(escpos, deps(win));
    expect(port!.sent).toHaveLength(1);
    expect(Buffer.from(port!.sent[0].split('\n')[1], 'base64')).toEqual(Buffer.from(escpos.bytes));
    port!.onmessage!({ data: `${idOf(port!.sent[0])}\nok` });
    expect(await result).toEqual({ ok: true, via: 'device' });
  });

  it('a native failure becomes the counter\'s device failure (printer_error); a silent device times out in the shim and the page is told, never retried through the browser', async () => {
    let browserCalls = 0;
    const escpos = receiptToEscPos(receipt, 58);
    if (!escpos.ok) throw new Error('expected an encodable receipt');
    const failing = page();
    const d1 = { ...deps(failing.win), browserPrint: async () => { browserCalls += 1; return { ok: true as const }; } };
    const r1 = printDocumentOnDevice(escpos, d1);
    failing.port!.onmessage!({ data: `${idOf(failing.port!.sent[0])}\nconnection_failed` });
    expect(await r1).toMatchObject({ ok: false, via: 'device', code: 'printer_error' });
    const timers: { fn: () => void; ms: number }[] = [];
    const silent = page({ timers });
    const d2 = { ...deps(silent.win), browserPrint: async () => { browserCalls += 1; return { ok: true as const }; } };
    const r2 = printDocumentOnDevice(escpos, d2);
    timers[0].fn();                                       // the shim gives up first (12 s < the web client's 15 s)
    expect(await r2).toMatchObject({ ok: false, via: 'device', code: 'printer_error' });
    expect(browserCalls).toBe(0);
  });

  it('without the shell the page has no bridge and prints through the browser as before', () => {
    expect(findDeviceBridge({})).toBeNull();
  });
});
