import { describe, it, expect } from 'vitest';
import { readWebConfig, looksLikeSecretKey } from '../lib/client/config';

const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.s`;
const ok = { supabaseUrl: 'https://proj.supabase.example/', supabaseAnonKey: jwt('anon'), apiBaseUrl: 'https://api.example.test/v1/ignored' };

describe('browser configuration (public values only, fail closed)', () => {
  it('normalises URLs to their origin and accepts an anon key', () => {
    expect(readWebConfig(ok)).toEqual({ ok: true, supabaseUrl: 'https://proj.supabase.example', supabaseAnonKey: ok.supabaseAnonKey, apiBaseUrl: 'https://api.example.test' });
  });
  it('lists every missing name and never falls back to a default', () => {
    expect(readWebConfig({})).toEqual({ ok: false, missing: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_API_BASE_URL'], invalid: [] });
    expect(readWebConfig({ ...ok, apiBaseUrl: '   ' })).toMatchObject({ ok: false, missing: ['NEXT_PUBLIC_API_BASE_URL'] });
  });
  it('refuses plain http except for loopback, and URLs that carry credentials', () => {
    expect(readWebConfig({ ...ok, apiBaseUrl: 'http://api.example.test' })).toMatchObject({ ok: false, invalid: ['NEXT_PUBLIC_API_BASE_URL'] });
    expect(readWebConfig({ ...ok, apiBaseUrl: 'http://localhost:3000' })).toMatchObject({ ok: true, apiBaseUrl: 'http://localhost:3000' });
    expect(readWebConfig({ ...ok, supabaseUrl: 'https://user:pw@proj.supabase.example' })).toMatchObject({ ok: false, invalid: ['NEXT_PUBLIC_SUPABASE_URL'] });
    expect(readWebConfig({ ...ok, supabaseUrl: 'not a url' })).toMatchObject({ ok: false, invalid: ['NEXT_PUBLIC_SUPABASE_URL'] });
  });
  it('refuses a service/secret key outright', () => {
    expect(looksLikeSecretKey('sb_secret_abc')).toBe(true);
    expect(looksLikeSecretKey(jwt('service_role'))).toBe(true);
    expect(looksLikeSecretKey(jwt('anon'))).toBe(false);
    expect(looksLikeSecretKey('sb_publishable_abc')).toBe(false);
    expect(readWebConfig({ ...ok, supabaseAnonKey: jwt('service_role') })).toMatchObject({ ok: false, invalid: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'] });
    expect(readWebConfig({ ...ok, supabaseAnonKey: 'sb_secret_x' })).toMatchObject({ ok: false });
  });
});
