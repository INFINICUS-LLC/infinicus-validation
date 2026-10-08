// functions/_shared/escape.js — legacy Pages Functions shared security primitives (PR-B)
//
// Pure, dependency-free output-encoding helpers for the Cloudflare Pages Workers runtime
// (no Node built-ins, no network, no storage, no globals beyond ECMAScript + URL).
//
// Purpose: stop HTML injection into emails/pages and header injection into outgoing HTTP/email headers.
// These helpers never throw on hostile input unless documented ("assert*"); they never echo input into errors.
//
// Scope boundary: this file knows nothing about users, tenants, sessions or Stack B. It is not an identity or
// authorization authority and must not become one. Not a route: it exports no onRequest* handler.

const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' });
const REPLACEMENT = '�';

// C0 controls except TAB/LF/CR, DEL, C1 controls, and the Unicode line/paragraph separators.
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const HAS_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/** Coerces only primitives to text. Objects, arrays, functions and symbols become '' (never "[object Object]"). */
export function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** Replaces lone surrogates with U+FFFD so the text is well-formed Unicode. */
export function wellFormed(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += text[i] + text[i + 1]; i++; } else out += REPLACEMENT;
    } else if (c >= 0xdc00 && c <= 0xdfff) out += REPLACEMENT;
    else out += text[i];
  }
  return out;
}

/** Truncates to at most maxLength UTF-16 units without splitting a surrogate pair. */
export function truncate(text, maxLength) {
  if (!Number.isFinite(maxLength) || text.length <= maxLength) return text;
  const limit = Math.max(0, Math.floor(maxLength));
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * Encodes untrusted text for an HTML text node or a QUOTED attribute value.
 * Always quote attributes; unquoted attributes are not supported. Output is safe in both contexts.
 */
export function escapeHtml(value, { maxLength = Infinity } = {}) {
  const text = truncate(wellFormed(toText(value)).replace(UNSAFE_TEXT, ''), maxLength);
  return text.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Alias that documents intent: use inside a double- or single-quoted attribute. */
export const escapeAttribute = escapeHtml;

/**
 * Returns a normalised absolute URL string only if its scheme is allowed (default https:), else ''.
 * Use before placing untrusted URLs in href/src; the result must still go through escapeAttribute.
 */
export function safeUrl(value, { allowedSchemes = ['https:'], maxLength = 2048 } = {}) {
  const text = toText(value).trim();
  if (text.length === 0 || text.length > maxLength || HAS_CONTROL.test(text)) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!allowedSchemes.includes(url.protocol) || url.username || url.password) return '';
  return url.href;
}

/** A single line of plain text: control characters collapse to one space, edges trimmed, length capped. */
export function plainTextLine(value, maxLength = 200) {
  return truncate(wellFormed(toText(value)).replace(ANY_CONTROL, ' ').replace(/ {2,}/g, ' ').trim(), maxLength);
}

/** Multi-line plain text: keeps LF/TAB, drops other controls, normalises CRLF/CR to LF, length capped. */
export function plainTextBlock(value, maxLength = 2000) {
  return truncate(wellFormed(toText(value)).replace(/\r\n?/g, '\n').replace(UNSAFE_TEXT, ''), maxLength);
}

/** Finite number clamped to [min, max]; numeric strings (plain decimal) accepted; anything else returns fallback. */
export function toFiniteNumber(value, { min = -Infinity, max = Infinity, fallback = 0, integer = false } = {}) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.length <= 24 && /^-?\d+(?:\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  if (!Number.isFinite(n)) return fallback;
  if (integer) n = Math.trunc(n);
  return Math.min(max, Math.max(min, n));
}

// ── header-injection prevention ────────────────────────────────────────────────────────────────────

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** True when the value could split or smuggle a header: CR, LF, NUL or any other control character. */
export function containsHeaderUnsafe(value) {
  if (typeof value !== 'string') return true;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/.test(value);
}

/** True for a valid HTTP header field name (RFC 9110 token). */
export function isValidHeaderName(name) {
  return typeof name === 'string' && HEADER_NAME.test(name);
}

/**
 * Returns the value only if it is a printable-ASCII header value of acceptable length, else throws.
 * Throws a generic Error: the offending value is never included in the message.
 */
export function assertSafeHeaderValue(value, { maxLength = 998 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !/^[ -~]+$/.test(value) || containsHeaderUnsafe(value)) {
    throw new Error('unsafe header value');
  }
  return value;
}

/** Builds a Headers object from a plain map, throwing (generic message) on any invalid name or value. */
export function buildSafeHeaders(map) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(map ?? {})) {
    if (!isValidHeaderName(name)) throw new Error('unsafe header name');
    headers.set(name, assertSafeHeaderValue(value));
  }
  return headers;
}

/**
 * Strict email-address syntax check (single mailbox, ASCII/punycode only). Returns the lower-cased address or ''.
 * Hand-written and linear-time: no regular expression over untrusted input can backtrack catastrophically.
 */
export function normalizeEmailAddress(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return '';
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return '';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  for (let i = 0; i < local.length; i++) if (!"abcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-".includes(local[i])) return '';
  const labels = domain.split('.');
  if (labels.length < 2) return '';
  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return '';
    for (let i = 0; i < label.length; i++) if (!'abcdefghijklmnopqrstuvwxyz0123456789-'.includes(label[i])) return '';
  }
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) return '';
  return email;
}
