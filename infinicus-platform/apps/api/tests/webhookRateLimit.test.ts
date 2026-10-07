import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createWebhookRateLimitHook, connectorKeyOf } from '../src/plugins/webhookRateLimit.js';
import { resolveTrustProxy } from '../src/trustProxy.js';

// Caddy as the only proxy: every request reaches the API from this address.
const CADDY = '172.18.0.2';
const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.77';
const PREFIX_X = 'aaaaaaaaaaaa';
const PREFIX_Y = 'bbbbbbbbbbbb';
const secret = '0'.repeat(64);

async function build(opts: { trustProxy: false | number; ipMax: number; connectorMax: number }) {
  const app = Fastify({ trustProxy: resolveTrustProxy(opts.trustProxy) });
  // Same global limiter shape as app.ts; the webhook route opts out of it.
  await app.register(rateLimit, { max: 2, timeWindow: 60_000 });
  app.decorateRequest('correlationId', 'test-correlation');
  const hook = createWebhookRateLimitHook(app, { ipMax: opts.ipMax, connectorMax: opts.connectorMax, windowMs: 60_000 });
  app.post('/v1/webhooks/data-acquisition/:token', { config: { rateLimit: false }, onRequest: hook }, async () => ({ ok: true }));
  app.post('/v1/other', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const hit = (app: Awaited<ReturnType<typeof build>>, xff: string, prefix: string) =>
  app.inject({
    method: 'POST', url: `/v1/webhooks/data-acquisition/${prefix}.${secret}`,
    remoteAddress: CADDY, headers: { 'x-forwarded-for': xff }, payload: {},
  });
const statuses = async (app: Awaited<ReturnType<typeof build>>, xff: string, prefix: string, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await hit(app, xff, prefix)).statusCode);
  return out;
};

describe('webhook rate limiting behind a single trusted proxy (TRUST_PROXY=1)', () => {
  it('one source cannot exhaust another source\'s quota, even for the same connector', async () => {
    const app = await build({ trustProxy: 1, ipMax: 50, connectorMax: 3 });
    expect(await statuses(app, CLIENT_A, PREFIX_X, 4)).toEqual([200, 200, 200, 429]);
    expect(await statuses(app, CLIENT_B, PREFIX_X, 3)).toEqual([200, 200, 200]);
    await app.close();
  });

  it('one connector exhausting its quota does not block another connector from the same source', async () => {
    const app = await build({ trustProxy: 1, ipMax: 50, connectorMax: 3 });
    expect(await statuses(app, CLIENT_A, PREFIX_X, 4)).toEqual([200, 200, 200, 429]);
    expect(await statuses(app, CLIENT_A, PREFIX_Y, 3)).toEqual([200, 200, 200]);
    await app.close();
  });

  it('the per-source ceiling still applies when requests spray many different prefixes', async () => {
    const app = await build({ trustProxy: 1, ipMax: 5, connectorMax: 5 });
    const out: number[] = [];
    for (let i = 0; i < 7; i++) out.push((await hit(app, CLIENT_A, `p${i}`.padEnd(12, '0'))).statusCode);
    expect(out).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // a different source is unaffected
    expect((await hit(app, CLIENT_B, 'zzzzzzzzzzzz')).statusCode).toBe(200);
    await app.close();
  });

  it('ignores addresses a client forges to the left of the proxy-appended one', async () => {
    const app = await build({ trustProxy: 1, ipMax: 50, connectorMax: 2 });
    // A rotates a forged leftmost address each time; Caddy still appends the real one on the right.
    const out: number[] = [];
    for (let i = 0; i < 3; i++) out.push((await hit(app, `10.9.9.${i}, ${CLIENT_A}`, PREFIX_X)).statusCode);
    expect(out).toEqual([200, 200, 429]);
    await app.close();
  });

  it('answers 429 with Retry-After and the API error shape', async () => {
    const app = await build({ trustProxy: 1, ipMax: 50, connectorMax: 1 });
    await hit(app, CLIENT_A, PREFIX_X);
    const res = await hit(app, CLIENT_A, PREFIX_X);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited', correlationId: 'test-correlation' } });
    await app.close();
  });

  it('does not consume, and is not throttled by, the global API quota', async () => {
    const app = await build({ trustProxy: 1, ipMax: 50, connectorMax: 10 });
    // exhaust the global limiter (max 2) for CLIENT_A on an ordinary route
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/v1/other', remoteAddress: CADDY, headers: { 'x-forwarded-for': CLIENT_A } });
    expect((await hit(app, CLIENT_A, PREFIX_X)).statusCode).toBe(200);
    await app.close();
  });
});

describe('why TRUST_PROXY must be configured (documented failure mode)', () => {
  it('with trustProxy unset behind a proxy, every client shares one bucket', async () => {
    const app = await build({ trustProxy: false, ipMax: 50, connectorMax: 3 });
    expect(await statuses(app, CLIENT_A, PREFIX_X, 4)).toEqual([200, 200, 200, 429]);
    expect((await hit(app, CLIENT_B, PREFIX_X)).statusCode).toBe(429); // B is throttled by A's traffic
    await app.close();
  });
});

describe('connectorKeyOf', () => {
  it('uses the prefix before the dot and bounds the key length', () => {
    expect(connectorKeyOf({ params: { token: `${PREFIX_X}.${secret}` } } as never)).toBe(PREFIX_X);
    expect(connectorKeyOf({ params: { token: 'x'.repeat(5000) } } as never).length).toBe(32);
    expect(connectorKeyOf({ params: {} } as never)).toBe('');
  });
});
