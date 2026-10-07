import { describe, it, expect } from 'vitest';
import { redactUrl } from '../src/redactUrl.js';

const TOKEN = 'a1b2c3d4e5f6.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('redactUrl', () => {
  it('replaces the webhook token path segment', () => {
    expect(redactUrl(`/v1/webhooks/data-acquisition/${TOKEN}`)).toBe('/v1/webhooks/data-acquisition/REDACTED');
  });

  it('keeps the query string and redacts when extra path segments follow', () => {
    expect(redactUrl(`/v1/webhooks/data-acquisition/${TOKEN}?x=1`)).toBe('/v1/webhooks/data-acquisition/REDACTED?x=1');
    expect(redactUrl(`/v1/webhooks/data-acquisition/${TOKEN}/extra`)).toBe('/v1/webhooks/data-acquisition/REDACTED/extra');
  });

  it('is case-insensitive on the route prefix and leaves the token out entirely', () => {
    expect(redactUrl(`/V1/Webhooks/Data-Acquisition/${TOKEN}`)).not.toContain(TOKEN);
  });

  it('leaves every other URL untouched', () => {
    for (const url of ['/v1/health', '/v1/businesses/abc/data-sources', '/v1/webhooks/data-acquisition/', '/']) {
      expect(redactUrl(url)).toBe(url);
    }
  });
});
