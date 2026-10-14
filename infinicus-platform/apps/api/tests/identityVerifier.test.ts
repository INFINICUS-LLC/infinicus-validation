import { describe, it, expect } from 'vitest';
import {
  SupabaseIdentityVerifier, resolveIdentityVerifier, UnconfiguredIdentityVerifier,
  IdentityTokenInvalidError, IdentityProviderUnavailableError, IdentityExchangeNotConfiguredError, type FetchLike,
} from '../src/identityVerifier.js';

const ID = '3f2b8a40-1c5e-4d7a-9b61-0a1b2c3d4e5f';
const reply = (status: number, body: unknown, bad = false) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (bad) throw new SyntaxError('bad json'); return body; } });
const verifierWith = (f: FetchLike, url = 'https://proj.supabase.co') => new SupabaseIdentityVerifier(url, 'public-anon-key', f);
const TOKEN = 'a-provider-access-token-value';

describe('SupabaseIdentityVerifier', () => {
  it('calls GET {SUPABASE_URL}/auth/v1/user with apikey + Bearer headers and a timeout signal, and returns the provider user id', async () => {
    let seen: { url: string; init: Parameters<FetchLike>[1] } | undefined;
    const v = verifierWith(async (url, init) => { seen = { url, init }; return reply(200, { id: ID.toUpperCase(), email_confirmed_at: '2026-10-01T00:00:00Z' })(); });
    await expect(v.verify(TOKEN)).resolves.toEqual({ providerUserId: ID });
    expect(seen!.url).toBe('https://proj.supabase.co/auth/v1/user');
    expect(seen!.init.method).toBe('GET');
    expect(seen!.init.headers).toEqual({ apikey: 'public-anon-key', Authorization: `Bearer ${TOKEN}` });
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects an unconfirmed email', async () => {
    await expect(verifierWith(reply(200, { id: ID, email_confirmed_at: null })).verify(TOKEN)).rejects.toBeInstanceOf(IdentityTokenInvalidError);
    await expect(verifierWith(reply(200, { id: ID })).verify(TOKEN)).rejects.toBeInstanceOf(IdentityTokenInvalidError);
  });
  it('rejects a missing or non-uuid id', async () => {
    for (const id of [undefined, '', 'not-a-uuid', 42, `${ID}-extra`]) {
      await expect(verifierWith(reply(200, { id, email_confirmed_at: '2026-10-01T00:00:00Z' })).verify(TOKEN)).rejects.toBeInstanceOf(IdentityTokenInvalidError);
    }
    await expect(verifierWith(reply(200, null)).verify(TOKEN)).rejects.toBeInstanceOf(IdentityTokenInvalidError);
  });
  it('maps provider 401/403 to an invalid token', async () => {
    for (const s of [401, 403]) await expect(verifierWith(reply(s, {})).verify(TOKEN)).rejects.toBeInstanceOf(IdentityTokenInvalidError);
  });
  it('maps provider 5xx, other non-ok, bad JSON and network errors to provider-unavailable', async () => {
    for (const s of [500, 502, 503, 404, 429]) await expect(verifierWith(reply(s, {})).verify(TOKEN)).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
    await expect(verifierWith(reply(200, {}, true)).verify(TOKEN)).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
    await expect(verifierWith(async () => { throw new TypeError('fetch failed'); }).verify(TOKEN)).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
  });
  it('allows https, and http only for loopback', () => {
    expect(() => verifierWith(reply(200, {}), 'https://proj.supabase.co')).not.toThrow();
    expect(() => verifierWith(reply(200, {}), 'http://127.0.0.1:54321')).not.toThrow();
    expect(() => verifierWith(reply(200, {}), 'http://localhost:54321')).not.toThrow();
    for (const bad of ['http://proj.supabase.co', 'http://10.0.0.5', 'ftp://proj.supabase.co', 'not a url']) expect(() => verifierWith(reply(200, {}), bad)).toThrow();
  });
});

describe('resolveIdentityVerifier', () => {
  it('is closed unless BOTH values are set', async () => {
    for (const env of [{}, { SUPABASE_URL: 'https://proj.supabase.co' }, { SUPABASE_ANON_KEY: 'k' }, { SUPABASE_URL: ' ', SUPABASE_ANON_KEY: 'k' }]) {
      const v = resolveIdentityVerifier(env as NodeJS.ProcessEnv);
      expect(v).toBeInstanceOf(UnconfiguredIdentityVerifier);
      await expect(v.verify(TOKEN)).rejects.toBeInstanceOf(IdentityExchangeNotConfiguredError);
    }
    expect(resolveIdentityVerifier({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'k' } as NodeJS.ProcessEnv)).toBeInstanceOf(SupabaseIdentityVerifier);
  });
});
