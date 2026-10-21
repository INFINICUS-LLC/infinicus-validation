/**
 * The cashier's receipt-printing choices (POS-8e): automatic printing after payment, and the paper width. Remembered for the TAB SESSION only (sessionStorage,
 * same convenience as the workspace selection): a reload keeps them, closing the tab forgets them, and nothing else is ever stored here. The value holds two
 * harmless fields; it is validated on the way back in, so a tampered or stale entry just means the defaults.
 */
import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from './printing';
import type { TabStorage } from './workspaces';

export const PRINT_PREFS_KEY = 'inf_web_print_v1';

/** The tab's storage, or null when the browser has none or refuses it (private mode, server rendering). */
export function tabStorage(): TabStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

export function loadPrintPrefs(storage: TabStorage | null): PrintSettings {
  try {
    const raw = storage?.getItem(PRINT_PREFS_KEY);
    if (!raw) return DEFAULT_PRINT_SETTINGS;
    const v = JSON.parse(raw) as { auto?: unknown; paperMm?: unknown } | null;
    if (!v || typeof v !== 'object') return DEFAULT_PRINT_SETTINGS;
    return { auto: v.auto === true, paperMm: v.paperMm === 58 ? 58 : 80 };
  } catch { return DEFAULT_PRINT_SETTINGS; }
}

export function savePrintPrefs(storage: TabStorage | null, settings: PrintSettings): void {
  try { storage?.setItem(PRINT_PREFS_KEY, JSON.stringify({ auto: settings.auto, paperMm: settings.paperMm })); } catch { /* storage unavailable: the choice just is not remembered */ }
}
