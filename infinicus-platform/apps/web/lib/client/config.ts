/**
 * Browser-side configuration for the /v1 API client (NA-04, Option B). Everything here is PUBLIC by design: the Supabase project URL, the Supabase
 * anon/publishable key and the API origin. Nothing secret is read or accepted: a service/secret key is refused outright, and no value is committed.
 * Unset or invalid values make the app report "not configured" and stop; there is no development fallback.
 */
export type WebConfig =
  | { ok: true; supabaseUrl: string; supabaseAnonKey: string; apiBaseUrl: string }
  | { ok: false; missing: string[]; invalid: string[] };

export interface RawWebConfig { supabaseUrl?: string; supabaseAnonKey?: string; apiBaseUrl?: string }

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** An https origin (http only for loopback), with no credentials in it; anything else is refused. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    const secure = url.protocol === 'https:';
    const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname);
    return secure || loopbackHttp ? url.origin : null;
  } catch {
    return null;
  }
}

/** True for a Supabase secret key (`sb_secret_...`) or a JWT whose role claim is `service_role`: these must never reach a browser. */
export function looksLikeSecretKey(key: string): boolean {
  const k = key.trim();
  if (k.startsWith('sb_secret_')) return true;
  const parts = k.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export function readWebConfig(raw: RawWebConfig): WebConfig {
  const missing: string[] = [];
  const invalid: string[] = [];
  const supabaseUrl = raw.supabaseUrl?.trim() ? originOf(raw.supabaseUrl) : null;
  const apiBaseUrl = raw.apiBaseUrl?.trim() ? originOf(raw.apiBaseUrl) : null;
  const anonKey = raw.supabaseAnonKey?.trim() ?? '';

  if (!raw.supabaseUrl?.trim()) missing.push('NEXT_PUBLIC_SUPABASE_URL'); else if (!supabaseUrl) invalid.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY'); else if (looksLikeSecretKey(anonKey)) invalid.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!raw.apiBaseUrl?.trim()) missing.push('NEXT_PUBLIC_API_BASE_URL'); else if (!apiBaseUrl) invalid.push('NEXT_PUBLIC_API_BASE_URL');

  if (missing.length || invalid.length || !supabaseUrl || !apiBaseUrl) return { ok: false, missing, invalid };
  return { ok: true, supabaseUrl, supabaseAnonKey: anonKey, apiBaseUrl };
}

/** Next.js inlines NEXT_PUBLIC_* only when each name is written literally, so they are read here and nowhere else. */
export function getWebConfig(): WebConfig {
  return readWebConfig({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  });
}
