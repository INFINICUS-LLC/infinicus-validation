/**
 * BO-ID-UUID-02: the generic part of the check that the identifiers of a Business Operations command that are stored in typed `uuid` columns are canonical
 * UUIDs before the command reaches SQL. Which fields each command carries is decided in the executor, next to the SQL that uses them.
 *
 * A malformed identifier used to reach PostgreSQL as a query parameter. The database refused it with a raw `invalid input syntax for type uuid: "<value>"`
 * error, which is not a deterministic business rejection, aborts the surrounding atomic transaction and, wrapped by the intake service, repeats the value in
 * the persisted rejection. The check is made once, at the Business Operations command boundary, with the same canonical validator as BO-REF-UUID-01
 * (`canonicalUuidReference`), and the message names the FIELD, never the value.
 *
 * Only identifiers that map to a `uuid` column are checked. `memberId` and `customerId` of the workforce and operational-fact commands are stored in `text`
 * columns (business_events.member_id, business_events.customer_id): they are free-form external identifiers and are deliberately NOT validated as UUIDs.
 * Optional fields are checked only when present, so an absent optional identifier behaves exactly as before. Nothing here normalises a value or changes who
 * may run a command: authorization, tenant scope and business scope are decided elsewhere and unchanged.
 */
import type { OperationalCommandContext } from './types.js';
import { canonicalUuidReference, uuidFieldProblem } from './uuidReference.js';

export interface IdentifierField { name: string; value: unknown; optional: boolean }

export const idRequired = (name: string, value: unknown): IdentifierField => ({ name, value, optional: false });
export const idOptional = (name: string, value: unknown): IdentifierField => ({ name, value, optional: true });

/** The uuid-typed identifiers every command carries in its context: the business and the correlation (both stored), and the optional causation. */
export function contextIdentifierFields(context: OperationalCommandContext | undefined): IdentifierField[] {
  return [idRequired('businessId', context?.businessId), idRequired('correlationId', context?.correlationId), idOptional('causationId', context?.causationId)];
}

/**
 * The deterministic message for the first field, in the order given, that is not a canonical UUID, or `null` when every field is acceptable. Absent
 * (`undefined` or `null`) optional fields are acceptable; an absent required field is not.
 */
export function firstIdentifierProblem(fields: readonly IdentifierField[]): string | null {
  for (const field of fields) {
    if (field.optional && (field.value === undefined || field.value === null)) continue;
    if (canonicalUuidReference(field.value) === null) return uuidFieldProblem(field.name);
  }
  return null;
}
