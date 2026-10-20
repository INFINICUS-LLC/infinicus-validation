import { describe, it, expect } from 'vitest';
import { BRIDGE_TIMEOUT_MS, DEVICE_PRINT_FAILED, findDeviceBridge, paidInCash, printReceiptOnDevice, toBase64, type DeviceBridge, type PrintDeps } from '../lib/client/deviceBridge';
import { COLUMNS, DRAWER_PULSE, receiptToEscPos, row, wrap } from '../lib/client/escpos';
import type { Receipt } from '../lib/client/receipt';

const receipt: Receipt = {
  businessName: 'Cafe Nour', orderNumber: 'ORD-0042', dateText: '20 Oct 2026, 10:00', currencyCode: 'KWD',
  lines: [
    { kind: 'item', description: 'Latte large with oat milk and an extra shot', quantityText: '2', unitText: 'KWD 1.250', totalText: 'KWD 2.500' },
    { kind: 'discount', description: 'Discount: Staff', quantityText: '1', unitText: '-KWD 0.500', totalText: '-KWD 0.500' },
  ],
  totalText: 'KWD 2.000',
  payments: [{ label: 'Cash', appliedText: 'KWD 2.000', receivedText: 'KWD 5.000', referenceText: null }],
  changeText: 'KWD 3.000',
};
const card: Receipt = { ...receipt, payments: [{ label: 'Card', appliedText: 'KWD 2.000', receivedText: null, referenceText: 'AUTH12' }], changeText: null };
/** The printable text of the bytes, with the command sequences (initialise, align, bold, cut, drawer) removed first. */
const asText = (b: Uint8Array): string => {
  const out: number[] = [];
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] === 0x1b) { i += b[i + 1] === 0x40 ? 1 : b[i + 1] === 0x70 ? 4 : 2; continue; }
    if (b[i] === 0x1d) { i += 3; continue; }
    out.push(b[i]);
  }
  return out.map((c) => (c === 0x0a ? '\n' : String.fromCharCode(c))).join('');
};
const has = (b: Uint8Array, seq: readonly number[]): boolean => Array.from(b).some((_, i) => seq.every((v, j) => b[i + j] === v));

describe('wrap / row', () => {
  it('wraps at spaces, splits over-long words, never exceeds the width', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('', 5)).toEqual(['']);
  });
  it('right-aligns the amount and wraps a long description above it', () => {
    expect(row('Total', 'KWD 2.000', 20)).toEqual(['Total      KWD 2.000']);
    const lines = row('a very long description here', '9.000', 16);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(16);
    expect(lines.at(-1)?.endsWith('9.000')).toBe(true);
  });
});

describe('receiptToEscPos', () => {
  it('starts with initialise, ends with feed-and-cut, and holds every line within the paper columns', () => {
    for (const mm of [80, 58] as const) {
      const r = receiptToEscPos(receipt, mm);
      if (!r.ok) throw new Error('expected ok');
      expect(Array.from(r.bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
      expect(Array.from(r.bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x03]);
      for (const line of asText(r.bytes).split('\n')) expect(line.length, line).toBeLessThanOrEqual(COLUMNS[mm]);
    }
  });
  it('prints the receipt content, discount without a quantity', () => {
    const r = receiptToEscPos(receipt, 80);
    if (!r.ok) throw new Error('expected ok');
    const t = asText(r.bytes);
    for (const s of ['Cafe Nour', 'ORD-0042', '2 x Latte', 'Discount: Staff', '-KWD 0.500', 'Total', 'KWD 2.000', 'Cash (received KWD 5.000)', 'Change', 'KWD 3.000']) expect(t, s).toContain(s);
    expect(t).not.toContain('1 x Discount');
  });
  it('adds the drawer pulse only when asked', () => {
    const on = receiptToEscPos(receipt, 80, { openDrawer: true });
    const off = receiptToEscPos(receipt, 80);
    if (!on.ok || !off.ok) throw new Error('expected ok');
    expect(has(on.bytes, DRAWER_PULSE)).toBe(true);
    expect(has(off.bytes, DRAWER_PULSE)).toBe(false);
  });
  it('refuses text a plain printer cannot print, so the caller can fall back', () => {
    expect(receiptToEscPos({ ...receipt, businessName: 'مقهى النور' }, 80)).toMatchObject({ ok: false });
    expect(receiptToEscPos({ ...receipt, lines: [{ ...receipt.lines[0], description: 'Café' }] }, 80)).toMatchObject({ ok: false });
  });
});

describe('findDeviceBridge', () => {
  it('is null in an ordinary browser and for anything that does not match contract version 1', () => {
    expect(findDeviceBridge({})).toBeNull();
    expect(findDeviceBridge(undefined)).toBeNull();
    expect(findDeviceBridge({ InfinicusDevice: 'x' })).toBeNull();
    expect(findDeviceBridge({ InfinicusDevice: { version: 2, printEscPos: () => undefined } })).toBeNull();
    expect(findDeviceBridge({ InfinicusDevice: { version: 1 } })).toBeNull();
  });
  it('wraps a valid bridge and keeps `this` bound to it', async () => {
    const shell = { version: 1, seen: '', async printEscPos(this: { seen: string }, d: string) { this.seen = d; return { ok: true }; } };
    const bridge = findDeviceBridge({ InfinicusDevice: shell });
    expect(await bridge?.printEscPos('abc')).toEqual({ ok: true });
    expect(shell.seen).toBe('abc');
  });
  it('encodes bytes as base64', () => { expect(toBase64(Uint8Array.from([0x1b, 0x40, 0x41]))).toBe(btoa('\x1b@A')); });
});

describe('printReceiptOnDevice', () => {
  const deps = (bridge: DeviceBridge | null) => {
    const calls = { browser: 0, sent: [] as string[], timers: [] as { fn: () => void; ms: number }[] };
    const d: PrintDeps = {
      bridge: bridge && { printEscPos: (data) => { calls.sent.push(data); return bridge.printEscPos(data); } },
      browserPrint: async () => { calls.browser += 1; return { ok: true }; },
      setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return 0; },
    };
    return { d, calls };
  };
  const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const okBridge: DeviceBridge = { printEscPos: async () => ({ ok: true }) };

  it('without a shell it prints through the browser', async () => {
    const { d, calls } = deps(null);
    expect(await printReceiptOnDevice(receipt, 80, {}, d)).toEqual({ ok: true });
    expect(calls.browser).toBe(1);
  });
  it('in the shell it sends ESC/POS (no browser dialog); the drawer opens on the automatic print of a cash sale only', async () => {
    const auto = deps(okBridge);
    expect(await printReceiptOnDevice(receipt, 80, { automatic: true }, auto.d)).toEqual({ ok: true });
    expect(auto.calls.browser).toBe(0);
    expect(has(decode(auto.calls.sent[0]), DRAWER_PULSE)).toBe(true);
    const again = deps(okBridge);
    await printReceiptOnDevice(receipt, 80, {}, again.d);                      // a reprint
    expect(has(decode(again.calls.sent[0]), DRAWER_PULSE)).toBe(false);
    const cardSale = deps(okBridge);
    await printReceiptOnDevice(card, 80, { automatic: true }, cardSale.d);     // a card sale
    expect(has(decode(cardSale.calls.sent[0]), DRAWER_PULSE)).toBe(false);
  });
  it('falls back to the browser receipt when the receipt cannot be encoded (Arabic)', async () => {
    const { d, calls } = deps(okBridge);
    await printReceiptOnDevice({ ...receipt, businessName: 'مقهى النور' }, 80, { automatic: true }, d);
    expect(calls.browser).toBe(1);
    expect(calls.sent).toHaveLength(0);
  });
  it('reports a shell failure, a refusal, a throw or silence as a failure and never reprints through the browser', async () => {
    for (const bridge of [
      { printEscPos: async () => ({ ok: false, error: 'offline' }) }, { printEscPos: async () => 'ok' }, { printEscPos: async () => null },
      { printEscPos: async () => { throw new Error('x'); } }, { printEscPos: () => { throw new Error('x'); } },
    ] as DeviceBridge[]) {
      const { d, calls } = deps(bridge);
      expect(await printReceiptOnDevice(receipt, 80, {}, d)).toEqual({ ok: false, reason: DEVICE_PRINT_FAILED });
      expect(calls.browser).toBe(0);
    }
    const silent = deps({ printEscPos: () => new Promise(() => undefined) });
    const p = printReceiptOnDevice(receipt, 80, {}, silent.d);
    silent.calls.timers.find((t) => t.ms === BRIDGE_TIMEOUT_MS)?.fn();
    expect(await p).toEqual({ ok: false, reason: DEVICE_PRINT_FAILED });
  });
  it('paidInCash is true only when a Cash payment is on the receipt', () => { expect(paidInCash(receipt)).toBe(true); expect(paidInCash(card)).toBe(false); });
});
