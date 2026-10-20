import { describe, it, expect } from 'vitest';
import { loadPrintPrefs, PRINT_PREFS_KEY, savePrintPrefs, tabStorage } from '../lib/client/printPrefs';
import { DEFAULT_PRINT_SETTINGS } from '../lib/client/printing';
import type { TabStorage } from '../lib/client/workspaces';

const memory = (initial: Record<string, string> = {}): TabStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
};

describe('print preferences (tab session only)', () => {
  it('defaults when nothing is stored or there is no storage', () => {
    expect(loadPrintPrefs(memory())).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(loadPrintPrefs(null)).toEqual(DEFAULT_PRINT_SETTINGS);
  });
  it('round-trips the two choices and stores nothing else', () => {
    const s = memory();
    savePrintPrefs(s, { auto: true, paperMm: 58 });
    expect(Object.keys(s.data)).toEqual([PRINT_PREFS_KEY]);
    expect(JSON.parse(s.data[PRINT_PREFS_KEY])).toEqual({ auto: true, paperMm: 58 });
    expect(loadPrintPrefs(s)).toEqual({ auto: true, paperMm: 58 });
  });
  it('a tampered or stale entry means defaults for what is wrong, never anything else', () => {
    expect(loadPrintPrefs(memory({ [PRINT_PREFS_KEY]: '{not json' }))).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(loadPrintPrefs(memory({ [PRINT_PREFS_KEY]: 'null' }))).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(loadPrintPrefs(memory({ [PRINT_PREFS_KEY]: '"x"' }))).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(loadPrintPrefs(memory({ [PRINT_PREFS_KEY]: JSON.stringify({ auto: 'yes', paperMm: 100, extra: 1 }) }))).toEqual({ auto: false, paperMm: 80 });
  });
  it('a storage that throws never breaks the counter', () => {
    const broken: TabStorage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => undefined };
    expect(loadPrintPrefs(broken)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(() => savePrintPrefs(broken, DEFAULT_PRINT_SETTINGS)).not.toThrow();
  });
  it('there is no tab storage without a window (server rendering)', () => { expect(tabStorage()).toBeNull(); });
});
