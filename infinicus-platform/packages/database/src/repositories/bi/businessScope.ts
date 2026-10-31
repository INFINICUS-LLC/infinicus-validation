/**
 * Shared by the BI-10 persistence repositories (BI-2-DEV-07): one canonical identifier rule and one way to enter a business scope. Same platform rule as the
 * metric registry read repository (canonical 8-4-4-4-12 hexadecimal text, either letter case in, lower case out). The business must exist in the caller's tenant and
 * workspace and not be soft-deleted, otherwise NotFoundError, identical to a business that does not exist. Row-level security isolates tenant and workspace;
 * business isolation inside a workspace is the explicit predicate every statement of the repositories carries.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import type { PoolClient } from 'pg';
import { NotFoundError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const canonicalUuid = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);

export interface BusinessScope { tenantId: string; workspaceId: string; businessId: string }

export async function inBusinessScope<T>(ctx: TenantContext, businessId: string, fn: (client: PoolClient, scope: BusinessScope) => Promise<T>): Promise<T> {
  const id = canonicalUuid(businessId);
  if (id === null) throw new NotFoundError('Business', businessId);
  return withTenantTransaction(ctx, async (client) => {
    const business = await client.query('SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL', [id, ctx.tenantId, ctx.workspaceId]);
    if (business.rowCount !== 1) throw new NotFoundError('Business', businessId);
    return fn(client, { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: id });
  });
}

/** True for plain JSON data only: finite numbers, strings, booleans, null, arrays and plain objects (no undefined, NaN, Infinity, bigint, Date, class instance, function). */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) => isPlainJson(v, depth + 1));
  }
  return false;
}

/** The PostgreSQL error code of a failed statement, if it has one. */
export const pgCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);
