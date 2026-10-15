import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient, ApiError, ApiUnavailableError, ApiContractError, SessionExpiredError } from '../lib/client/apiClient';

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const scope = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222' };

function client(fetchImpl: typeof fetch, over: { refresh?: () => Promise<string | null>; timeoutMs?: number } = {}) {
  return createApiClient({ baseUrl: 'https://api.example.test', getToken: async () => 'tok-1', refreshToken: over.refresh ?? (async () => 'tok-2'), fetchImpl, timeoutMs: over.timeoutMs });
}

describe('API client', () => {
  it('sends the bearer token, never cookies, and the workspace claim headers only when a scope is given', async () => {
    const f = vi.fn(async () => res(200, { ok: true }));
    const api = client(f as unknown as typeof fetch);
    await api.get('/v1/x');
    await api.post('/v1/y', { body: { a: 1 }, scope, idempotencyKey: 'k-1' });
    const [, first] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [, second] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(first.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(Object.keys(first.headers as object)).not.toContain('x-tenant-id');
    expect(first.credentials).toBe('omit');
    expect(second.headers).toMatchObject({ 'x-tenant-id': scope.tenantId, 'x-workspace-id': scope.workspaceId, 'idempotency-key': 'k-1', 'content-type': 'application/json' });
    expect(second.body).toBe('{"a":1}');
  });

  it('on a 401 asks for a NEW session once and retries once; success after the retry is returned', async () => {
    const seen: string[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => { seen.push((init!.headers as Record<string, string>).authorization); return seen.length === 1 ? res(401, { error: { code: 'S', message: 'm', correlationId: 'c' } }) : res(200, { v: 1 }); });
    await expect(client(f as unknown as typeof fetch).get('/v1/x')).resolves.toEqual({ v: 1 });
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('a second 401, or no way to get a new session, is SessionExpired (and the second attempt is not repeated)', async () => {
    const always401 = vi.fn(async () => res(401, {}));
    await expect(client(always401 as unknown as typeof fetch).get('/v1/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(always401).toHaveBeenCalledTimes(2);
    const once = vi.fn(async () => res(401, {}));
    await expect(client(once as unknown as typeof fetch, { refresh: async () => null }).get('/v1/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('maps error bodies to ApiError with status, code, message and correlation id; tolerates non-JSON bodies', async () => {
    const f1 = vi.fn(async () => res(403, { error: { code: 'PermissionDeniedError', message: 'Denied', correlationId: 'corr-9' } }));
    await expect(client(f1 as unknown as typeof fetch).get('/v1/x')).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'PermissionDeniedError', message: 'Denied', correlationId: 'corr-9' });
    const f2 = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await client(f2 as unknown as typeof fetch).get('/v1/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'UNKNOWN' });
  });

  it('network failure and timeout are ApiUnavailable', async () => {
    await expect(client((async () => { throw new TypeError('down'); }) as unknown as typeof fetch).get('/v1/x')).rejects.toBeInstanceOf(ApiUnavailableError);
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(client(hang, { timeoutMs: 15 }).get('/v1/x')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('validates the response shape when a schema is given, and handles 204', async () => {
    const schema = z.object({ n: z.number() });
    await expect(client((async () => res(200, { n: 'x' })) as unknown as typeof fetch).get('/v1/x', { schema })).rejects.toBeInstanceOf(ApiContractError);
    await expect(client((async () => res(200, { n: 3 })) as unknown as typeof fetch).get('/v1/x', { schema })).resolves.toEqual({ n: 3 });
    await expect(client((async () => new Response(null, { status: 204 })) as unknown as typeof fetch).post('/v1/x')).resolves.toBeUndefined();
  });
});
