/**
 * Discount entry for the counter (POS-6b): what the cashier typed, checked locally before anything is sent. The server checks everything again and is the
 * only one that computes the new total; this only keeps obviously wrong entries from being sent. A discount is money off an OPEN order, never above the
 * order's current total, exact in the currency, and only owners and admins may give it (the server answers 403 to anyone else).
 */
import { minorUnitsOf, toMinorUnits } from './currency';
import { parseMoneyText } from './tender';

export const DISCOUNT_REASON_MAX = 200;
export interface DiscountEntry { amountText: string; reason: string }
export type DiscountResult = { ok: true; amount: number; reason: string | null } | { ok: false; reason: string };
export const NO_DISCOUNT: DiscountEntry = { amountText: '', reason: '' };

export function buildDiscount(entry: DiscountEntry, orderTotal: number, currencyCode: string): DiscountResult {
  const exponent = minorUnitsOf(currencyCode);
  const totalMinor = toMinorUnits(orderTotal, currencyCode);
  if (exponent === null || totalMinor === null) return { ok: false, reason: 'This currency is not supported for discounts.' };
  const reason = entry.reason.trim();
  if (reason.length > DISCOUNT_REASON_MAX) return { ok: false, reason: `The reason is too long (at most ${DISCOUNT_REASON_MAX} characters).` };
  const amount = parseMoneyText(entry.amountText);
  if (amount === null || amount <= 0) return { ok: false, reason: 'Enter the amount off as a number, for example 2 or 0.500.' };
  const minor = toMinorUnits(amount, currencyCode);
  if (minor === null || Math.abs(amount * 10 ** exponent - minor) > 1e-6) {
    return { ok: false, reason: `${currencyCode} has ${exponent} decimal place${exponent === 1 ? '' : 's'}. Check the amount.` };
  }
  if (minor > totalMinor) return { ok: false, reason: 'The discount cannot be more than the order total.' };
  return { ok: true, amount, reason: reason === '' ? null : reason };
}
