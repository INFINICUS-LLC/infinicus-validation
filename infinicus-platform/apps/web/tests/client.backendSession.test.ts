import { describe, it, expect, vi } from 'vitest';
import { BackendSessionManager, NoProviderSessionError, ExchangeFailedError, StaleExchangeError } from '../lib/client/backendSession';
import { FakeBackend } from './helpers/fakes';

function setup(over: { backend?: FakeBackend; providerToken?: string | null; logoutTimeoutMs?: number } = {}) {
  const backend = over.backend ?? new FakeBackend();
  backend.registerProviderToken('prov-a', 'user-a');
  const warn = vi.fn();
  let providerToken: string | null = over.providerToken === undefined ? 'prov-a' : over.providerToken;
  const manager = new BackendSessionManager({ baseUrl: 'https://api.example.test', getProviderToken: () => providerToken, fetchImpl: backend.fetch, logoutTimeoutMs: over.logoutTimeoutMs ?? 30, warn });
  return { backend, manager, warn, setProviderToken: (t: string | null) => { providerToken = t; } };
}

describe('backend session custody (in memory only)', () => {
  it('exchanges the provider token once for concurrent callers and exposes who it belongs to, never the token', async () => {
    const { backend, manager } = setup();
    const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
    expect(a).toBe(b);
    expect(backend.exchangeCount).toBe(1);
    expect(manager.current).toEqual({ userId: backend.backendUserFor('user-a').id, email: 'user-a@example.test' });
    expect(JSON.stringify(manager.current)).not.toContain(a);
    expect(backend.requests[0].body).toEqual({ accessToken: 'prov-a' });          // the ONLY thing sent: the provider access token
  });

  it('without a provider session there is nothing to exchange', async () => {
    const { manager, backend } = setup({ providerToken: null });
    await expect(manager.ensure()).rejects.toBeInstanceOf(NoProviderSessionError);
    expect(backend.requests).toHaveLength(0);
  });

  it('reports a refused or unreachable exchange without leaking detail', async () => {
    const { manager, backend } = setup();
    backend.exchangeStatus = 503;
    await expect(manager.ensure()).rejects.toMatchObject({ name: 'ExchangeFailedError', status: 503 });
    backend.exchangeStatus = 401;
    await expect(manager.ensure()).rejects.toBeInstanceOf(ExchangeFailedError);
    const broken = new BackendSessionManager({ baseUrl: 'https://api.example.test', getProviderToken: () => 'x', fetchImpl: (async () => { throw new TypeError('down'); }) as unknown as typeof fetch });
    await expect(broken.ensure()).rejects.toMatchObject({ status: 0 });
    const odd = new BackendSessionManager({ baseUrl: 'https://api.example.test', getProviderToken: () => 'x', fetchImpl: (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch });
    await expect(odd.ensure()).rejects.toBeInstanceOf(ExchangeFailedError);
  });

  it('clear() revokes the session on the server (204), forgets it locally, and records a confirmed outcome', async () => {
    const { manager, backend } = setup();
    const token = await manager.ensure();
    expect(backend.sessions.has(token)).toBe(true);
    const outcome = await manager.clear();
    expect(outcome.ok).toBe(true);
    expect(backend.sessions.has(token)).toBe(false);
    expect(manager.current).toBeNull();
    expect(manager.lastRevocation?.ok).toBe(true);
    expect(backend.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` } });
  });

  it.each([
    ['rejected (401)', 401, 'rejected'],
    ['server error (500)', 500, 'server-error'],
    ['network failure', 'network', 'network'],
    ['timeout', 'hang', 'timeout'],
  ] as const)('a failed revocation (%s) is never reported as success, never throws, and the warning carries no token', async (_label, mode, reason) => {
    const { manager, backend, warn } = setup();
    const token = await manager.ensure();
    if (mode === 401) backend.sessions.delete(token);              // server already dropped it -> logout answers 401
    else backend.logoutStatus = mode;
    const outcome = await manager.clear();
    expect(outcome).toMatchObject({ ok: false, reason });
    expect(manager.current).toBeNull();                              // local state is cleared regardless
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain(token);
  });

  it('clear() with no session says so (no request, no warning)', async () => {
    const { manager, backend, warn } = setup();
    expect(await manager.clear()).toMatchObject({ ok: false, reason: 'no-token' });
    expect(backend.requests).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an exchange that finishes after a sign-out is discarded AND its session is revoked', async () => {
    const { manager, backend } = setup();
    backend.exchangeDelayMs = 40;
    const pending = manager.ensure();
    const settled = pending.catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    await manager.clear();                                          // sign-out while the exchange is in flight
    expect(await settled).toBeInstanceOf(StaleExchangeError);
    expect(manager.current).toBeNull();
    expect(backend.sessions.size).toBe(0);                          // the late session was revoked, not kept
  });

  it('refresh() drops a dead token and obtains a new session; null when impossible', async () => {
    const { manager, backend, setProviderToken } = setup();
    const first = await manager.ensure();
    backend.sessions.delete(first);                                 // the server no longer accepts it
    const second = await manager.refresh();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    setProviderToken(null);
    expect(await manager.refresh()).toBeNull();
  });
});
