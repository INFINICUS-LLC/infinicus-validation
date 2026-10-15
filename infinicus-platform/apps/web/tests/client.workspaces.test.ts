import { describe, it, expect } from 'vitest';
import { loadSavedScope, pickInitialScope, saveScope, forgetScope, scopeOf, SCOPE_STORAGE_KEY } from '../lib/client/workspaces';
import { MemoryStorage, membership } from './helpers/fakes';

describe('workspace selection helpers', () => {
  const a = membership('A'); const b = membership('B');
  it('picks the remembered scope only if it is still listed, else the only workspace, else none', () => {
    expect(pickInitialScope([a, b], scopeOf(b))).toEqual(scopeOf(b));
    expect(pickInitialScope([a, b], scopeOf(membership('Gone')))).toBeNull();
    expect(pickInitialScope([a], null)).toEqual(scopeOf(a));
    expect(pickInitialScope([a], scopeOf(membership('Gone')))).toEqual(scopeOf(a));
    expect(pickInitialScope([a, b], null)).toBeNull();
    expect(pickInitialScope([], null)).toBeNull();
  });
  it('stores only the two ids, ignores corrupt or hostile stored values, and survives unavailable storage', () => {
    const s = new MemoryStorage();
    saveScope(s, scopeOf(a));
    expect(JSON.parse(s.getItem(SCOPE_STORAGE_KEY)!)).toEqual(scopeOf(a));
    expect(loadSavedScope(s)).toEqual(scopeOf(a));
    s.setItem(SCOPE_STORAGE_KEY, '{"tenantId":"x","workspaceId":"y"}');
    expect(loadSavedScope(s)).toBeNull();
    s.setItem(SCOPE_STORAGE_KEY, 'not json');
    expect(loadSavedScope(s)).toBeNull();
    forgetScope(s);
    expect(s.getItem(SCOPE_STORAGE_KEY)).toBeNull();
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(loadSavedScope(broken)).toBeNull();
    expect(() => { saveScope(broken, scopeOf(a)); forgetScope(broken); }).not.toThrow();
    expect(loadSavedScope(null)).toBeNull();
  });
});
