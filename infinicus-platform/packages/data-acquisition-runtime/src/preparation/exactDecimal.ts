/**
 * R-01A-R2 (F1): exact decimal handling for prepared numeric fields.
 *
 * The prepared record carries a JavaScript number (the BO intake contract), so a decimal may only be accepted when that number denotes exactly the
 * decimal that was supplied. Acceptance is decided per value against the field's column contract (precision, scale) - never by a blanket digit cap -
 * and a value that would have to be rounded, truncated or approximated is refused with a reason instead.
 */

export interface DecimalContract {
  /** Total significant digits the column holds, e.g. numeric(18,4) -> 18. */
  precision: number;
  /** Digits after the decimal point, e.g. numeric(18,4) -> 4. */
  scale: number;
}

export type DecimalProblem = 'invalid_format' | 'exceeds_scale' | 'out_of_range' | 'not_exact';

export type ExactDecimalResult = { ok: true; value: number; canonical: string } | { ok: false; problem: DecimalProblem };

const isDigits = (text: string): boolean => text.length > 0 && [...text].every((ch) => ch >= '0' && ch <= '9');

/** Plain decimal syntax only: optional sign, digits, optional '.digits'. No exponent, separators, hex, or bare '.5' / '5.'. */
function splitPlainDecimal(text: string): { negative: boolean; integer: string; fraction: string } | null {
  const negative = text.startsWith('-');
  const unsigned = negative || text.startsWith('+') ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const integer = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (!isDigits(integer) || (dot !== -1 && !isDigits(fraction))) return null;
  return { negative, integer, fraction };
}

export function exactDecimal(input: string | number, contract: DecimalContract): ExactDecimalResult {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, problem: 'invalid_format' };
    text = String(input);
    // String() switches to exponent form at >= 1e21 and < 1e-6; both are outside any numeric(18,4) column.
    if (/e/i.test(text)) return { ok: false, problem: Math.abs(input) >= 1 ? 'out_of_range' : 'exceeds_scale' };
  } else {
    text = input;
  }
  const parts = splitPlainDecimal(text);
  if (!parts) return { ok: false, problem: 'invalid_format' };

  const negative = parts.negative;
  const integerDigits = parts.integer.replace(/^0+/, '');
  const fractionDigits = parts.fraction.replace(/0+$/, '');
  if (fractionDigits.length > contract.scale) return { ok: false, problem: 'exceeds_scale' };
  if (integerDigits.length > contract.precision - contract.scale) return { ok: false, problem: 'out_of_range' };

  const isZero = integerDigits === '' && fractionDigits === '';
  const canonical = `${negative && !isZero ? '-' : ''}${integerDigits === '' ? '0' : integerDigits}${fractionDigits === '' ? '' : `.${fractionDigits}`}`;
  const value = Number(canonical);
  // The shortest round-trip rendering of the number must be the decimal itself, otherwise the double is only an approximation of it.
  if (String(value) !== canonical) return { ok: false, problem: 'not_exact' };
  return { ok: true, value, canonical };
}
