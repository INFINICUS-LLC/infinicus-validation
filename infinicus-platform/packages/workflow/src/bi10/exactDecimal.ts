/**
 * Exact decimal arithmetic for BI-10 (BI-2-DEV-05). Pure: no clock, no randomness, no floating-point arithmetic. A value is a BigInt coefficient and a decimal
 * scale (value = coefficient / 10^scale), so sums, differences, products, comparisons and medians are exact for any magnitude. Division is the only operation that
 * can need rounding: it is done to a fixed number of decimal places (DIVISION_SCALE) with round-half-to-even, and nothing else rounds.
 * A JavaScript number enters as its shortest round-trip decimal text (0.1 is 0.1, not 0.1000000000000000055...); anything not finite is refused.
 */

export const DIVISION_SCALE = 10;

export interface Decimal { readonly c: bigint; readonly s: number }

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);
const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function normalize(c: bigint, s: number): Decimal {
  if (c === 0n) return { c: 0n, s: 0 };
  let coefficient = c; let scale = s;
  while (scale > 0 && coefficient % TEN === 0n) { coefficient /= TEN; scale -= 1; }
  return { c: coefficient, s: scale };
}

/** Parses decimal text (optionally with an exponent). Returns null for anything that is not a plain decimal number. */
export function parseDecimal(text: string): Decimal | null {
  const m = DECIMAL_TEXT.exec(text);
  if (!m) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = m;
  const exp = Number.parseInt(exponent, 10);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  let digits = BigInt(whole! + fraction);
  let scale = fraction.length - exp;
  if (scale < 0) { digits *= pow10(-scale); scale = 0; }
  return normalize(sign === '-' ? -digits : digits, scale);
}

/** A row value as an exact decimal: a finite JS number (by its shortest text), a bigint, or numeric text. Anything else is not numeric. */
export function toDecimal(value: unknown): Decimal | null {
  if (typeof value === 'number') return Number.isFinite(value) ? parseDecimal(String(value)) : null;
  if (typeof value === 'bigint') return normalize(value, 0);
  if (typeof value === 'string') return parseDecimal(value.trim() === value ? value : '');
  return null;
}

export const fromInteger = (n: number): Decimal => normalize(BigInt(n), 0);
export const ZERO: Decimal = { c: 0n, s: 0 };

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.s, b.s);
  return [a.c * pow10(scale - a.s), b.c * pow10(scale - b.s), scale];
}

export function add(a: Decimal, b: Decimal): Decimal { const [x, y, s] = align(a, b); return normalize(x + y, s); }
export function subtract(a: Decimal, b: Decimal): Decimal { const [x, y, s] = align(a, b); return normalize(x - y, s); }
export function multiply(a: Decimal, b: Decimal): Decimal { return normalize(a.c * b.c, a.s + b.s); }
export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; }
export const isZero = (a: Decimal): boolean => a.c === 0n;
/** Exactly half of a value (used for the median of an even count); never rounds. */
export const half = (a: Decimal): Decimal => normalize(a.c * 5n, a.s + 1);

/** a / b to DIVISION_SCALE decimal places, round-half-to-even. Division by zero is the caller's decision (this returns null). */
export function divide(a: Decimal, b: Decimal): Decimal | null {
  if (b.c === 0n) return null;
  const numerator = a.c * pow10(b.s + DIVISION_SCALE);
  const denominator = b.c * pow10(a.s);
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator; const d = denominator < 0n ? -denominator : denominator;
  let q = n / d; const r = n % d;
  const twice = r * 2n;
  if (twice > d || (twice === d && q % 2n === 1n)) q += 1n;
  return normalize(negative ? -q : q, DIVISION_SCALE);
}

/** Canonical text: plain digits, no exponent, no trailing zeros, no "-0". Equal values give equal text. */
export function decimalToString(a: Decimal): string {
  const negative = a.c < 0n;
  const digits = (negative ? -a.c : a.c).toString().padStart(a.s + 1, '0');
  const whole = digits.slice(0, digits.length - a.s);
  const fraction = a.s > 0 ? `.${digits.slice(digits.length - a.s)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
