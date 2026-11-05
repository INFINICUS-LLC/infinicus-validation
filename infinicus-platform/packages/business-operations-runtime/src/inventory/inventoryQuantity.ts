/**
 * Exact inventory quantity arithmetic (POS2-04-S1). inventory_balances.quantity_on_hand and inventory_movements.quantity are numeric(18,4): at most four
 * decimal places and an absolute value below 10^14. Quantities here are held as exact decimals (BigInt over a power-of-ten scale), never as JavaScript
 * `Number` arithmetic: a quantity enters as exact decimal text, or as a number only through its shortest round-trip text (the value a person wrote, the
 * convention of the BO decimal utility), and a value that cannot be stored exactly at the approved scale is REFUSED, never rounded. Pure: no I/O, no clock.
 */
import { Decimal } from '../inventory-policy/decimal.js';

export const INVENTORY_QUANTITY_MAX_DECIMALS = 4;
/** numeric(18,4): strictly less than 10^14. The largest representable quantity is 99999999999999.9999. */
export const INVENTORY_QUANTITY_EXCLUSIVE_MAX = Decimal.of(10n ** 14n);
export const INVENTORY_QUANTITY_MAXIMUM_TEXT = '99999999999999.9999';

export type MovementType = 'receipt' | 'issue' | 'transfer_in' | 'transfer_out' | 'adjustment' | 'return' | 'write_off' | 'cycle_count';
export type QuantityProblem = 'not_a_decimal' | 'excess_scale' | 'out_of_range' | 'too_long' | 'unsafe_number';

/** The longest valid text is a sign, 14 digits, a point and 4 digits (20 characters); trailing zeros are tolerated. Longer text is refused BEFORE any parsing (no input amplification). */
export const INVENTORY_QUANTITY_TEXT_MAX_LENGTH = 64;
/** A double reproduces any decimal of up to 15 significant digits; beyond that its text is an approximation of what was written, so a number with more is refused (pass exact decimal text). */
export const INVENTORY_QUANTITY_NUMBER_MAX_SIGNIFICANT_DIGITS = 15;

/** Plain decimal text only: optional sign, digits, optional fraction. No exponent, spaces or separators. Written without nested quantifiers. */
function isPlainDecimalText(text: string): boolean {
  const body = text.startsWith('-') || text.startsWith('+') ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? '' : body.slice(dot + 1);
  const digits = (s: string) => s.length > 0 && [...s].every((ch) => ch >= '0' && ch <= '9');
  return digits(whole) && (dot === -1 || digits(fraction));
}

function significantDigits(d: Decimal): number {
  const digits = d.toString().replace('-', '').replace('.', '');
  let i = 0;
  while (i < digits.length && digits[i] === '0') i += 1;
  return digits.length - i;
}

function fractionDigits(d: Decimal): number {
  const text = d.toString();   // trailing fractional zeros are removed, so 0.3000 and 0.30000 are the same value
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** An exact movement quantity, or why it cannot be one. Never rounds; never converts a text quantity through `Number`. */
export function parseMovementQuantity(value: unknown): { ok: true; value: Decimal } | { ok: false; problem: QuantityProblem } {
  let d: Decimal | null = null;
  if (typeof value === 'string') {
    if (value.length > INVENTORY_QUANTITY_TEXT_MAX_LENGTH) return { ok: false, problem: 'too_long' };
    d = isPlainDecimalText(value) ? Decimal.parse(value) : null;
  } else if (typeof value === 'number') d = Decimal.fromNumber(value);   // finite numbers only, through their shortest round-trip text
  if (d === null) return { ok: false, problem: 'not_a_decimal' };
  if (d.abs().gte(INVENTORY_QUANTITY_EXCLUSIVE_MAX)) return { ok: false, problem: 'out_of_range' };
  if (fractionDigits(d) > INVENTORY_QUANTITY_MAX_DECIMALS) return { ok: false, problem: 'excess_scale' };
  // A number with more than 15 significant digits is already an approximation of what was written (12345678901234.5678 is the double 12345678901234.568), so it is refused, never taken as exact.
  if (typeof value === 'number' && significantDigits(d) > INVENTORY_QUANTITY_NUMBER_MAX_SIGNIFICANT_DIGITS) return { ok: false, problem: 'unsafe_number' };
  return { ok: true, value: d };
}

export function quantityProblemMessage(problem: QuantityProblem): string {
  switch (problem) {
    case 'not_a_decimal': return 'Inventory movement quantity must be a finite decimal.';
    case 'excess_scale': return `Inventory movement quantity must have at most ${INVENTORY_QUANTITY_MAX_DECIMALS} decimal places (it is never rounded).`;
    case 'out_of_range': return `Inventory movement quantity must have an absolute value below ${INVENTORY_QUANTITY_EXCLUSIVE_MAX.toString()}.`;
    case 'too_long': return `Inventory movement quantity text must be at most ${INVENTORY_QUANTITY_TEXT_MAX_LENGTH} characters.`;
    case 'unsafe_number': return `Inventory movement quantity given as a number must have at most ${INVENTORY_QUANTITY_NUMBER_MAX_SIGNIFICANT_DIGITS} significant digits; pass it as exact decimal text.`;
  }
}

/** The signed effect of a movement on quantity_on_hand, exact. Movement-type semantics are unchanged from the original writer. */
export function movementDelta(movementType: MovementType, quantity: Decimal): Decimal {
  const magnitude = quantity.abs();
  switch (movementType) {
    case 'receipt':
    case 'transfer_in':
    case 'return':
      return magnitude;
    case 'issue':
    case 'transfer_out':
    case 'write_off':
      return Decimal.of(0).sub(magnitude);
    case 'adjustment':
    case 'cycle_count':
      return quantity;
  }
}

/** The balance after a movement, or why it cannot be applied: it may not go negative (existing policy) and must stay inside numeric(18,4). */
export function nextOnHand(current: Decimal, delta: Decimal): { ok: true; value: Decimal } | { ok: false; reason: 'negative' | 'overflow'; value: Decimal } {
  const next = current.add(delta);
  if (next.isNegative()) return { ok: false, reason: 'negative', value: next };
  if (next.gte(INVENTORY_QUANTITY_EXCLUSIVE_MAX)) return { ok: false, reason: 'overflow', value: next };
  return { ok: true, value: next };
}
