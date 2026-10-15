/**
 * Test doubles for the browser-side client: an in-memory stand-in for the INFINICUS /v1 API (the contract the real routes are tested against in
 * apps/api: identity-exchange, logout, session, memberships) and an identity-provider port. Nothing here talks to a network.
 */
import { randomUUID } from 'node:crypto';
import type { IdentityProviderPort, ProviderSession } from '../../lib/client/authController';
import type { Membership, TabStorage } from '../../lib/client/workspaces';

export interface LoggedRequest { method: string; path: string; headers: Record<string, string>; body: unknown }

export class FakeBackend {
  readonly requests: LoggedRequest[] = [];
  /** Ordered record of server-side logouts and provider sign-outs, to assert which happens first. */
  readonly events: string[] = [];
  /** raw session token -> backend user id (a session is VALID while it is in this map) */
  readonly sessions = new Map<string, string>();
  /** provider access token -> provider user id */
  readonly providerTokens = new Map<string, string>();
  /** backend users by provider user id */
  readonly users = new Map<string, { id: string; email: string }>();
  readonly memberships = new Map<string, Membership[]>();     // by backend user id
  exchangeStatus = 200;
  logoutStatus: number | 'network' | 'hang' = 204;
  membershipsBody: unknown = null;                             // override with a malformed body
  exchangeDelayMs = 0;
  exchangeCount = 0;

  registerProviderToken(token: string, providerUserId: string, email = `${providerUserId}@example.test`) {
    this.providerTokens.set(token, providerUserId);
    if (!this.users.has(providerUserId)) this.users.set(providerUserId, { id: randomUUID(), email });
  }
  backendUserFor(providerUserId: string) { return this.users.get(providerUserId)!; }
  setMemberships(providerUserId: string, list: Membership[]) { this.memberships.set(this.backendUserFor(providerUserId).id, list); }
  liveSessionsFor(providerUserId: string) { return [...this.sessions.values()].filter((u) => u === this.backendUserFor(providerUserId).id).length; }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : null;
    const userId = bearer ? this.sessions.get(bearer) : undefined;
    const unauth = () => json(401, { error: { code: 'SessionInvalidError', message: 'Invalid session', correlationId: 'c-1' } });

    if (url.pathname === '/v1/auth/identity-exchange') {
      this.exchangeCount += 1;
      if (this.exchangeDelayMs) await new Promise((r) => setTimeout(r, this.exchangeDelayMs));
      if (this.exchangeStatus !== 200) return json(this.exchangeStatus, { error: { code: 'X', message: 'no', correlationId: 'c-2' } });
      const providerUserId = this.providerTokens.get(body?.accessToken);
      if (!providerUserId) return json(401, { error: { code: 'IdentityTokenInvalidError', message: 'bad token', correlationId: 'c-3' } });
      const user = this.backendUserFor(providerUserId);
      const raw = `raw-${randomUUID()}-${randomUUID()}`;
      this.sessions.set(raw, user.id);
      return json(200, { user: { ...user, status: 'active' }, sessionId: randomUUID(), rawSessionToken: raw });
    }
    if (url.pathname === '/v1/auth/logout') {
      if (this.logoutStatus === 'network') throw new TypeError('network down');
      if (this.logoutStatus === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (!userId) return unauth();
      this.events.push('backend.logout');
      if (this.logoutStatus === 204) { this.sessions.delete(bearer!); return new Response(null, { status: 204 }); }
      return json(this.logoutStatus, { error: { code: 'E', message: 'x', correlationId: 'c-4' } });
    }
    if (url.pathname === '/v1/auth/session') {
      if (!userId) return unauth();
      const user = [...this.users.values()].find((u) => u.id === userId)!;
      return json(200, { user: { ...user, status: 'active' }, sessionId: randomUUID() });
    }
    if (url.pathname === '/v1/auth/memberships') {
      if (!userId) return unauth();
      if (this.membershipsBody !== null) return json(200, this.membershipsBody);
      return json(200, { memberships: this.memberships.get(userId) ?? [] });
    }
    return json(404, { error: { code: 'NotFound', message: 'nope', correlationId: 'c-5' } });
  };
}

export class FakeProvider implements IdentityProviderPort {
  readonly log: string[] = [];
  private session: ProviderSession | null = null;
  private listeners = new Set<(s: ProviderSession | null) => void>();
  signOutThrows = false;
  constructor(private readonly backend: FakeBackend, private readonly accounts: Record<string, { password: string; providerUserId: string }>) {}

  private setSession(next: ProviderSession | null) { this.session = next; for (const l of this.listeners) l(next); }
  async signInWithPassword(email: string, password: string) {
    const account = this.accounts[email];
    if (!account || account.password !== password) return { ok: false as const, message: 'The email or password is incorrect.' };
    const token = `provider-${randomUUID()}`;
    this.backend.registerProviderToken(token, account.providerUserId, email);
    this.log.push(`provider.signIn:${account.providerUserId}`);
    this.setSession({ userId: account.providerUserId, email, accessToken: token });
    return { ok: true as const };
  }
  async signOut() { this.log.push('provider.signOut'); this.backend.events.push('provider.signOut'); if (this.signOutThrows) throw new Error('already gone'); this.setSession(null); }
  async getSession() { return this.session; }
  onChange(listener: (s: ProviderSession | null) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Simulate the provider ending the session by itself (expiry, other tab). */
  expireExternally() { this.setSession(null); }
  /** Simulate a token refresh by the provider for the same user. */
  refreshToken() {
    if (!this.session) return;
    const token = `provider-${randomUUID()}`;
    this.backend.registerProviderToken(token, this.session.userId, this.session.email);
    this.setSession({ ...this.session, accessToken: token });
  }
}

export class MemoryStorage implements TabStorage {
  readonly data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

export const membership = (n: string, tenantId = randomUUID(), workspaceId = randomUUID()): Membership =>
  ({ tenantId, tenantName: `${n} Co`, tenantStatus: 'active', workspaceId, workspaceName: `${n} workspace`, workspaceStatus: 'active' });

export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
