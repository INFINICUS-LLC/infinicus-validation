/**
 * Scoped reads for the lifecycle screens (NA-05): GET a /v1 resource in the SELECTED workspace, validate the answer against its schema, and turn any
 * failure into a user sentence. Pure (no React) so it is tested without a browser; the page hook wraps it. The workspace is always sent as the claim
 * pair the API re-verifies on every request; nothing is read without one.
 */
import type { ZodType } from 'zod';
import type { ApiClient, Scope } from './apiClient';
import { describeRequestError } from './lifecycle';

export type Resource<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error'; message: string };

export async function fetchScoped<T>(api: ApiClient, path: string, schema: ZodType<T>, scope: Scope): Promise<Exclude<Resource<T>, { kind: 'loading' }>> {
  try {
    return { kind: 'ok', data: await api.get(path, { schema, scope }) };
  } catch (error) {
    return { kind: 'error', message: describeRequestError(error) };
  }
}
