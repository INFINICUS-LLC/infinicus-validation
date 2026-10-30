/**
 * Format check for a value that Business Operations stores in a typed `uuid` column (BO-REF-UUID-01).
 *
 * A malformed value used to reach PostgreSQL, which refuses it with `invalid input syntax for type uuid: "<the value>"`. That raw database error is not a
 * deterministic business rejection, it aborts the surrounding atomic transaction, and (once wrapped by the intake service) it repeats the caller's value
 * in the persisted rejection. The check is therefore made at the command boundary, before any SQL.
 *
 * The rule is the same one the Data Acquisition Layer applies to the references it does check (`canonicalUuid`): canonical 8-4-4-4-12 hexadecimal text,
 * either letter case on input, returned lower-case. PostgreSQL itself refuses whitespace and a `urn:uuid:` prefix, but it also tolerates forms the
 * contract does not define: `{braces}`, 32 hexadecimal digits without hyphens, and hyphens regrouped every four digits. Those are refused here, as they
 * are by the DAL. Version and variant bits are not enforced, because PostgreSQL does not enforce them either. It is hand-checked, with no regular
 * expression, so it cannot be bent by a trailing newline, and it is repeated here instead of imported because BO does not depend on DAL code.
 */

const HEX = '0123456789abcdefABCDEF';

/** The lower-case canonical form of `value`, or `null` when `value` is not a string holding a canonical UUID. */
export function canonicalUuidReference(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 36) return null;
  for (let i = 0; i < 36; i++) {
    const ch = value[i];
    const dash = i === 8 || i === 13 || i === 18 || i === 23;
    if (dash ? ch !== '-' : !HEX.includes(ch)) return null;
  }
  return value.toLowerCase();
}

/** The one message for a rejected reference: it names the field and the rule, never the value. */
export function referenceIdProblem(): string {
  return 'referenceId must be a canonical UUID (8-4-4-4-12 hexadecimal characters).';
}
