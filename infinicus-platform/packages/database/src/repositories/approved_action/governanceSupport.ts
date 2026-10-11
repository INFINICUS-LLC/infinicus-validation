// P0-5 Block 3c-2 - small helpers shared by the action-type registry and automation-policy repositories.
// Internal to the approved_action repositories (not exported from the package index).

import type { PoolClient } from 'pg';
import { ValidationError } from './errors.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** pg check_violation: every guard in 0178 raises with this code and a readable message. */
export const CHECK_VIOLATION = '23514';

export const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export function requireUuid(entity: string, label: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ValidationError(entity, [`${label} must be a lowercase UUID`]);
  return value;
}

export function requireText(entity: string, label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ValidationError(entity, [`${label} is required (1-${max} characters)`]);
  }
  return value;
}

/** Stable, key-order-independent serialization, for recognizing an identical replay. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}

/** Maps a 0178 guard rejection to a ValidationError carrying the database's own message; anything else is rethrown. */
export function mapGuardError(entity: string, error: unknown): never {
  if ((error as { code?: string }).code === CHECK_VIOLATION) throw new ValidationError(entity, [(error as Error).message]);
  throw error;
}

/** Serializes writers of one logical key for the length of the transaction. */
export async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
