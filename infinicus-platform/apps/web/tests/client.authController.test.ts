import { describe, it, expect, vi } from 'vitest';
import { AuthController, type AuthState } from '../lib/client/authController';
import { SCOPE_STORAGE_KEY } from '../lib/client/workspaces';
import { FakeBackend, FakeProvider, MemoryStorage, membership, settle } from './helpers/fakes';

const BASE = 'https://api.example.test';
const ACCOUNTS = {
  'a@example.test': { password: 'pw-a', providerUserId: 'user-a' },
  'b@example.test': { password: 'pw-b', providerUserId: 'user-b' },
};

function world(over: { storage?: MemoryStorage } = {}) {
  const backend = new FakeBackend();
  for (const a of Object.values(ACCOUNTS)) backend.users.set(a.providerUserId, { id: crypto.randomUUID(), email: `${a.providerUserId}@example.test` });
  const provider = new FakeProvider(backend, ACCOUNTS);
  const storage = over.storage ?? new MemoryStorage();
  const warn = vi.fn();
  const controller = new AuthController({ apiBaseUrl: BASE, provider, storage, fetchImpl: backend.fetch, warn, logoutTimeoutMs: 30 });
  const states: string[] = [];
  controller.subscribe(() => states.push(controller.getState().status));
  return { backend, provider, storage, controller, warn, states };
}
const ready = (c: AuthController) => c.getState() as Extract<AuthState, { status: 'ready' }>;
const waitFor = async (c: AuthController, status: AuthState['status']) => { for (let i = 0; i < 100 && c.getState().status !== status; i++) await settle(5); expect(c.getState().status).toBe(status); };

describe('sign-in flow: provider -> server-verified exchange -> own workspaces -> selected claim', () => {
  it('starts signed out and makes no request when nobody is signed in', async () => {
    const { controller, backend } = world();
    await controller.start();
    expect(controller.getState()).toEqual({ status: 'signed-out' });
    expect(backend.requests).toHaveLength(0);
  });

  it('sign-in exchanges the provider token, loads the caller\'s workspaces with the BACKEND token and selects the only one', async () => {
    const { controller, backend, provider } = world();
    await controller.start();
    backend.setMemberships('user-a', [membership('Acme')]);
    expect(await controller.signIn('a@example.test', 'pw-a')).toEqual({ ok: true });
    await waitFor(controller, 'ready');
    const s = ready(controller);
    expect(s.email).toBe('user-a@example.test');
    expect(s.scope).toEqual({ tenantId: s.memberships[0].tenantId, workspaceId: s.memberships[0].workspaceId });
    const [exchange, list] = backend.requests;
    expect(exchange).toMatchObject({ method: 'POST', path: '/v1/auth/identity-exchange' });
    expect(Object.keys(exchange.body as object)).toEqual(['accessToken']);                    // nothing but the provider token is sent
    expect(list.path).toBe('/v1/auth/memberships');
    expect(list.headers.authorization).toMatch(/^Bearer raw-/);                                 // a backend token, not the provider token
    expect(list.headers.authorization).not.toContain('provider-');
    expect(list.headers['x-tenant-id']).toBeUndefined();                                        // discovery sends no claimed identity
    expect(provider.log).toContain('provider.signIn:user-a');
  });

  it('a wrong password never reaches the backend', async () => {
    const { controller, backend } = world();
    await controller.start();
    expect(await controller.signIn('a@example.test', 'nope')).toMatchObject({ ok: false });
    expect(backend.requests).toHaveLength(0);
    expect(controller.getState().status).toBe('signed-out');
  });

  it('several workspaces: none is selected until the user chooses; an unlisted workspace cannot be selected; the choice is remembered only if still listed', async () => {
    const storage = new MemoryStorage();
    const w = world({ storage });
    const m1 = membership('One'); const m2 = membership('Two');
    w.backend.setMemberships('user-a', [m1, m2]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    expect(ready(w.controller).scope).toBeNull();
    expect(w.controller.selectWorkspace({ tenantId: crypto.randomUUID(), workspaceId: crypto.randomUUID() })).toBe(false);
    expect(ready(w.controller).scope).toBeNull();
    expect(w.controller.selectWorkspace({ tenantId: m2.tenantId, workspaceId: m2.workspaceId })).toBe(true);
    expect(ready(w.controller).scope?.workspaceId).toBe(m2.workspaceId);
    expect(storage.getItem(SCOPE_STORAGE_KEY)).toContain(m2.workspaceId);

    // a new tab session restores the choice while it is still a listed workspace ...
    const again = new AuthController({ apiBaseUrl: BASE, provider: w.provider, storage, fetchImpl: w.backend.fetch, logoutTimeoutMs: 30 });
    await again.start();
    await waitFor(again, 'ready');
    expect((again.getState() as Extract<AuthState, { status: 'ready' }>).scope?.workspaceId).toBe(m2.workspaceId);
    // ... and drops it when the server no longer lists it
    w.backend.setMemberships('user-a', [m1, membership('Three')]);
    const third = new AuthController({ apiBaseUrl: BASE, provider: w.provider, storage, fetchImpl: w.backend.fetch, logoutTimeoutMs: 30 });
    await third.start();
    await waitFor(third, 'ready');
    expect((third.getState() as Extract<AuthState, { status: 'ready' }>).scope).toBeNull();
  });

  it('sign-out revokes the backend session BEFORE the provider signs out, then clears everything locally', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    w.backend.events.length = 0;
    await w.controller.signOut();
    expect(w.backend.events).toEqual(['backend.logout', 'provider.signOut']);
    expect(w.controller.getState()).toEqual({ status: 'signed-out' });
    expect(w.storage.getItem(SCOPE_STORAGE_KEY)).toBeNull();
    expect(w.backend.liveSessionsFor('user-a')).toBe(0);
    expect(w.controller.lastRevocation?.ok).toBe(true);
  });

  it('sign-out still signs the user out locally when the server cannot revoke, and says the revocation was not confirmed', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    w.backend.logoutStatus = 500;
    w.provider.signOutThrows = true;                                 // even a failing provider sign-out does not keep the user signed in
    await w.controller.signOut();
    expect(w.controller.getState()).toEqual({ status: 'signed-out' });
    expect(w.controller.lastRevocation).toMatchObject({ ok: false, reason: 'server-error' });
    expect(w.warn).toHaveBeenCalledTimes(1);
  });

  it('switching to a different user ends the previous user\'s backend session and carries nothing over', async () => {
    const w = world();
    const mA = membership('A-Co'); const mB = membership('B-Co');
    w.backend.setMemberships('user-a', [mA]); w.backend.setMemberships('user-b', [mB]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    expect(w.backend.liveSessionsFor('user-a')).toBe(1);
    await w.controller.signIn('b@example.test', 'pw-b');             // the provider replaces the session; no sign-out in between
    for (let i = 0; i < 100 && !(w.controller.getState().status === 'ready' && ready(w.controller).email === 'user-b@example.test'); i++) await settle(5);
    expect(ready(w.controller).email).toBe('user-b@example.test');
    expect(ready(w.controller).memberships.map((m) => m.tenantName)).toEqual(['B-Co Co']);
    expect(w.backend.liveSessionsFor('user-a')).toBe(0);              // revoked
    expect(w.backend.liveSessionsFor('user-b')).toBe(1);
    expect(w.storage.getItem(SCOPE_STORAGE_KEY)).toContain(mB.workspaceId);
    expect(w.storage.getItem(SCOPE_STORAGE_KEY)).not.toContain(mA.workspaceId);
  });

  it('when the provider ends the session by itself (expiry, other tab) the backend session is revoked and the app is signed out', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    w.provider.expireExternally();
    await waitFor(w.controller, 'signed-out');
    expect(w.backend.liveSessionsFor('user-a')).toBe(0);
  });

  it('a provider token refresh for the same user does not create another backend session', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    w.provider.refreshToken();
    await settle(30);
    expect(w.backend.exchangeCount).toBe(1);
    expect(w.controller.getState().status).toBe('ready');
  });

  it('a sign-out during the exchange leaves no usable session behind', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    w.backend.exchangeDelayMs = 40;
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await settle(10);
    await w.controller.signOut();
    await settle(80);
    expect(w.controller.getState()).toEqual({ status: 'signed-out' });
    expect(w.backend.sessions.size).toBe(0);
  });

  it('a 401 mid-session is healed once by re-exchanging; when that is impossible the user is signed out with a notice', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'ready');
    w.backend.sessions.clear();                                      // the server dropped the session (e.g. revoked elsewhere)
    await expect(w.controller.api.get('/v1/auth/session')).resolves.toBeTruthy();
    expect(w.backend.exchangeCount).toBe(2);                         // exactly one re-exchange

    w.backend.sessions.clear();
    w.backend.exchangeStatus = 401;                                  // and the identity exchange no longer accepts the provider token
    await expect(w.controller.api.get('/v1/auth/session')).rejects.toMatchObject({ name: 'SessionExpiredError' });
    expect(w.controller.getState()).toEqual({ status: 'signed-out', notice: 'Your session has ended. Please sign in again.' });
  });

  it('an unavailable sign-in service shows a retryable error, and retry recovers', async () => {
    const w = world();
    w.backend.setMemberships('user-a', [membership('Acme')]);
    w.backend.exchangeStatus = 503;
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'error');
    expect((w.controller.getState() as { message: string }).message).toMatch(/temporarily unavailable/);
    w.backend.exchangeStatus = 200;
    await w.controller.retry();
    await waitFor(w.controller, 'ready');
  });

  it('a refused exchange asks the user to sign in again; it does not echo server detail', async () => {
    const w = world();
    w.backend.exchangeStatus = 401;
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'error');
    expect((w.controller.getState() as { message: string }).message).toBe('Your sign-in was not accepted. Please sign out and sign in again.');
  });

  it('a malformed workspace list is an error, not a guess', async () => {
    const w = world();
    w.backend.membershipsBody = { memberships: [{ tenantId: 'not-a-uuid' }] };
    await w.controller.start();
    await w.controller.signIn('a@example.test', 'pw-a');
    await waitFor(w.controller, 'error');
  });
});
