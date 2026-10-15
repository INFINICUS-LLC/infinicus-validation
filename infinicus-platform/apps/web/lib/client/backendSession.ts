/**
 * Backend session custody for the web client (NA-04, owner decision: IN MEMORY ONLY).
 *
 * The session token returned by POST /v1/auth/identity-exchange lives in a private field of this object and nowhere else: it is never written to
 * any browser storage, cookie, URL or log. A page reload therefore loses it and a new exchange (from the identity provider's own session) creates a
 * new backend session; that trade-off (more 24-hour server sessions, finding F7) is accepted in exchange for no script-readable copy (improves on F1).
 *
 * Sign-out and user switching revoke the server session BEFORE the identity provider signs out (it needs the token), never throw, never report a
 * failed revocation as a success, and a sign-out or switch that happens while an exchange is in flight discards that exchange's result and revokes it.
 */
import { z } from 'zod';

export interface RevocationOutcome {
  ok: boolean;
  /** Why it is not confirmed: no token held, server refused (401), server error, network failure, or timeout. */
  reason?: 'no-token' | 'rejected' | 'server-error' | 'network' | 'timeout';
  at: number;
}

export class NoProviderSessionError extends Error { constructor() { super('There is no signed-in identity-provider session.'); this.name = 'NoProviderSessionError'; } }
export class ExchangeFailedError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ExchangeFailedError'; }
}
/** An exchange finished after a sign-out or user switch; its session was revoked and must not be used. */
export class StaleExchangeError extends Error { constructor() { super('The sign-in was superseded.'); this.name = 'StaleExchangeError'; } }

const exchangeResponseSchema = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), status: z.string() }),
  sessionId: z.string().uuid(),
  rawSessionToken: z.string().min(16),
});

export interface BackendSessionManagerOptions {
  baseUrl: string;
  /** The identity provider's current access token, or null when nobody is signed in there. Read from memory; must not call the provider. */
  getProviderToken: () => string | null;
  fetchImpl?: typeof fetch;
  logoutTimeoutMs?: number;
  exchangeTimeoutMs?: number;
  /** Receives short messages that never contain a token. */
  warn?: (message: string) => void;
}

export interface BackendIdentity { userId: string; email: string }

export class BackendSessionManager {
  private token: string | null = null;
  private identity: BackendIdentity | null = null;
  private epoch = 0;
  private inFlight: Promise<string> | null = null;
  lastRevocation: RevocationOutcome | null = null;

  private readonly doFetch: typeof fetch;
  private readonly logoutTimeoutMs: number;
  private readonly exchangeTimeoutMs: number;

  constructor(private readonly options: BackendSessionManagerOptions) {
    this.doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.logoutTimeoutMs = options.logoutTimeoutMs ?? 4000;
    this.exchangeTimeoutMs = options.exchangeTimeoutMs ?? 15_000;
  }

  /** Who the held backend session belongs to (never the token). */
  get current(): BackendIdentity | null { return this.identity; }

  /** The held token, exchanging one first when there is none. Concurrent callers share one exchange. */
  async ensure(): Promise<string> {
    if (this.token) return this.token;
    if (!this.inFlight) {
      const attempt = this.exchange().finally(() => { if (this.inFlight === attempt) this.inFlight = null; });
      this.inFlight = attempt;
    }
    return this.inFlight;
  }

  /** After the API answered 401: the held token is dead server-side, so drop it (nothing to revoke) and obtain a new one; null if impossible. */
  async refresh(): Promise<string | null> {
    this.token = null;
    this.identity = null;
    try { return await this.ensure(); } catch { return null; }
  }

  /** Forget the session and revoke it on the server. Never throws. Bumps the epoch so any exchange in flight is discarded. */
  async clear(): Promise<RevocationOutcome> {
    this.epoch += 1;
    this.inFlight = null;
    const token = this.token;
    this.token = null;
    this.identity = null;
    const outcome = await this.revoke(token);
    if (outcome.reason !== 'no-token') this.lastRevocation = outcome;     // a clear() with nothing to revoke must not erase the real outcome
    if (!outcome.ok && outcome.reason !== 'no-token') {
      this.options.warn?.(`Backend session revocation was not confirmed (${outcome.reason}); it stays valid on the server until it expires.`);
    }
    return outcome;
  }

  private async exchange(): Promise<string> {
    const epoch = this.epoch;
    const providerToken = this.options.getProviderToken();
    if (!providerToken) throw new NoProviderSessionError();
    const res = await this.timed('/v1/auth/identity-exchange', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ accessToken: providerToken }) }, this.exchangeTimeoutMs)
      .catch(() => { throw new ExchangeFailedError(0, 'The sign-in service could not be reached.'); });
    if (!res.ok) throw new ExchangeFailedError(res.status, res.status === 503 ? 'The sign-in service is temporarily unavailable.' : 'The sign-in was not accepted.');
    let raw: unknown;
    try { raw = await res.json(); } catch { throw new ExchangeFailedError(res.status, 'The sign-in service answered in an unexpected format.'); }
    const parsed = exchangeResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ExchangeFailedError(res.status, 'The sign-in service answered in an unexpected format.');
    const { rawSessionToken, user } = parsed.data;
    if (epoch !== this.epoch) {                       // signed out or switched user while waiting: this session must not be used
      await this.revoke(rawSessionToken);
      throw new StaleExchangeError();
    }
    this.token = rawSessionToken;
    this.identity = { userId: user.id, email: user.email };
    return rawSessionToken;
  }

  private async revoke(token: string | null): Promise<RevocationOutcome> {
    const at = Date.now();
    if (!token) return { ok: false, reason: 'no-token', at };
    try {
      const res = await this.timed('/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, this.logoutTimeoutMs);
      if (res.status === 204) return { ok: true, at };
      return { ok: false, reason: res.status === 401 ? 'rejected' : 'server-error', at };
    } catch (error) {
      return { ok: false, reason: (error as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network', at };
    }
  }

  private async timed(path: string, init: RequestInit, ms: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await this.doFetch(`${this.options.baseUrl}${path}`, { ...init, signal: controller.signal, credentials: 'omit' });
    } finally {
      clearTimeout(timer);
    }
  }
}
