// Small pure string checks shared by the contract modules (explicit code instead of backtracking regular expressions).

const DIGITS = /^[0-9]+$/;

/** Non-negative decimal string such as "12.50" (no regex backtracking). */
export function isDecimalString(value: string): boolean {
  const parts = value.split('.');
  return parts.length <= 2 && parts.every((p) => DIGITS.test(p));
}

/** Dotted numeric version such as "1" or "2.1". */
export function isDottedNumeric(value: string): boolean {
  return value.length > 0 && value.split('.').every((p) => DIGITS.test(p));
}
