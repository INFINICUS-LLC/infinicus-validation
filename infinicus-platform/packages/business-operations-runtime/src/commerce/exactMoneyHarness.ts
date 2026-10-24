import { minorUnitsOf } from '@infinicus/database';

/** Synthetic mathematics only; these identifiers are alternatives, not approved tax rules. */
export type HarnessRoundingMode = 'HALF_AWAY_FROM_ZERO' | 'TIES_TO_EVEN';
export interface Rational { readonly numerator: bigint; readonly denominator: bigint }
const MAX_DIGITS = 38;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;

export class HarnessInputError extends Error {
  constructor(message: string) { super(message); this.name = 'HarnessInputError'; }
}

const bounded = (value: bigint): bigint => {
  if (value.toString().replace('-', '').length > MAX_DIGITS) throw new HarnessInputError('arithmetic exceeds synthetic harness limit');
  return value;
};
const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a; let y = b;
  while (y !== 0n) { const next = x % y; x = y; y = next; }
  return x === 0n ? 1n : x;
};

export function minorInteger(value: string): bigint {
  if (typeof value !== 'string' || !INTEGER.test(value) || value.replace('-', '').length > MAX_DIGITS)
    throw new HarnessInputError('amount must be a bounded signed integer minor-unit string');
  return BigInt(value);
}

export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new HarnessInputError('division by zero');
  const sign = denominator < 0n ? -1n : 1n;
  const factor = gcd(numerator, denominator < 0n ? -denominator : denominator);
  return { numerator: bounded(numerator / factor * sign), denominator: bounded(denominator / factor * sign) };
}
export const addRational = (a: Rational, b: Rational): Rational =>
  rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export const multiplyRational = (a: Rational, b: Rational): Rational =>
  rational(a.numerator * b.numerator, a.denominator * b.denominator);
export const divideRational = (a: Rational, b: Rational): Rational =>
  rational(a.numerator * b.denominator, a.denominator * b.numerator);

export function roundRational(value: Rational, mode: HarnessRoundingMode): bigint {
  if (mode !== 'HALF_AWAY_FROM_ZERO' && mode !== 'TIES_TO_EVEN') throw new HarnessInputError('unknown rounding mode');
  const normalized = rational(value.numerator, value.denominator);
  const negative = normalized.numerator < 0n;
  const abs = negative ? -normalized.numerator : normalized.numerator;
  const whole = abs / normalized.denominator;
  const remainder = abs % normalized.denominator;
  const doubled = remainder * 2n;
  const up = doubled > normalized.denominator || (doubled === normalized.denominator &&
    (mode === 'HALF_AWAY_FROM_ZERO' || whole % 2n === 1n));
  return bounded((negative ? -1n : 1n) * (whole + (up ? 1n : 0n)));
}

/** Input scale is significant: 0.1250 has four fractional digits. */
export function quantityRational(value: string, maxFractionDigits: number): Rational {
  if (!Number.isSafeInteger(maxFractionDigits) || maxFractionDigits < 0 || maxFractionDigits > 4)
    throw new HarnessInputError('unsupported UOM precision');
  if (typeof value !== 'string' || value.length > MAX_DIGITS + 5)
    throw new HarnessInputError('quantity must be a positive bounded decimal string');
  const parts = value.split('.');
  if (parts.length > 2 || !INTEGER.test(parts[0]) || parts[0].startsWith('-') ||
      (parts.length === 2 && !/^\d{1,4}$/.test(parts[1])))
    throw new HarnessInputError('quantity must be a positive bounded decimal string');
  const [whole, fraction = ''] = parts;
  if (fraction.length > maxFractionDigits) throw new HarnessInputError('quantity exceeds UOM precision');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = minorInteger(whole) * denominator + BigInt(fraction || '0');
  if (numerator <= 0n) throw new HarnessInputError('quantity must be positive');
  return rational(numerator, denominator);
}

export function validateHarnessCurrency(code: string, exponent: number): void {
  const known = minorUnitsOf(code);
  if (known === null || !Number.isSafeInteger(exponent) || exponent !== known)
    throw new HarnessInputError('unsupported or mismatched currency precision');
}
