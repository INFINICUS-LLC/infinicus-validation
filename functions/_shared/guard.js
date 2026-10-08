// functions/_shared/guard.js — legacy Pages Functions shared security guards (PR-B)
//
// Fail-closed building blocks for the legacy Cloudflare Pages Functions. Runs on the Pages Workers runtime
// (Web Crypto, Request/Response/Headers, TextEncoder/Decoder; no Node built-ins, no network, no storage writes
// except through a rate-limit backend the CALLER supplies).
//
// What this module is:   configuration validation, constant-time secret comparison, exact-origin checks,
//                        bounded request-body parsing, field validation, generic error responses, and a
//                        rate-limit interface with explicit failure behaviour.
// What it is NOT:        an identity, session, tenant or authorization authority. It never decides who a
//                        person is or what they own. The Origin check is a browser-side cross-site control,
//                        NOT authentication. Rate limiting here is abuse/cost smoothing, NOT a strict boundary.
// Stack B:               this file does not import, read or write Stack B, D1 or the legacy KV user store.
//
// Not a route: it exports no onRequest* handler. PR-B wires nothing; PR-C integrates it into routes.
import { containsHeaderUnsafe, isValidHeaderName, normalizeEmailAddress } from './escape.js';

// ── errors, configuration ──────────────────────────────────────────────────────────────────────────

/** Thrown for missing/invalid security configuration. The message and fields never contain a configuration VALUE. */
export class GuardConfigError extends Error {
  constructor(code, problems = []) {
    super(`guard configuration invalid: ${code}`);
    this.name = 'GuardConfigError';
    this.code = code;
    this.problems = Object.freeze(problems.map((p) => Object.freeze({ ...p })));
  }
}

const PLACEHOLDER = /^(?:replace|change|your[_-]|todo|example|sample|secret|password|test|dummy|placeholder|xxx)/i;

/** Names only; reasons are fixed codes: missing | too_short | weak | invalid. Never returns or echoes the value. */
function secretProblem(value, minLength) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  if (value.length < minLength) return 'too_short';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return 'invalid';
  if (PLACEHOLDER.test(value) || new Set(value).size < 10) return 'weak';
  return null;
}

/**
 * Returns the secret only if it is present, long enough, free of whitespace/control characters and not an obvious
 * placeholder; otherwise throws GuardConfigError('unconfigured'). Callers translate that into a 503.
 */
export function readSecret(env, name, { minLength = 32 } = {}) {
  const value = env?.[name];
  const problem = secretProblem(value, minLength);
  if (problem) throw new GuardConfigError('unconfigured', [{ name, problem }]);
  return value;
}

/** Strict exact-origin normaliser: returns the canonical origin or null. Wildcards, paths, ports-by-default etc. are refused. */
export function normalizeOrigin(raw, { allowLocalhost = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin === 'null' || url.origin !== raw) return null; // rejects trailing slash, upper case, default ports, paths
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || url.hostname.startsWith('.') || url.hostname.endsWith('.') || url.hostname.includes('..')) return null; // no wildcards, underscores or IPv6 literals
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !(allowLocalhost && local)) return null;
  return url.origin;
}

/** Parses a comma-separated exact-origin allowlist. Empty, malformed or wildcard input throws GuardConfigError. */
export function parseAllowedOrigins(value, { allowLocalhost = false, max = 20 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new GuardConfigError('unconfigured', [{ name: 'origins', problem: 'missing' }]);
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length > max || parts.some((p) => p.length === 0)) throw new GuardConfigError('invalid_origins', [{ name: 'origins', problem: 'invalid' }]);
  const origins = parts.map((p) => normalizeOrigin(p, { allowLocalhost }));
  if (origins.some((o) => o === null)) throw new GuardConfigError('invalid_origins', [{ name: 'origins', problem: 'invalid' }]);
  return Object.freeze([...new Set(origins)]);
}

/**
 * Checks everything a route needs before it serves a request and reports ALL problems at once, by variable name and
 * fixed reason code only. requirements = { secrets: [{ name, minLength? }], origins?: { name, allowLocalhost? } }.
 */
export function validateGuardConfig(env, requirements = {}) {
  const problems = [];
  for (const { name, minLength = 32 } of requirements.secrets ?? []) {
    const problem = secretProblem(env?.[name], minLength);
    if (problem) problems.push({ name, problem });
  }
  if (requirements.origins) {
    const { name, allowLocalhost = false } = requirements.origins;
    try { parseAllowedOrigins(env?.[name], { allowLocalhost }); } catch (e) { problems.push({ name, problem: e.problems?.[0]?.problem ?? 'invalid' }); }
  }
  return { ok: problems.length === 0, problems };
}

/** validateGuardConfig that throws GuardConfigError('unconfigured') when anything is wrong (fail closed). */
export function requireGuardConfig(env, requirements) {
  const result = validateGuardConfig(env, requirements);
  if (!result.ok) throw new GuardConfigError('unconfigured', result.problems);
  return true;
}

// ── generic responses and safe logging ─────────────────────────────────────────────────────────────

const ERRORS = Object.freeze({
  unauthorized: [401, 'Unauthorized'],
  forbidden: [403, 'Forbidden'],
  origin_denied: [403, 'Forbidden'],
  not_found: [404, 'Not found'],
  method_not_allowed: [405, 'Method not allowed'],
  payload_too_large: [413, 'Request too large'],
  unsupported_media_type: [415, 'Unsupported media type'],
  invalid_request: [400, 'Invalid request'],
  rate_limited: [429, 'Too many requests'],
  unconfigured: [503, 'Service unavailable'],
  internal: [500, 'Internal error'],
});

/**
 * Generic external error response. The body is a fixed message per code: no detail, no input, no stack, no secret.
 * Unknown codes become 500 "Internal error". Extra headers (e.g. CORS) are validated and merged.
 */
export function errorResponse(code, { headers = {}, retryAfterSec } = {}) {
  const [status, message] = Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : ERRORS.internal;
  const out = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const [name, value] of Object.entries(headers)) {
    if (!isValidHeaderName(name) || typeof value !== 'string' || containsHeaderUnsafe(value)) continue; // drop, never throw
    out.set(name, value);
  }
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) out.set('Retry-After', String(Math.ceil(retryAfterSec)));
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: out });
}

const LOG_TOKEN = /^[a-z0-9_./:-]{1,64}$/;

/**
 * Security-event logging with a fixed shape: { event, route, code, status }. Each field must be a short lowercase
 * token; anything else is replaced with "invalid". No request data, headers, tokens or personal data can be logged.
 */
export function logSecurityEvent({ event, route, code, status } = {}, sink = console.warn) {
  const token = (v) => (typeof v === 'string' && LOG_TOKEN.test(v) ? v : 'invalid');
  const line = { event: token(event), route: token(route), code: token(code), status: Number.isInteger(status) ? status : 0 };
  try { sink(JSON.stringify(line)); } catch { /* logging must never break a request */ }
  return line;
}

// ── constant-time bearer verification ──────────────────────────────────────────────────────────────

const MAX_TOKEN_LENGTH = 1024;

/**
 * Constant-time string equality: both inputs are HMAC-SHA-256'd under a fresh random key and the fixed-length digests
 * are compared without early exit. Length and content of the secret do not influence timing.
 */
export async function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > MAX_TOKEN_LENGTH || b.length > MAX_TOKEN_LENGTH) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [x, y] = await Promise.all([crypto.subtle.sign('HMAC', key, encoder.encode(a)), crypto.subtle.sign('HMAC', key, encoder.encode(b))]);
  const dx = new Uint8Array(x);
  const dy = new Uint8Array(y);
  let diff = dx.length ^ dy.length;
  for (let i = 0; i < dx.length; i++) diff |= dx[i] ^ dy[i];
  return diff === 0;
}

/** Extracts the token from a single, well-formed "Authorization: Bearer <token>" header, else null. */
export function extractBearer(request) {
  const header = request.headers.get('Authorization');
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]{1,1024}={0,2})$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Verifies a bearer secret. Result: { ok: true } | { ok: false, code: 'unconfigured' | 'unauthorized' }.
 * A missing, short, whitespace-bearing or placeholder secret is "unconfigured" (503, fail closed), never "skip the check".
 */
export async function verifyBearer(request, env, secretName, { minLength = 32 } = {}) {
  let secret;
  try { secret = readSecret(env, secretName, { minLength }); } catch { return { ok: false, code: 'unconfigured' }; }
  const token = extractBearer(request);
  if (token === null) return { ok: false, code: 'unauthorized' };
  return (await constantTimeEqual(token, secret)) ? { ok: true } : { ok: false, code: 'unauthorized' };
}

// ── exact-origin CORS (NOT authentication) ─────────────────────────────────────────────────────────

/**
 * Compares the request's Origin header with an exact allowlist (from parseAllowedOrigins).
 * Returns { status: 'absent' | 'allowed' | 'denied', origin }. "null", lists ("a, b"), and anything not an exact
 * member are denied. A non-browser client can send any Origin or none: this is a CSRF/cross-site control only.
 */
export function evaluateOrigin(request, allowedOrigins) {
  const raw = request.headers.get('Origin');
  if (raw === null) return { status: 'absent', origin: null };
  return Array.isArray(allowedOrigins) && allowedOrigins.includes(raw) ? { status: 'allowed', origin: raw } : { status: 'denied', origin: null };
}

/**
 * Gate for state-changing requests. Browsers always send Origin on cross-origin POST; a missing Origin is refused
 * unless allowAbsent is set (e.g. server-to-server routes that authenticate with a bearer secret instead).
 */
export function requireAllowedOrigin(request, allowedOrigins, { allowAbsent = false } = {}) {
  const { status, origin } = evaluateOrigin(request, allowedOrigins);
  if (status === 'allowed' || (status === 'absent' && allowAbsent)) return { ok: true, origin };
  return { ok: false, code: 'origin_denied' };
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function checkedMethods(methods) {
  if (!Array.isArray(methods) || methods.length === 0 || !methods.every((m) => METHODS.has(m))) throw new GuardConfigError('invalid_cors_config', [{ name: 'methods', problem: 'invalid' }]);
  return methods;
}

function checkedHeaderNames(names) {
  if (!Array.isArray(names) || !names.every(isValidHeaderName)) throw new GuardConfigError('invalid_cors_config', [{ name: 'headers', problem: 'invalid' }]);
  return names;
}

/** CORS headers for an actual (non-preflight) response to an allowed origin: exact origin, Vary, never credentials. */
export function corsHeaders(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || containsHeaderUnsafe(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/**
 * Answers a CORS preflight. Returns null for non-OPTIONS requests. For OPTIONS: an allowed origin whose requested
 * method and headers are within the route's declared set gets 204 with exact-origin headers; everything else gets a
 * generic 403 with no CORS headers. Never emits Access-Control-Allow-Credentials or a wildcard.
 */
export function handlePreflight(request, allowedOrigins, { methods, allowHeaders = ['Content-Type'], maxAgeSec = 600 }) {
  if (request.method !== 'OPTIONS') return null;
  const okMethods = checkedMethods(methods);
  const okHeaders = checkedHeaderNames(allowHeaders);
  const { status, origin } = evaluateOrigin(request, allowedOrigins);
  if (status === 'absent') return new Response(null, { status: 204, headers: { Allow: [...okMethods, 'OPTIONS'].join(', '), Vary: 'Origin' } });
  if (status !== 'allowed') return errorResponse('origin_denied', { headers: { Vary: 'Origin' } });
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (requestedMethod !== null && !okMethods.includes(requestedMethod)) return errorResponse('origin_denied', { headers: { Vary: 'Origin' } });
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested !== null && requested.trim() !== '') {
    const allowed = okHeaders.map((h) => h.toLowerCase());
    if (!requested.split(',').map((h) => h.trim().toLowerCase()).every((h) => allowed.includes(h))) return errorResponse('origin_denied', { headers: { Vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': [...okMethods, 'OPTIONS'].join(', '),
      'Access-Control-Allow-Headers': okHeaders.join(', '),
      'Access-Control-Max-Age': String(Math.min(86400, Math.max(0, Math.floor(maxAgeSec)))),
    },
  });
}

// ── bounded request body and field validation ──────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function scanJson(value, depth, budget, limits) {
  if (depth > limits.maxDepth || --budget.nodes < 0) return false;
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) return false;
    return value.every((v) => scanJson(v, depth + 1, budget, limits));
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > limits.maxKeys || keys.some((k) => FORBIDDEN_KEYS.has(k))) return false;
    return keys.every((k) => scanJson(value[k], depth + 1, budget, limits));
  }
  return true;
}

/**
 * Reads a JSON object body with a hard byte cap enforced while streaming (Content-Length is checked but never trusted).
 * Result: { ok: true, value } | { ok: false, code } with code in payload_too_large | unsupported_media_type | invalid_request.
 * Rejects: wrong content type, malformed/oversized/non-UTF-8/empty bodies, non-object roots, deep or huge structures,
 * and keys named __proto__, constructor or prototype.
 */
export async function readJsonBody(request, { maxBytes = 16 * 1024, maxDepth = 8, maxKeys = 200, maxArrayLength = 200, maxNodes = 2000 } = {}) {
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase();
  if (!/^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/.test(type)) return { ok: false, code: 'unsupported_media_type' };
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared)) return { ok: false, code: 'invalid_request' };
    if (Number(declared) > maxBytes) return { ok: false, code: 'payload_too_large' };
  }
  if (!request.body) return { ok: false, code: 'invalid_request' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); return { ok: false, code: 'payload_too_large' }; }
      chunks.push(value);
    }
  } catch { return { ok: false, code: 'invalid_request' }; }
  if (total === 0) return { ok: false, code: 'invalid_request' };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return { ok: false, code: 'invalid_request' }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'invalid_request' };
  if (!scanJson(parsed, 0, { nodes: maxNodes }, { maxDepth, maxKeys, maxArrayLength })) return { ok: false, code: 'invalid_request' };
  return { ok: true, value: parsed };
}

// eslint-disable-next-line no-control-regex
const SINGLE_LINE_BAD = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const MULTI_LINE_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Validates a parsed object against a declared schema and returns a NEW object containing only declared fields.
 * schema = { field: { type: 'string'|'email'|'number'|'boolean'|'enum', required?, min?, max?, integer?, values?, multiline?, trim? } }.
 * Unknown fields are rejected (unless allowUnknown), strings may not hold control characters or lone surrogates.
 * Errors are { field, code } with fixed codes; offending values and unknown field names are never echoed.
 */
export function validateFields(input, schema, { allowUnknown = false } = {}) {
  const errors = [];
  const value = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ field: '(root)', code: 'invalid_type' }], value };
  if (!allowUnknown && Object.keys(input).some((k) => !Object.prototype.hasOwnProperty.call(schema, k))) errors.push({ field: '(unknown)', code: 'unknown_field' });
  for (const [field, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined && input[field] !== null;
    if (!present) { if (spec.required) errors.push({ field, code: 'required' }); continue; }
    const raw = input[field];
    switch (spec.type) {
      case 'string':
      case 'email': {
        if (typeof raw !== 'string') { errors.push({ field, code: 'invalid_type' }); break; }
        let text = spec.trim === false ? raw : raw.trim();
        if (spec.type === 'email') text = text.toLowerCase();
        if (LONE_SURROGATE.test(text) || (spec.multiline ? MULTI_LINE_BAD : SINGLE_LINE_BAD).test(text)) { errors.push({ field, code: 'invalid_chars' }); break; }
        if (text.length > (spec.max ?? 1000)) { errors.push({ field, code: 'too_long' }); break; }
        if (text.length < (spec.min ?? (spec.required ? 1 : 0))) { errors.push({ field, code: spec.required && text.length === 0 ? 'required' : 'too_short' }); break; }
        if (spec.type === 'email' && normalizeEmailAddress(text) === '') { errors.push({ field, code: 'invalid_value' }); break; }
        value[field] = text;
        break;
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || (spec.integer && !Number.isInteger(raw))) { errors.push({ field, code: 'invalid_type' }); break; }
        if (raw < (spec.min ?? -Number.MAX_SAFE_INTEGER) || raw > (spec.max ?? Number.MAX_SAFE_INTEGER)) { errors.push({ field, code: 'invalid_value' }); break; }
        value[field] = raw;
        break;
      }
      case 'boolean':
        if (typeof raw !== 'boolean') errors.push({ field, code: 'invalid_type' }); else value[field] = raw;
        break;
      case 'enum':
        if (typeof raw !== 'string' || !Array.isArray(spec.values) || !spec.values.includes(raw)) errors.push({ field, code: 'invalid_value' }); else value[field] = raw;
        break;
      default:
        errors.push({ field, code: 'invalid_type' });
    }
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : {} };
}

// ── client key (hash only) and rate-limit interface ────────────────────────────────────────────────

/** Client IP from CF-Connecting-IP only (set by Cloudflare; X-Forwarded-For is client-controlled and ignored). */
export function getClientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  return typeof ip === 'string' && ip.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(ip) ? ip : null;
}

/** SHA-256 hex of "namespace\0value". Rate-limit and abuse keys are stored hashed so no IP/email lands in KV or logs. */
export async function hashKey(namespace, value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}\0${value}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * In-isolate counter backend. Per-isolate only (resets on cold start, not shared across isolates):
 * best-effort abuse smoothing. atomic:false because it is not a global boundary.
 */
export function memoryBackend({ maxEntries = 10000 } = {}) {
  const map = new Map();
  return {
    atomic: false,
    kind: 'memory',
    async hit(key, { windowMs, now }) {
      if (map.size >= maxEntries) {
        for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
        if (map.size >= maxEntries) throw new Error('rate-limit capacity exceeded');
      }
      const entry = map.get(key);
      const resetAt = entry && entry.resetAt > now ? entry.resetAt : now + windowMs;
      const count = (entry && entry.resetAt > now ? entry.count : 0) + 1;
      map.set(key, { count, resetAt });
      return { count, resetAt };
    },
  };
}

/**
 * Cloudflare KV counter backend. KV is eventually consistent and a read-then-write counter is NOT atomic: concurrent
 * requests can undercount and different locations can disagree. atomic:false, so createRateLimiter refuses to use it as a
 * security boundary. Use it only to smooth abuse and cost; strict limits need Cloudflare Rate Limiting rules or an atomic backend.
 */
export function kvBackend(kv) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') throw new GuardConfigError('unconfigured', [{ name: 'kv', problem: 'missing' }]);
  return {
    atomic: false,
    kind: 'kv',
    async hit(key, { windowMs, now }) {
      const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
      const bucket = `${key}:${Math.floor(now / windowMs)}`;
      const previous = Number.parseInt((await kv.get(bucket)) ?? '0', 10);
      const count = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
      await kv.put(bucket, String(count), { expirationTtl: Math.max(60, Math.ceil((windowMs * 2) / 1000)) });
      return { count, resetAt };
    },
  };
}

/**
 * Creates a limiter with EXPLICIT behaviour:
 *   purpose: 'abuse-smoothing' | 'security-boundary'  (a security boundary requires an atomic backend and fail-closed)
 *   failure: 'closed' | 'open'                        (what to do when the backend errors or the key is unusable)
 * Misconfiguration throws GuardConfigError at creation, never at request time.
 * check(key) never throws and returns { allowed, degraded, limit, remaining, retryAfterSec, reason }.
 */
export function createRateLimiter({ name, limit, windowMs, backend, purpose, failure }) {
  if (typeof name !== 'string' || !LOG_TOKEN.test(name)) throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'name', problem: 'invalid' }]);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'limit', problem: 'invalid' }]);
  if (failure !== 'closed' && failure !== 'open') throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'failure', problem: 'missing' }]);
  if (purpose !== 'abuse-smoothing' && purpose !== 'security-boundary') throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'purpose', problem: 'missing' }]);
  if (!backend || typeof backend.hit !== 'function') throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'backend', problem: 'missing' }]);
  if (purpose === 'security-boundary' && (backend.atomic !== true || failure !== 'closed')) throw new GuardConfigError('invalid_rate_limit_config', [{ name: 'purpose', problem: 'not_a_security_boundary' }]);

  const verdict = (allowed, extra) => ({ allowed, degraded: false, limit, remaining: 0, retryAfterSec: 0, reason: 'ok', ...extra });
  const degraded = (reason) => verdict(failure === 'open', { degraded: true, reason, retryAfterSec: failure === 'open' ? 0 : Math.ceil(windowMs / 1000) });

  return {
    name,
    purpose,
    failure,
    async check(key, now = Date.now()) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 512) return degraded('unusable_key');
      try {
        const { count, resetAt } = await backend.hit(await hashKey(name, key), { windowMs, now });
        if (!Number.isFinite(count) || !Number.isFinite(resetAt)) return degraded('backend_error');
        return count <= limit
          ? verdict(true, { remaining: limit - count })
          : verdict(false, { reason: 'limit_exceeded', retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) });
      } catch {
        return degraded('backend_error');
      }
    },
  };
}
