import { describe, it, expect } from 'vitest';
import { isPersistableWebhookHeader, sanitizeWebhookHeaders } from '../src/webhook/headerPolicy.js';

describe('webhook header persistence policy', () => {
  it('never persists credential-bearing headers (minimum required set)', () => {
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) {
      expect(isPersistableWebhookHeader(name)).toBe(false);
    }
  });

  it('never persists equivalent credential-bearing headers', () => {
    const credentialLike = [
      'set-cookie', 'www-authenticate', 'proxy-authenticate', 'api-key', 'apikey', 'x-apikey',
      'x-auth-token', 'x-access-token', 'x-refresh-token', 'x-amz-security-token', 'x-goog-api-key',
      'x-gitlab-token', 'x-webhook-token', 'x-webhook-secret', 'x-client-secret', 'x-api-secret',
      'x-csrf-token', 'x-xsrf-token', 'x-session-id', 'x-bearer', 'x-password', 'x-private-key',
      'x-github-token', 'authorisation',
    ];
    for (const name of credentialLike) expect(isPersistableWebhookHeader(name), name).toBe(false);
  });

  it('is case-insensitive and whitespace-tolerant for denial', () => {
    expect(isPersistableWebhookHeader('Authorization')).toBe(false);
    expect(isPersistableWebhookHeader('  X-API-KEY ')).toBe(false);
    expect(isPersistableWebhookHeader('COOKIE')).toBe(false);
  });

  it('deny wins over an otherwise-allowed shape', () => {
    // matches the signature/timestamp allow patterns but contains a deny word
    expect(isPersistableWebhookHeader('x-token-signature')).toBe(false);
    expect(isPersistableWebhookHeader('x-secret-timestamp')).toBe(false);
  });

  it('keeps provenance, correlation, content and signature/event metadata', () => {
    const kept = [
      'content-type', 'content-length', 'user-agent', 'accept', 'idempotency-key',
      'x-request-id', 'x-correlation-id', 'x-event-id', 'x-delivery-id',
      'x-hub-signature-256', 'stripe-signature', 'svix-signature', 'webhook-signature',
      'x-shopify-hmac-sha256', 'x-slack-request-timestamp', 'webhook-timestamp',
      'x-github-event', 'x-github-delivery', 'svix-id', 'webhook-id',
    ];
    for (const name of kept) expect(isPersistableWebhookHeader(name), name).toBe(true);
  });

  it('drops everything not explicitly needed (default deny)', () => {
    for (const name of ['host', 'connection', 'accept-encoding', 'x-forwarded-for', 'x-real-ip', 'x-custom-thing', 'referer', '']) {
      expect(isPersistableWebhookHeader(name), name).toBe(false);
    }
  });

  it('sanitizeWebhookHeaders returns only persistable, string, length-bounded values', () => {
    const out = sanitizeWebhookHeaders({
      authorization: 'Bearer abc',
      Cookie: 'sid=1',
      'proxy-authorization': 'Basic xyz',
      'x-api-key': 'k',
      'x-gitlab-token': 'shared',
      'content-type': 'application/json',
      'X-Event-Id': ['evt_1', 'evt_2'],
      'x-hub-signature-256': 's'.repeat(2000),
      'user-agent': 123,
      host: 'api.example.com',
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'x-event-id': 'evt_1',
      'x-hub-signature-256': 's'.repeat(512),
    });
    expect(JSON.stringify(out)).not.toMatch(/Bearer|sid=1|Basic xyz|shared/);
  });

  it('handles missing headers', () => {
    expect(sanitizeWebhookHeaders(undefined)).toEqual({});
    expect(sanitizeWebhookHeaders({})).toEqual({});
  });
});
