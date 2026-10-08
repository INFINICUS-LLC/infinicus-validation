// functions/_shared/email.js — legacy Pages Functions outbound email policy (PR-C)
//
// Every outbound email from the legacy routes goes through deliver(). Default behaviour is NO delivery.
//
//   EMAIL_MODE = disabled (default; also any unknown or differently-cased value) | log | live
//   disabled → nothing is sent, no network call, no secret required.
//   log      → nothing is sent; one fixed-shape log line (no addresses, no content) per message. Use to rehearse.
//   live     → requires ALL of: RESEND_API_KEY (strong secret), EMAIL_FROM on a domain listed in EMAIL_VERIFIED_DOMAINS
//              (the owner attests the domain is verified at the email provider; *.pages.dev / *.workers.dev are refused),
//              and, for owner notifications, EMAIL_OWNER_TO. Optional EMAIL_ALLOWED_RECIPIENT_DOMAINS restricts user recipients.
//
// Recipient controls: exactly one syntactically strict mailbox per message; owner notifications go only to EMAIL_OWNER_TO;
// the sender address is never a recipient; header values are sanitised; HTML must be escaped by the caller (escape.js).
// What this module cannot do: prove that a requester owns the mailbox they typed. Until a double opt-in exists, a
// user-addressed message can be triggered toward a third party (bounded by the route's abuse limits). Documented blocker.
//
// Not a route; touches no store; uses fetch only inside deliver() in live mode.
import { logSecurityEvent, readSecret } from './guard.js';
import { normalizeEmailAddress, plainTextLine } from './escape.js';

const BLOCKED_SENDER_SUFFIXES = ['.pages.dev', '.workers.dev'];
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;

export function emailMode(env) {
  return env?.EMAIL_MODE === 'live' ? 'live' : env?.EMAIL_MODE === 'log' ? 'log' : 'disabled';
}

/** Hostname syntax check without a backtracking regular expression. */
export function isValidDomain(domain) {
  if (typeof domain !== 'string' || domain.length < 4 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return false;
    for (const ch of label) if (!'abcdefghijklmnopqrstuvwxyz0123456789-'.includes(ch)) return false;
  }
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/** Comma-separated domain list → frozen array of valid, lower-case, de-duplicated domains; null if empty or any entry is invalid. */
export function parseDomainList(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parts = value.split(',').map((p) => p.trim().toLowerCase());
  if (parts.length > 20 || !parts.every(isValidDomain)) return null;
  return Object.freeze([...new Set(parts)]);
}

/** "Name <a@b.example>" or "a@b.example" → { name, address, domain } or null. Display name is plain text, no angle brackets or quotes. */
export function parseSender(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const open = value.indexOf('<');
  let name = '';
  let rawAddress = value;
  if (open !== -1) {
    if (!value.endsWith('>') || value.indexOf('<', open + 1) !== -1) return null;
    name = plainTextLine(value.slice(0, open), 60);
    rawAddress = value.slice(open + 1, -1);
    if (/["<>]/.test(name)) return null;
  }
  const address = normalizeEmailAddress(rawAddress);
  return address ? { name, address, domain: address.slice(address.indexOf('@') + 1) } : null;
}

/**
 * Validates the live configuration without sending anything. Returns { ok:true, from, owner, allowedDomains } or
 * { ok:false, problems:[{name, problem}] } (variable names and fixed reasons only, never values).
 */
export function liveConfig(env, { needOwner = false } = {}) {
  const problems = [];
  try { readSecret(env, 'RESEND_API_KEY', { minLength: 20 }); } catch { problems.push({ name: 'RESEND_API_KEY', problem: 'invalid' }); }
  const sender = parseSender(env?.EMAIL_FROM);
  const verified = parseDomainList(env?.EMAIL_VERIFIED_DOMAINS);
  if (!sender) problems.push({ name: 'EMAIL_FROM', problem: 'invalid' });
  if (!verified) problems.push({ name: 'EMAIL_VERIFIED_DOMAINS', problem: 'invalid' });
  if (sender && verified && (!verified.includes(sender.domain) || BLOCKED_SENDER_SUFFIXES.some((s) => sender.domain.endsWith(s)))) problems.push({ name: 'EMAIL_FROM', problem: 'unverified_domain' });
  const owner = normalizeEmailAddress(env?.EMAIL_OWNER_TO);
  if (needOwner && !owner) problems.push({ name: 'EMAIL_OWNER_TO', problem: 'invalid' });
  let allowedDomains = null;
  if (env?.EMAIL_ALLOWED_RECIPIENT_DOMAINS !== undefined && env.EMAIL_ALLOWED_RECIPIENT_DOMAINS !== '') {
    allowedDomains = parseDomainList(env.EMAIL_ALLOWED_RECIPIENT_DOMAINS);
    if (!allowedDomains) problems.push({ name: 'EMAIL_ALLOWED_RECIPIENT_DOMAINS', problem: 'invalid' });
  }
  return problems.length ? { ok: false, problems } : { ok: true, from: sender, owner, allowedDomains };
}

const logToken = (route) => (typeof route === 'string' ? route : 'invalid');

/**
 * Applies the policy to one message and (in live mode only) sends it.
 * message = { route, kind: 'owner' | 'user', to?, subject, html, replyTo? }
 * Result: { status: 'disabled' | 'logged' | 'sent' | 'refused' | 'unconfigured' | 'failed', reason? }. Never throws.
 * `to` is ignored for kind 'owner' (the recipient is EMAIL_OWNER_TO).
 */
export async function deliver(env, message, { fetchFn = globalThis.fetch } = {}) {
  const mode = emailMode(env);
  const route = logToken(message?.route);
  if (mode === 'disabled') return { status: 'disabled' };
  try {
    if (message?.kind !== 'owner' && message?.kind !== 'user') return { status: 'refused', reason: 'bad_kind' };
    const config = liveConfig(env, { needOwner: message.kind === 'owner' });
    if (!config.ok) {
      logSecurityEvent({ event: 'email_unconfigured', route, code: `unconfigured:${config.problems[0].name.toLowerCase()}`.slice(0, 64), status: 503 });
      return { status: 'unconfigured', reason: config.problems[0].problem };
    }
    const recipient = message.kind === 'owner' ? config.owner : normalizeEmailAddress(message.to);
    if (!recipient) return { status: 'refused', reason: 'bad_recipient' };
    if (recipient === config.from.address) return { status: 'refused', reason: 'recipient_is_sender' };
    if (message.kind === 'user' && config.allowedDomains && !config.allowedDomains.includes(recipient.slice(recipient.indexOf('@') + 1))) return { status: 'refused', reason: 'recipient_not_allowed' };
    const subject = plainTextLine(message.subject, 150);
    if (!subject || typeof message.html !== 'string' || message.html.length === 0 || message.html.length > 100_000) return { status: 'refused', reason: 'bad_content' };

    if (mode === 'log') {
      logSecurityEvent({ event: 'email_logged', route, code: message.kind, status: 200 });
      return { status: 'logged' };
    }

    const payload = {
      from: config.from.name ? `${config.from.name} <${config.from.address}>` : config.from.address,
      to: [recipient],
      subject,
      html: message.html,
    };
    const replyTo = normalizeEmailAddress(message.replyTo ?? env?.EMAIL_REPLY_TO);
    if (replyTo) payload.reply_to = replyTo;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetchFn(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        logSecurityEvent({ event: 'email_failed', route, code: 'provider_error', status: res.status });
        return { status: 'failed', reason: 'provider_error' };
      }
      return { status: 'sent' };
    } finally { clearTimeout(timer); }
  } catch {
    logSecurityEvent({ event: 'email_failed', route, code: 'network', status: 502 });
    return { status: 'failed', reason: 'network' };
  }
}
