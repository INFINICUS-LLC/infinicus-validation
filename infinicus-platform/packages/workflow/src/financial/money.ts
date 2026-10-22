/**
 * Exact money arithmetic for Business Intelligence (NEW-BI-01). Amounts are decimal STRINGS with at most 4 decimals (the storage precision of every money
 * column) held as BigInt hundredths-of-thousandths ("scale 4"). No floating point is used for money anywhere in the financial report, so a sum of thousands of
 * orders is exact and a result never depends on summation order. Division rounds half away from zero.
 */
export const SCALE = 4;
const FACTOR = 10_000n;
const DECIMAL = /^-?\d+(\.\d{1,4})?$/;

export class MoneyFormatError extends Error {
  constructor(value: string) {
    super(`not a decimal with at most ${SCALE} decimals: ${JSON.stringify(value)}`);
    this.name = 'MoneyFormatError';
  }
}

/** Parses a decimal string into scale-4 units. Throws MoneyFormatError for anything else (NaN, exponent, more than 4 decimals, empty). */
export function parseMoney(value: string): bigint {
  if (!DECIMAL.test(value)) throw new MoneyFormatError(value);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -units : units;
}

/** Formats scale-4 units with at least `minDecimals` decimals and no more than 4, trimming zeros beyond `minDecimals` (USD 12.50, KWD 12.500, JPY 12). */
export function formatMoney(units: bigint, minDecimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  let fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
  while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const text = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative && abs !== 0n ? `-${text}` : text;
}

/** Integer division rounding half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = n % d * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** `part / whole` as a percentage with 2 decimals (e.g. 12.35), half away from zero. `whole` must not be zero. */
export function percent(part: bigint, whole: bigint): string {
  const hundredths = divRound(part * 10_000n, whole < 0n ? -whole : whole);
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Rounds scale-4 units to a currency's minor units (`exponent` 0-4), half away from zero. */
export function roundToExponent(units: bigint, exponent: number): bigint {
  const step = 10n ** BigInt(SCALE - exponent);
  return divRound(units, step) * step;
}
