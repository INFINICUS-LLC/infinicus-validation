/**
 * R-01B-3: format-only checks for values that Business Operations stores in typed columns.
 *
 * These are the column types themselves, not business rules: a `uuid` column cannot hold a non-UUID string and a `date` column is a calendar date.
 * Checking the format here keeps a malformed value from reaching BO as a raw database error that would abort a whole atomic handoff. Whether the
 * referenced entity exists in the business is Business Operations' decision and is never checked by the DAL.
 */

const HEX = '0123456789abcdefABCDEF';

/** Canonical lower-case 8-4-4-4-12 UUID text, or null. Hand-checked (no regex). Version/variant bits are not enforced: PostgreSQL does not either. */
export function canonicalUuid(text: string): string | null {
  if (text.length !== 36) return null;
  for (let i = 0; i < 36; i++) {
    const ch = text[i];
    const dash = i === 8 || i === 13 || i === 18 || i === 23;
    if (dash ? ch !== '-' : !HEX.includes(ch)) return null;
  }
  return text.toLowerCase();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `YYYY-MM-DD` that is a real calendar date, or null. No time, no zone, no rollover (2026-02-31 is not March 3), proper leap-year arithmetic. */
export function strictCalendarDate(text: string): string | null {
  if (text.length !== 10 || text[4] !== '-' || text[7] !== '-') return null;
  const parts = [text.slice(0, 4), text.slice(5, 7), text.slice(8, 10)];
  if (!parts.every((p) => [...p].every((ch) => ch >= '0' && ch <= '9'))) return null;
  const [year, month, day] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth ? text : null;
}
