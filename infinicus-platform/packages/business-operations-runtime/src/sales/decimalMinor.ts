/**
 * Exact conversion of a database decimal STRING (numeric text such as "1234.5600") to integer minor units of a currency, with no floating point.
 * A value with a non-zero digit beyond the currency's minor unit is not representable and is refused, never rounded: a report must not silently
 * re-state money. The result must be a safe integer.
 */
export class AmountNotRepresentableError extends Error {
  constructor(readonly amount: string, readonly exponent: number) {
    super(`amount ${amount} is not an exact multiple of the currency minor unit (${exponent} decimal places) or is too large`);
    this.name = 'AmountNotRepresentableError';
  }
}

export function decimalToMinorUnits(amount: string, exponent: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (m === null || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new AmountNotRepresentableError(amount, exponent);
  const [, sign, whole, fraction = ''] = m;
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  if (/[1-9]/.test(fraction.slice(exponent))) throw new AmountNotRepresentableError(amount, exponent);
  const magnitude = Number(`${whole}${kept}`);
  if (!Number.isSafeInteger(magnitude)) throw new AmountNotRepresentableError(amount, exponent);
  return sign === '-' && magnitude !== 0 ? -magnitude : magnitude;
}
