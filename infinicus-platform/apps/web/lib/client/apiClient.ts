/**
 * Minimal typed client for the INFINICUS /v1 API (NA-04, Option B). The browser sends only a bearer token it received from the API's own identity
 * exchange and, for tenant routes, the X-Tenant-Id / X-Workspace-Id headers. Those two are CLAIMS: the API verifies the caller's active membership in
 * exactly that workspace on every request and the permission for the route, so nothing sent from here is authority.
 */
import type { ZodType } from 'zod';

/** A selected workspace, sent to the API as a claim (never as authority). */
export interface Scope { tenantId: string; workspaceId: string }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly correlationId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}
/** The API could not be reached (network failure, timeout, TLS, CORS). */
export class ApiUnavailableError extends Error {
  constructor(message = 'The service could not be reached.') { super(message); this.name = 'ApiUnavailableError'; }
}
/** The API answered, but not in the documented shape. */
export class ApiContractError extends Error {
  constructor(message = 'The service answered in an unexpected format.') { super(message); this.name = 'ApiContractError'; }
}
/** The backend session is gone and could not be re-established; the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor() { super('Your session has ended. Please sign in again.'); this.name = 'SessionExpiredError'; }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** The current backend session token (exchanging one first if needed). */
  getToken: () => Promise<string>;
  /** After a 401: obtain a NEW backend session token, or null when that is impossible. Called at most once per request. */
  refreshToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestInitLite<T> {
  body?: unknown;
  scope?: Scope;
  idempotencyKey?: string;
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

export interface ApiClient {
  get<T>(path: string, init?: RequestInitLite<T>): Promise<T>;
  post<T>(path: string, init?: RequestInitLite<T>): Promise<T>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function once(method: string, path: string, token: string, init: RequestInitLite<unknown>): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.scope) { headers['x-tenant-id'] = init.scope.tenantId; headers['x-workspace-id'] = init.scope.workspaceId; }
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      return await doFetch(`${options.baseUrl}${path}`, {
        method, headers, signal: controller.signal, credentials: 'omit',
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(method: string, path: string, init: RequestInitLite<T> = {}): Promise<T> {
    let res = await once(method, path, await options.getToken(), init);
    if (res.status === 401) {
      const fresh = await options.refreshToken();
      if (!fresh) throw new SessionExpiredError();
      res = await once(method, path, fresh, init);
      if (res.status === 401) throw new SessionExpiredError();
    }
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    let payload: unknown;
    try { payload = await res.json(); } catch { throw new ApiContractError(); }
    if (!init.schema) return payload as T;
    const parsed = init.schema.safeParse(payload);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  }

  return {
    get: (path, init) => request('GET', path, init),
    post: (path, init) => request('POST', path, init),
  };
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = `Request failed (${res.status}).`;
  let correlationId: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown; correlationId?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.correlationId === 'string') correlationId = body.error.correlationId;
  } catch { /* non-JSON error body: keep the generic message */ }
  return new ApiError(res.status, code, message, correlationId);
}
