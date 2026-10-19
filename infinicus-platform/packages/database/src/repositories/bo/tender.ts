/**
 * Tender planning (POS-5): turn the payments a cashier entered into the rows to store. Pure and exact: all arithmetic is in integer minor units of the
 * order's currency (KWD fils, USD cents, JPY yen), so there is no floating-point drift in change or in the applied total.
 *
 * Rules:
 *   - every amount is positive and exact in the currency (no hidden rounding);
 *   - the applied amounts add up to the order total exactly: not less (underpaid) and not more (overpaid);
 *   - only CASH may be tendered above what is still due, and the excess is returned as change; card and other must not exceed what is due;
 *   - a payment after the order is fully paid is refused;
 *   - an order with a zero total takes no payment; any other order needs at least one;
 *   - `reference` is an optional slip number, at most 64 characters, never a card number (13 or more digits, spaces/hyphens allowed, is refused).
 */
import { minorUnitsOf, roundToCurrency, UnsupportedCurrencyError } from '../../currency/minorUnits.js';

export type TenderMethod = 'cash' | 'card' | 'other';
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'card', 'other'];
export const MAX_PAYMENTS_PER_ORDER = 10;
export const PAYMENT_REFERENCE_MAX = 64;
/**
 * The same shape the database refuses (0203, `([0-9][ -]?){13,}`): 13 or more digits in a row, each pair optionally separated by ONE space or hyphen.
 * Written as a scan so the check cannot be slowed by a crafted string.
 */
export function looksLikeCardNumber(text: string): boolean {
  let digits = 0;
  let separatorPending = false;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      digits += 1;
      separatorPending = false;
      if (digits >= 13) return true;
    } else if ((ch === ' ' || ch === '-') && digits > 0 && !separatorPending) {
      separatorPending = true;
    } else {
      digits = 0;
      separatorPending = false;
    }
  }
  return false;
}

export interface PaymentInput {
  method: TenderMethod;
  /** What the customer handed over, in the order's currency. */
  amountTendered: number;
  reference?: string | null;
}

export interface PlannedPayment {
  position: number;
  method: TenderMethod;
  currencyCode: string;
  amountTendered: number;
  amountApplied: number;
  changeGiven: number;
  reference: string | null;
}

/** A refused payment. The API maps this name to 400. */
export class PaymentError extends Error {
  constructor(reason: string) {
    super(`Payment invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

const toMinor = (amount: number, exponent: number): number => Math.round(amount * 10 ** exponent);
const fromMinor = (minor: number, exponent: number): number => minor / 10 ** exponent;

export function planPayments(totalAmount: number, currencyCode: string, inputs: readonly PaymentInput[]): PlannedPayment[] {
  const exponent = minorUnitsOf(currencyCode);
  if (exponent === null) throw new UnsupportedCurrencyError(currencyCode);
  if (roundToCurrency(totalAmount, currencyCode) !== totalAmount) throw new PaymentError(`the order total has more decimal places than ${currencyCode} allows`);
  const totalMinor = toMinor(totalAmount, exponent);

  if (totalMinor === 0) {
    if (inputs.length > 0) throw new PaymentError('this order total is zero, so no payment is taken');
    return [];
  }
  if (inputs.length === 0) throw new PaymentError('a payment is required to complete this order');
  if (inputs.length > MAX_PAYMENTS_PER_ORDER) throw new PaymentError(`at most ${MAX_PAYMENTS_PER_ORDER} payments per order`);

  let remaining = totalMinor;
  const planned: PlannedPayment[] = [];
  for (const input of inputs) {
    if (!TENDER_METHODS.includes(input.method)) throw new PaymentError('the payment method must be cash, card or other');
    if (typeof input.amountTendered !== 'number' || !Number.isFinite(input.amountTendered) || input.amountTendered <= 0) {
      throw new PaymentError('the amount tendered must be a positive number');
    }
    if (roundToCurrency(input.amountTendered, currencyCode) !== input.amountTendered) {
      throw new PaymentError(`the amount tendered has more decimal places than ${currencyCode} allows`);
    }
    const trimmed = typeof input.reference === 'string' ? input.reference.trim() : '';
    if (trimmed.length > PAYMENT_REFERENCE_MAX) throw new PaymentError(`the reference is too long (at most ${PAYMENT_REFERENCE_MAX} characters)`);
    if (looksLikeCardNumber(trimmed)) throw new PaymentError('the reference looks like a card number; enter a slip number only, never a card number');
    if (remaining === 0) throw new PaymentError('the order is already fully paid; remove the extra payment');

    const tendered = toMinor(input.amountTendered, exponent);
    let applied: number;
    if (input.method === 'cash') {
      applied = Math.min(tendered, remaining);
    } else {
      if (tendered > remaining) throw new PaymentError(`a ${input.method} payment cannot be more than the amount still due (${fromMinor(remaining, exponent)} ${currencyCode})`);
      applied = tendered;
    }
    remaining -= applied;
    planned.push({
      position: planned.length + 1,
      method: input.method,
      currencyCode,
      amountTendered: fromMinor(tendered, exponent),
      amountApplied: fromMinor(applied, exponent),
      changeGiven: fromMinor(tendered - applied, exponent),
      reference: trimmed.length > 0 ? trimmed : null,
    });
  }
  if (remaining > 0) throw new PaymentError(`the payments are short by ${fromMinor(remaining, exponent)} ${currencyCode}`);
  return planned;
}
