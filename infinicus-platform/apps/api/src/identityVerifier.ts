/**
 * J-3 identity verification port for POST /v1/auth/identity-exchange.
 *
 * The API never trusts a browser-supplied identifier. It forwards the browser's identity-provider access token to the
 * provider itself and uses ONLY the provider's answer (user id + confirmed email) to pick the managed account.
 * With no provider configured the verifier is closed: every exchange answers 503.
 */

export interface VerifiedIdentity {
  /** The provider's immutable user id (a UUID). */
  providerUserId: string;
}

export interface IdentityVerifier {
  /** Resolves the identity behind `accessToken`, or throws IdentityTokenInvalidError / IdentityProviderUnavailableError / IdentityExchangeNotConfiguredError. */
  verify(accessToken: string): Promise<VerifiedIdentity>;
}

export class IdentityTokenInvalidError extends Error {
  constructor() {
    super('The identity token is invalid, expired or unverified');
    this.name = 'IdentityTokenInvalidError';
  }
}

export class IdentityProviderUnavailableError extends Error {
  constructor() {
    super('The identity provider could not be reached; try again shortly');
    this.name = 'IdentityProviderUnavailableError';
  }
}

export class IdentityExchangeNotConfiguredError extends Error {
  constructor() {
    super('Identity exchange is not configured on this server');
    this.name = 'IdentityExchangeNotConfiguredError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_TIMEOUT_MS = 5_000;

export class UnconfiguredIdentityVerifier implements IdentityVerifier {
  async verify(): Promise<VerifiedIdentity> {
    throw new IdentityExchangeNotConfiguredError();
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class SupabaseIdentityVerifier implements IdentityVerifier {
  private readonly userUrl: string;

  constructor(supabaseUrl: string, private readonly anonKey: string, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    const base = new URL(supabaseUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopbackHost(base.hostname))) {
      throw new Error('SUPABASE_URL must be https (http is allowed for loopback only)');
    }
    this.userUrl = `${base.origin}/auth/v1/user`;
  }

  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetchImpl(this.userUrl, {
        method: 'GET',
        headers: { apikey: this.anonKey, Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } catch {
      throw new IdentityProviderUnavailableError();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new IdentityTokenInvalidError();
    if (!res.ok) throw new IdentityProviderUnavailableError();
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new IdentityProviderUnavailableError();
    }
    const user = (body ?? {}) as { id?: unknown; email_confirmed_at?: unknown };
    if (typeof user.id !== 'string' || !UUID_RE.test(user.id)) throw new IdentityTokenInvalidError();
    // Same rule the page enforces before it treats a Supabase user as signed in: an unconfirmed email is no identity.
    if (typeof user.email_confirmed_at !== 'string' || user.email_confirmed_at.length === 0) throw new IdentityTokenInvalidError();
    return { providerUserId: user.id.toLowerCase() };
  }
}

/** Reads SUPABASE_URL / SUPABASE_ANON_KEY (both public values). Either unset => closed verifier. */
export function resolveIdentityVerifier(env: NodeJS.ProcessEnv = process.env): IdentityVerifier {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return new UnconfiguredIdentityVerifier();
  return new SupabaseIdentityVerifier(url, key);
}

