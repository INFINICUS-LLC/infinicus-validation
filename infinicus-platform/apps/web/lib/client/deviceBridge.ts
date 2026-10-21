/**
 * The INFINICUS device shell bridge (POS-8d). When the counter runs inside the native shell (a tablet or till app that wraps this web counter), the shell
 * injects `window.InfinicusDevice`. The shell alone knows which printer is attached (network, Bluetooth or USB address) and keeps that setting on the
 * device: the web counter stores nothing and holds no printer address. In an ordinary browser there is no bridge, and receipts print through the browser
 * (lib/client/printing). Everything the shell returns is untrusted input and is validated here.
 *
 * Contract, version 1:  window.InfinicusDevice = { version: 1, printEscPos(dataBase64: string): Promise<{ ok: boolean; error?: string }> }
 */
import type { Receipt } from './receipt';
import { TENDER_LABELS } from './tender';
import { receiptToEscPos, type EscPosResult } from './escpos';
import { DEFAULT_PRINT_SETTINGS, printReceiptNow, type PaperMm, type PrintFailureCode, type PrintOutcome } from './printing';

export interface DeviceBridge { printEscPos(dataBase64: string): Promise<unknown> }
export const BRIDGE_TIMEOUT_MS = 15_000;
export const DEVICE_PRINT_FAILED = 'The receipt could not be sent to the printer. The sale is recorded. Check the printer, then press Print receipt.';

/** The shell's bridge, or null in an ordinary browser or when the injected object does not match contract version 1. */
export function findDeviceBridge(host: unknown = typeof window === 'undefined' ? undefined : window): DeviceBridge | null {
  const candidate = (host as { InfinicusDevice?: unknown } | undefined)?.InfinicusDevice as { version?: unknown; printEscPos?: unknown } | undefined;
  if (!candidate || candidate.version !== 1 || typeof candidate.printEscPos !== 'function') return null;
  return { printEscPos: (data) => (candidate.printEscPos as (d: string) => Promise<unknown>).call(candidate, data) };
}

export const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

/** True when the sale was paid, at least in part, in cash: the only case where the drawer is opened. */
export const paidInCash = (receipt: Receipt): boolean => receipt.payments.some((p) => p.label === TENDER_LABELS.cash);

export interface PrintDeps { bridge: DeviceBridge | null; browserPrint: (receipt: Receipt, paperMm: PaperMm) => Promise<PrintOutcome>; setTimeout: (fn: () => void, ms: number) => unknown }
const realDeps = (): PrintDeps => ({ bridge: findDeviceBridge(), browserPrint: printReceiptNow, setTimeout: (fn, ms) => window.setTimeout(fn, ms) });

/** How a print ended, with the route it took (for the print-job log, POS-8c). A failure always carries a fixed code. */
export type PrintVia = 'browser' | 'device';
export type DetailedOutcome = { ok: true; via: PrintVia } | { ok: false; via: PrintVia; reason: string; code: PrintFailureCode };
export interface DocumentDeps { bridge: DeviceBridge | null; browserPrint: () => Promise<PrintOutcome>; setTimeout: (fn: () => void, ms: number) => unknown }

/**
 * Prints a prepared document the best available way: ESC/POS through the device shell when there is one and the document could be encoded; otherwise the
 * browser path. A shell that fails or does not answer is reported as a failure and is NOT retried through the browser, because the shell may have printed
 * already and a second paper copy is worse than a message.
 */
export async function printDocumentOnDevice(escpos: EscPosResult, deps: DocumentDeps): Promise<DetailedOutcome> {
  const bridge = deps.bridge;
  if (!bridge || !escpos.ok) {
    const outcome = await deps.browserPrint();
    return outcome.ok ? { ok: true, via: 'browser' } : { ok: false, via: 'browser', reason: outcome.reason, code: outcome.code ?? 'other' };
  }
  return new Promise<DetailedOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: DetailedOutcome): void => { if (!done) { done = true; resolve(outcome); } };
    const failed = (code: PrintFailureCode): DetailedOutcome => ({ ok: false, via: 'device', reason: DEVICE_PRINT_FAILED, code });
    deps.setTimeout(() => finish(failed('timeout')), BRIDGE_TIMEOUT_MS);
    try {
      bridge.printEscPos(toBase64(escpos.bytes)).then(
        (answer) => finish((answer as { ok?: unknown } | null)?.ok === true ? { ok: true, via: 'device' } : failed('printer_error')),
        () => finish(failed('printer_error')),
      );
    } catch { finish(failed('printer_error')); }
  });
}

/**
 * Prints a receipt the best available way. In the device shell it sends ESC/POS bytes straight to the printer (no dialog); the cash drawer opens only for
 * the automatic print of a cash sale, never on a reprint. If there is no shell, or the receipt cannot be encoded for a plain printer (for example Arabic
 * text), the browser receipt is used.
 */
export function printReceiptDetailed(receipt: Receipt, paperMm: PaperMm = DEFAULT_PRINT_SETTINGS.paperMm, options: { automatic?: boolean } = {}, deps: PrintDeps = realDeps()): Promise<DetailedOutcome> {
  const escpos = receiptToEscPos(receipt, paperMm, { openDrawer: options.automatic === true && paidInCash(receipt) });
  return printDocumentOnDevice(escpos, { bridge: deps.bridge, browserPrint: () => deps.browserPrint(receipt, paperMm), setTimeout: deps.setTimeout });
}

/** As printReceiptDetailed, reduced to the plain outcome. */
export async function printReceiptOnDevice(receipt: Receipt, paperMm: PaperMm = DEFAULT_PRINT_SETTINGS.paperMm, options: { automatic?: boolean } = {}, deps: PrintDeps = realDeps()): Promise<PrintOutcome> {
  const outcome = await printReceiptDetailed(receipt, paperMm, options, deps);
  return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
}
