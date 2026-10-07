// Webhook intake carries its bearer token in the URL path
// (POST /v1/webhooks/data-acquisition/:token). A request that does not match a
// route (wrong method, trailing segment, etc.) has no route template, so code
// that falls back to the raw request URL for logging or error events would
// persist the token. Every such fallback goes through redactUrl().
const WEBHOOK_TOKEN_SEGMENT = /(\/v1\/webhooks\/data-acquisition\/)[^/?#\s]+/gi;

export const REDACTED_TOKEN_PLACEHOLDER = 'REDACTED';

export function redactUrl(url: string): string {
  return url.replace(WEBHOOK_TOKEN_SEGMENT, `$1${REDACTED_TOKEN_PLACEHOLDER}`);
}
