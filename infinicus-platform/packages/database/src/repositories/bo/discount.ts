/**
 * Discount planning (POS-6b): turn a requested discount into the line to store. A discount is a SIGNED line of the order (item_type 'discount',
 * quantity 1, negative unit price and line total), so the order total stays the plain sum of its lines and every existing report keeps working.
 * Pure and exact: all comparisons are in integer minor units of the order's currency (KWD fils, USD cents, JPY yen).
 *
 * Rules:
 *   - the amount is positive and exact in the currency (no hidden rounding);
 *   - a discount can never exceed what the order currently totals, so the total never goes below zero;
 *   - at most MAX_DISCOUNTS_PER_ORDER discount lines per order;
 *   - the reason is optional text, at most DISCOUNT_REASON_MAX characters, and becomes part of the line description.
 */
import { minorUnitsOf, roundToCurrency, UnsupportedCurrencyError } from '../../currency/minorUnits.js';

export const MAX_DISCOUNTS_PER_ORDER = 5;
export const DISCOUNT_REASON_MAX = 200;

/** A refused discount. The API maps this name to 400. */
export class DiscountError extends Error {
  constructor(reason: string) {
    super(`Discount invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

export interface PlannedDiscount {
  description: string;
  quantity: 1;
  /** Negative: the amount taken off the order. */
  unitPrice: number;
  lineTotal: number;
}

const toMinor = (amount: number, exponent: number): number => Math.round(amount * 10 ** exponent);

export function planDiscount(
  currentTotal: number,
  currencyCode: string,
  amount: number,
  reason: string | null | undefined,
  existingDiscountLines: number,
): PlannedDiscount {
  const exponent = minorUnitsOf(currencyCode);
  if (exponent === null) throw new UnsupportedCurrencyError(currencyCode);
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new DiscountError('the amount must be a positive number');
  if (roundToCurrency(amount, currencyCode) !== amount) throw new DiscountError(`the amount has more decimal places than ${currencyCode} allows`);
  if (roundToCurrency(currentTotal, currencyCode) !== currentTotal) throw new DiscountError(`the order total has more decimal places than ${currencyCode} allows`);
  if (existingDiscountLines >= MAX_DISCOUNTS_PER_ORDER) throw new DiscountError(`at most ${MAX_DISCOUNTS_PER_ORDER} discounts per order`);
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length > DISCOUNT_REASON_MAX) throw new DiscountError(`the reason is too long (at most ${DISCOUNT_REASON_MAX} characters)`);
  if (toMinor(amount, exponent) > toMinor(currentTotal, exponent)) {
    throw new DiscountError(`the discount cannot be more than the order total (${currentTotal} ${currencyCode})`);
  }
  return { description: text ? `Discount: ${text}` : 'Discount', quantity: 1, unitPrice: -amount, lineTotal: -amount };
}
