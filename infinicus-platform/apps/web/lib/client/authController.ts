/**
 * Framework-free sign-in state machine (NA-04, Option B): identity provider session -> backend session (server-verified exchange) -> the user's own
 * workspaces -> a selected workspace claim. The React layer is a thin adapter over this class so the whole flow is testable without a browser.
 *
 * Authority stays on the server: this object holds no identity of its own, only what the API returned, and the workspace selection it sends later is a
 * claim the API re-verifies on every request.
 */
import { createApiClient, SessionExpiredError, type ApiClient, type Scope } from './apiClient';
import { BackendSessionManager, ExchangeFailedError, NoProviderSessionError, StaleExchangeError } from './backendSession';
import { fetchMemberships, forgetScope, loadSavedScope, pickInitialScope, sameScope, saveScope, scopeOf, type Membership, type TabStorage } from './workspaces';

export interface ProviderSession { userId: string; email: string; accessToken: string }

/** The identity provider as the controller needs it (implemented over supabase-js in supabaseProvider.ts, by a fake in tests). */
export interface IdentityProviderPort {
  signInWithPassword(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }>;
  signOut(): Promise<void>;
  getSession(): Promise<ProviderSession | null>;
  /** Subscribe to provider session changes; the callback must only be used for in-memory bookkeeping. Returns an unsubscribe function. */
  onChange(listener: (session: ProviderSession | null) => void): () => void;
}

export type AuthState =
  | { status: 'unconfigured'; missing: string[]; invalid: string[] }
  | { status: 'loading' }
  | { status: 'signed-out'; notice?: string }
  | { status: 'exchanging' }
  | { status: 'ready'; email: string; memberships: Membership[]; scope: Scope | null }
  | { status: 'error'; message: string };

export interface AuthControllerOptions {
  apiBaseUrl: string;
  provider: IdentityProviderPort;
  storage?: TabStorage | null;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
  logoutTimeoutMs?: number;
}

export class AuthController {
  private state: AuthState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private readonly manager: BackendSessionManager;
  private readonly rawApi: ApiClient;
  readonly api: ApiClient;
  private providerSession: ProviderSession | null = null;
  private syncedProviderUserId: string | null = null;
  private run = 0;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  /** Why the user was signed out involuntarily; kept so the provider's own sign-out event cannot overwrite it. */
  private notice: string | undefined;

  constructor(private readonly options: AuthControllerOptions) {
    this.manager = new BackendSessionManager({
      baseUrl: options.apiBaseUrl,
      getProviderToken: () => this.providerSession?.accessToken ?? null,
      fetchImpl: options.fetchImpl,
      logoutTimeoutMs: options.logoutTimeoutMs,
      warn: options.warn,
    });
    this.rawApi = createApiClient({
      baseUrl: options.apiBaseUrl,
      getToken: () => this.manager.ensure(),
      refreshToken: () => this.manager.refresh(),
      fetchImpl: options.fetchImpl,
    });
    this.api = {
      get: (path, init) => this.guard(this.rawApi.get(path, init)),
      post: (path, init) => this.guard(this.rawApi.post(path, init)),
    };
  }

  getState = (): AuthState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** For diagnostics and tests: whether the last server-side revocation was confirmed. Never contains a token. */
  get lastRevocation() { return this.manager.lastRevocation; }

  private set(next: AuthState): void { this.state = next; for (const l of this.listeners) l(); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.options.provider.onChange((session) => {
      this.providerSession = session;
      void this.sync();
    });
    this.providerSession = await this.options.provider.getSession();
    await this.sync();
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = null; this.started = false; this.run += 1; }

  retry(): Promise<void> { return this.sync(); }

  async signIn(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
    this.notice = undefined;
    return this.options.provider.signInWithPassword(email, password);   // the provider's change event drives the exchange
  }

  /** Revoke the backend session first (it needs the token), then end the provider session. Local state is cleared whatever the server answers. */
  async signOut(): Promise<void> {
    this.run += 1;
    await this.manager.clear();
    this.syncedProviderUserId = null;
    forgetScope(this.options.storage ?? null);
    try { await this.options.provider.signOut(); } catch { /* the provider session may already be gone */ }
    this.providerSession = null;
    this.notice = undefined;
    this.set({ status: 'signed-out' });
  }

  selectWorkspace(scope: Scope): boolean {
    if (this.state.status !== 'ready') return false;
    const listed = this.state.memberships.find((m) => sameScope(scopeOf(m), scope));
    if (!listed) return false;
    saveScope(this.options.storage ?? null, scope);
    this.set({ ...this.state, scope: scopeOf(listed) });
    return true;
  }

  private async sync(): Promise<void> {
    const run = ++this.run;
    const session = this.providerSession;
    if (!session) {
      this.syncedProviderUserId = null;
      await this.manager.clear();
      if (run === this.run) this.set(this.signedOut());
      return;
    }
    if (this.syncedProviderUserId && this.syncedProviderUserId !== session.userId) {   // a different user became active: end the previous user's backend session
      await this.manager.clear();
      forgetScope(this.options.storage ?? null);
      if (run !== this.run) return;
    }
    this.syncedProviderUserId = session.userId;
    if (this.state.status === 'ready' && this.manager.current) return;                  // e.g. provider token refreshed: nothing to redo
    this.set({ status: 'exchanging' });
    try {
      await this.manager.ensure();
      const memberships = await fetchMemberships(this.api);
      if (run !== this.run) return;
      const scope = pickInitialScope(memberships, loadSavedScope(this.options.storage ?? null));
      if (scope) saveScope(this.options.storage ?? null, scope);
      this.set({ status: 'ready', email: this.manager.current?.email ?? session.email, memberships, scope });
    } catch (error) {
      if (run !== this.run || error instanceof StaleExchangeError || error instanceof SessionExpiredError) return;
      this.set({ status: 'error', message: describe(error) });
    }
  }

  private signedOut(): AuthState { return this.notice ? { status: 'signed-out', notice: this.notice } : { status: 'signed-out' }; }

  private async guard<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof SessionExpiredError) await this.expire();
      throw error;
    }
  }

  /** The API no longer accepts the session and a new one could not be obtained. */
  private async expire(): Promise<void> {
    this.run += 1;
    this.notice = 'Your session has ended. Please sign in again.';
    await this.manager.clear();
    this.syncedProviderUserId = null;
    try { await this.options.provider.signOut(); } catch { /* ignore */ }
    this.providerSession = null;
    this.set(this.signedOut());
  }
}

function describe(error: unknown): string {
  if (error instanceof ExchangeFailedError) {
    return error.status === 0 || error.status === 503 ? 'The sign-in service is temporarily unavailable. Please try again.' : 'Your sign-in was not accepted. Please sign out and sign in again.';
  }
  if (error instanceof NoProviderSessionError) return 'Please sign in.';
  return 'Something went wrong while loading your workspaces. Please try again.';
}
