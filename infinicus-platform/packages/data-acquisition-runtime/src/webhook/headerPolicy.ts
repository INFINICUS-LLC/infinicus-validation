/**
 * Which request headers of an inbound webhook delivery may be persisted in
 * data_acquisition.webhook_receipts.headers.
 *
 * Principle: persist only what is needed for provenance, diagnostics or later
 * signature verification, and NEVER anything that can carry a credential.
 * The receipt is long-lived, tenant-readable and copied into backups, so a
 * credential stored there is a credential leaked.
 *
 *  - ALLOW (exact or pattern): identification, correlation, content metadata and
 *    signature/timestamp/event/delivery metadata. A signature is derived from
 *    the payload and is what a later verification step needs; it is not a
 *    reusable credential for this platform.
 *  - DENY (always wins, even over an allowed name): anything whose name suggests
 *    authentication material, for example authorization, cookie, api keys,
 *    tokens (including shared-secret headers such as X-Gitlab-Token or
 *    X-Webhook-Token), secrets, passwords, sessions and bearer values.
 *  - Everything else is dropped by default.
 */
const ALLOW_EXACT = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'accept',
  'idempotency-key',
  'x-request-id',
  'x-correlation-id',
  'x-event-id',
  'x-delivery-id',
]);

const ALLOW_PATTERNS: readonly RegExp[] = [
  /-signature(-\d+)?$/,        // x-hub-signature-256, stripe-signature, webhook-signature, svix-signature
  /-hmac(-sha\d+)?$/,          // x-shopify-hmac-sha256
  /-timestamp$/,               // x-slack-request-timestamp, webhook-timestamp
  /(^|-)(event|delivery)(-id|-type)?$/, // x-github-event, x-github-delivery, x-event-type
  /^(svix|webhook)-id$/,
];

const DENY_PATTERN =
  /(authori[sz]ation|authenticate|cookie|token|secret|passw(or)?d|credential|session|api[-_]?key|apikey|bearer|private|x-csrf|x-xsrf)/;

const MAX_VALUE_LENGTH = 512;

export function isPersistableWebhookHeader(rawName: string): boolean {
  const name = rawName.trim().toLowerCase();
  if (name.length === 0 || DENY_PATTERN.test(name)) return false;
  return ALLOW_EXACT.has(name) || ALLOW_PATTERNS.some((p) => p.test(name));
}

/** Returns a new object holding only persistable headers, string-valued and length-bounded. */
export function sanitizeWebhookHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (!isPersistableWebhookHeader(rawName)) continue;
    const first = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof first !== 'string') continue;
    out[rawName.trim().toLowerCase()] = first.slice(0, MAX_VALUE_LENGTH);
  }
  return out;
}
