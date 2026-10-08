// functions/_shared/route.js — legacy Pages Functions route gate (PR-C)
//
// Composes the PR-B primitives (guard.js, escape.js) into ONE ordered, fail-closed gate so every hardened route
// applies the same checks in the same order and no route re-implements them:
//
//   configuration → preflight → method → origin (browser routes) | bearer (server routes) → abuse limits → body → fields
//
// What this is NOT: authentication of people. A browser route is protected against cross-site misuse (exact Origin)
// and abuse (best-effort limits); neither Origin, nor rate limits, nor (later) Turnstile identifies or authorises a user.
// Server routes authenticate with a bearer secret. Nothing here models users, tenants or sessions, and it never touches
// Stack B, D1 or the legacy KV user store (the only storage it uses is a rate-limit counter namespace, hashed keys, TTL'd).
//
// Not a route: exports no onRequest* handler.
import {
  createRateLimiter, corsHeaders, errorResponse, getClientIp, handlePreflight, kvBackend, logSecurityEvent, parseAllowedOrigins,
  readJsonBody, requireAllowedOrigin, validateFields, validateGuardConfig, verifyBearer,
} from './guard.js';

export const ALLOWED_ORIGINS_VAR = 'ALLOWED_ORIGINS';
/** KV namespace used ONLY for hashed, expiring abuse counters (never identity, never a security boundary). */
export const RATE_LIMIT_STORE_VAR = 'INFINICUS_WAITLIST';

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

/** Positive integer from an environment string, bounded; anything else falls back to the code default. */
export function intEnv(env, name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const raw = env?.[name];
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}

/**
 * Default-deny for legacy compatibility route families. Returns a 404 Response unless the named flag is exactly "enabled".
 * The route code and its contract stay in the repository for a future, separately authorised compatibility review.
 */
export function legacyRouteGate(context, { flag, route }) {
  if (context?.env?.[flag] === 'enabled') return null;
  logSecurityEvent({ event: 'legacy_route_disabled', route, code: 'disabled', status: 404 });
  return errorResponse('not_found');
}

/**
 * Runs the ordered gate for one request.
 * spec = {
 *   route,                         // log token, e.g. '/api/waitlist'
 *   methods: ['POST'],             // allowed methods (OPTIONS is handled as preflight for browser routes)
 *   bearer?: 'SECRET_NAME',        // server route: require this bearer secret (no Origin policy, no CORS)
 *   secrets?: [{ name, minLength }]// additional configuration the route needs before it may run
 *   limits?: [{ name, scope: 'ip' | 'global', limit, windowMs }]   // abuse-smoothing only, checked in order
 *   body?: { maxBytes, schema? }   // JSON body (omit for routes that read their own body)
 * }
 * Returns { ok: false, response } or { ok: true, origin, ip, cors, headers, value, respond }.
 */
export async function gate(context, spec) {
  const { request, env } = context;
  const deny = (code, extra = {}, logCode = code) => {
    const response = errorResponse(code, extra);
    logSecurityEvent({ event: 'request_denied', route: spec.route, code: logCode, status: response.status });
    return { ok: false, response };
  };

  const browser = spec.bearer === undefined;
  const limits = spec.limits ?? [];
  const secrets = [...(spec.bearer ? [{ name: spec.bearer, minLength: 32 }] : []), ...(spec.secrets ?? [])];
  const config = validateGuardConfig(env, { secrets, ...(browser ? { origins: { name: ALLOWED_ORIGINS_VAR } } : {}) });
  if (!config.ok) return deny('unconfigured', {}, `unconfigured:${config.problems[0].name.toLowerCase()}`.slice(0, 64));
  const store = env?.[RATE_LIMIT_STORE_VAR];
  if (limits.length > 0 && (!store || typeof store.get !== 'function' || typeof store.put !== 'function')) {
    return deny('unconfigured', {}, `unconfigured:${RATE_LIMIT_STORE_VAR.toLowerCase()}`);
  }

  const origins = browser ? parseAllowedOrigins(env[ALLOWED_ORIGINS_VAR]) : [];

  if (request.method === 'OPTIONS') {
    if (!browser) return deny('method_not_allowed');
    const response = handlePreflight(request, origins, { methods: spec.methods, allowHeaders: ['Content-Type'] });
    return { ok: false, response };
  }
  if (!spec.methods.includes(request.method)) return deny('method_not_allowed', { headers: { Allow: spec.methods.join(', ') } });

  let origin = null;
  if (browser) {
    const checked = requireAllowedOrigin(request, origins);
    if (!checked.ok) return deny(checked.code);
    origin = checked.origin;
  } else {
    const checked = await verifyBearer(request, env, spec.bearer);
    if (!checked.ok) return deny(checked.code);
  }
  const cors = origin ? corsHeaders(origin) : {};

  const ip = getClientIp(request);
  if (limits.length > 0) {
    const backend = kvBackend(store);
    for (const l of limits) {
      const limiter = createRateLimiter({ name: l.name, limit: l.limit, windowMs: l.windowMs, backend, purpose: 'abuse-smoothing', failure: 'closed' });
      const verdict = await limiter.check(l.scope === 'global' ? 'global' : ip);
      if (!verdict.allowed) {
        return verdict.degraded
          ? deny('unconfigured', { headers: cors }, 'rate_limit_unavailable')
          : deny('rate_limited', { headers: cors, retryAfterSec: verdict.retryAfterSec }, 'rate_limited');
      }
    }
  }

  let value = {};
  if (spec.body) {
    const parsed = await readJsonBody(request, { maxBytes: spec.body.maxBytes });
    if (!parsed.ok) return deny(parsed.code, { headers: cors });
    if (spec.body.schema) {
      const checked = validateFields(parsed.value, spec.body.schema, spec.body.options);
      if (!checked.ok) return deny('invalid_request', { headers: cors }, 'invalid_fields');
      value = checked.value;
    } else value = parsed.value;
  }

  const headers = { ...JSON_HEADERS, ...cors };
  const respond = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
  return { ok: true, origin, ip, cors, headers, value, respond };
}

/**
 * Per-key abuse counter outside the main gate (e.g. per-recipient email quota). Same rules as gate(): hashed key,
 * best-effort KV counter, fail closed. Returns { allowed, degraded, retryAfterSec }.
 */
export async function checkLimit(env, { name, key, limit, windowMs }) {
  const store = env?.[RATE_LIMIT_STORE_VAR];
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') return { allowed: false, degraded: true, retryAfterSec: 0 };
  const limiter = createRateLimiter({ name, limit, windowMs, backend: kvBackend(store), purpose: 'abuse-smoothing', failure: 'closed' });
  const { allowed, degraded, retryAfterSec } = await limiter.check(key);
  return { allowed, degraded, retryAfterSec };
}

/** Image type from magic bytes (the client-declared MIME type is never trusted). Returns a MIME type or ''. */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return '';
  const at = (i, ...b) => b.every((v, k) => bytes[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return '';
}
