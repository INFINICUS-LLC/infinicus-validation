/**
 * S-2 - API CORS. The allowed methods must cover every method the application registers (PUT was missing: three routes use it, so a browser on an
 * allowed origin failed the preflight), and the origin allowlist must still be an explicit list, never a wildcard. No database needed: the real
 * application is built with an unused URL and preflights are injected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const captured: { routes: Array<{ method: string | string[]; url: string }> } = { routes: [] };
vi.mock('fastify', async (importOriginal) => {
  const mod: any = await importOriginal();
  const real = mod.default;
  const wrapped: any = (opts: any) => {
    const app = real(opts);
    app.addHook('onRoute', (r: any) => captured.routes.push({ method: r.method, url: r.url }));
    return app;
  };
  Object.assign(wrapped, real);
  return { ...mod, default: wrapped };
});

import { loadConfig } from '@infinicus/configuration';
import { buildApp } from '../src/app.js';

const ALLOWED = 'https://infini-cus.com';
const ALSO_ALLOWED = 'https://next.infini-cus.com';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadConfig({
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    CORS_ALLOWED_ORIGINS: `${ALLOWED},${ALSO_ALLOWED}`,
  }));
  await app.ready();
});
afterAll(async () => { await app?.close(); });

const preflight = (url: string, origin: string, method: string, headers = 'authorization,content-type,x-tenant-id,x-workspace-id,idempotency-key') =>
  app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });
const allowedMethods = (res: { headers: Record<string, unknown> }) => String(res.headers['access-control-allow-methods'] ?? '').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);

describe('API CORS (S-2)', () => {
  it('the application registers PUT routes (this is why PUT must be allowed) - at least the three known ones', () => {
    const puts = captured.routes.filter((r) => ([] as string[]).concat(r.method).includes('PUT')).map((r) => r.url).sort();
    expect(puts).toEqual(expect.arrayContaining([
      '/v1/businesses/:businessId/declared-currency',
      '/v1/businesses/:businessId/execution-activations',
    ]));
    expect(puts.length).toBeGreaterThanOrEqual(3);
  });

  it('EVERY method any registered route uses is allowed by CORS (so a method added later cannot be forgotten)', async () => {
    const used = new Set(captured.routes.flatMap((r) => ([] as string[]).concat(r.method)).map((m) => m.toUpperCase()).filter((m) => m !== 'HEAD'));
    const res = await preflight('/v1/businesses', ALLOWED, 'GET');
    const allowed = new Set(allowedMethods(res));
    const missing = [...used].filter((m) => !allowed.has(m));
    expect(missing, `methods used by routes but not allowed by CORS: ${missing.join(', ')}`).toEqual([]);
    expect(allowed.has('OPTIONS')).toBe(true);
  });

  it.each([
    ['PUT', '/v1/businesses/00000000-0000-4000-8000-000000000000/declared-currency'],
    ['PUT', '/v1/businesses/00000000-0000-4000-8000-000000000000/execution-activations'],
    ['PUT', '/v1/businesses/00000000-0000-4000-8000-000000000000/inventory-items/00000000-0000-4000-8000-000000000001/warehouses/00000000-0000-4000-8000-000000000002/initial-reorder-policy'],
    ['GET', '/v1/auth/memberships'],
    ['POST', '/v1/auth/identity-exchange'],
    ['PATCH', '/v1/businesses'],
    ['DELETE', '/v1/businesses'],
  ])('a preflight for %s %s from an allowed origin succeeds and echoes exactly that origin', async (method, url) => {
    for (const origin of [ALLOWED, ALSO_ALLOWED]) {
      const res = await preflight(url, origin, method);
      expect(res.statusCode, `${origin} ${method}`).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(allowedMethods(res)).toContain(method);
      const headers = String(res.headers['access-control-allow-headers']).toLowerCase();
      for (const h of ['authorization', 'content-type', 'x-tenant-id', 'x-workspace-id', 'idempotency-key']) expect(headers).toContain(h);
    }
  });

  it('a foreign origin gets no allow-origin header for PUT or any other method (allowlist, never a wildcard)', async () => {
    for (const method of ['PUT', 'GET', 'POST']) {
      for (const origin of ['https://evil.example', 'https://infini-cus.com.evil.example', 'http://infini-cus.com', 'null']) {
        const res = await preflight('/v1/businesses/00000000-0000-4000-8000-000000000000/declared-currency', origin, method);
        expect(res.headers['access-control-allow-origin'], `${origin} ${method}`).toBeUndefined();
      }
    }
  });

  it('credentials are allowed only together with an explicit origin, never with *', async () => {
    const res = await preflight('/v1/auth/memberships', ALLOWED, 'GET');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('PUT remains authenticated: CORS permits the preflight only; the route itself still answers 401 without a token', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/businesses/00000000-0000-4000-8000-000000000000/declared-currency', headers: { origin: ALLOWED, 'idempotency-key': 'k-1' }, payload: { currency: 'USD', expectedVersion: null } });
    expect(res.statusCode).toBe(401);
  });
});
