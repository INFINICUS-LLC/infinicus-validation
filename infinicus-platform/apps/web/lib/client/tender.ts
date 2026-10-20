/**
 * Tender entry for the counter (POS-5). The cashier chooses how the customer pays; the server computes what is applied and the change. The counter
 * only checks what it can check locally (a clear number, enough cash) so a typo is caught before the request, and shows a CHANGE PREVIEW that is
 * labelled as one: the authoritative change is the one the server returns after completion.
 */
import { minorUnitsOf, toMinorUnits } from './currency';

export type TenderMethod = 'cash' | 'card' | 'other';
export const TENDER_LABELS: Readonly<Record<TenderMethod, string>> = { cash: 'Cash', card: 'Card', other: 'Other' };
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'card', 'other'];
export const REFERENCE_MAX = 64;

export interface TenderEntry { method: TenderMethod; amountText: string; reference: string }
export interface TenderPayment { method: TenderMethod; amountTendered: number; reference?: string }
export type TenderResult = { ok: true; payment: TenderPayment; changePreview: number } | { ok: false; reason: string };
export const MAX_TENDERS = 10;
export type TenderPlanResult = { ok: true; payments: TenderPayment[]; changePreview: number } | { ok: false; reason: string };

/** Advisory preview of the existing BO split-tender contract. BO independently validates and records all applied amounts and change. */
export function buildTenderPlan(entries: readonly TenderEntry[], orderTotal: number, currencyCode: string): TenderPlanResult {
  const exponent = minorUnitsOf(currencyCode);
  const total = toMinorUnits(orderTotal, currencyCode);
  if (exponent === null || total === null || !Number.isFinite(orderTotal) || orderTotal < 0 || !Number.isSafeInteger(total)
    || Math.abs(orderTotal * 10 ** exponent - total) > 1e-6) return { ok: false, reason: 'The order total cannot be represented safely in this currency.' };
  if (total === 0) return entries.length === 0 ? { ok: true, payments: [], changePreview: 0 }
    : { ok: false, reason: 'No payment is taken for a zero-total order.' };
  if (entries.length === 0 || entries.length > MAX_TENDERS) return { ok: false, reason: `Enter between 1 and ${MAX_TENDERS} payments.` };
  const factor = 10 ** exponent;
  let remaining = total;
  let change = 0;
  const payments: TenderPayment[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!TENDER_METHODS.includes(entry.method)) return { ok: false, reason: 'Choose cash, card or other for each payment.' };
    if (remaining === 0) return { ok: false, reason: 'The total is already covered. Remove the extra payment.' };
    const reference = entry.reference.trim();
    if (reference.length > REFERENCE_MAX) return { ok: false, reason: `The reference is too long (at most ${REFERENCE_MAX} characters).` };
    if (looksLikeCardNumber(reference)) return { ok: false, reason: 'The reference looks like a card number. Enter a slip number only, never a card number.' };
    // Preserve the one-card/other shortcut. Split payments require an explicit amount on every row.
    const amount = entries.length === 1 && entry.method !== 'cash' && entry.amountText.trim() === '' ? orderTotal : parseMoneyText(entry.amountText);
    if (amount === null || amount <= 0) return { ok: false, reason: `Enter the amount received for payment ${index + 1}.` };
    const minor = toMinorUnits(amount, currencyCode);
    if (minor === null || !Number.isSafeInteger(minor) || Math.abs(amount * factor - minor) > 1e-6) {
      return { ok: false, reason: `${currencyCode} has ${exponent} decimal place${exponent === 1 ? '' : 's'}. Check payment ${index + 1}.` };
    }
    if (entry.method !== 'cash' && minor > remaining) return { ok: false, reason: `Payment ${index + 1} exceeds the amount still due. Only cash can include change.` };
    const applied = Math.min(minor, remaining);
    remaining -= applied;
    change += minor - applied;
    payments.push({ method: entry.method, amountTendered: amount, ...(reference ? { reference } : {}) });
  }
  if (remaining > 0) return { ok: false, reason: 'The payments do not cover the total. Add or adjust a payment.' };
  return { ok: true, payments, changePreview: change / factor };
}

/** 13 or more digits in a row, each pair optionally separated by one space or hyphen (the same rule as the server and the database). */
export function looksLikeCardNumber(text: string): boolean {
  let digits = 0;
  let separatorPending = false;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      digits += 1; separatorPending = false;
      if (digits >= 13) return true;
    } else if ((ch === ' ' || ch === '-') && digits > 0 && !separatorPending) {
      separatorPending = true;
    } else { digits = 0; separatorPending = false; }
  }
  return false;
}

/** A typed money amount: digits with an optional decimal part. Returns null for anything else. */
export function parseMoneyText(text: string): number | null {
  const t = text.trim();
  const [whole, fraction, ...rest] = t.split('.');
  if (rest.length > 0 || !/^\d{1,12}$/.test(whole)) return null;
  if (fraction !== undefined && !/^\d{1,4}$/.test(fraction)) return null;
  return Number(t);
}

/**
 * Build the single payment for an order. Card and other pay exactly the order total (the server's number); cash is typed and must be at least the total.
 * Decimal places beyond the currency are refused here too. The reference is optional and must not look like a card number.
 */
export function buildTender(entry: TenderEntry, orderTotal: number, currencyCode: string): TenderResult {
  const exponent = minorUnitsOf(currencyCode);
  const totalMinor = toMinorUnits(orderTotal, currencyCode);
  if (exponent === null || totalMinor === null) return { ok: false, reason: 'This currency is not supported for payments.' };
  const reference = entry.reference.trim();
  if (reference.length > REFERENCE_MAX) return { ok: false, reason: `The reference is too long (at most ${REFERENCE_MAX} characters).` };
  if (looksLikeCardNumber(reference)) return { ok: false, reason: 'The reference looks like a card number. Enter a slip number only, never a card number.' };
  const withReference = (payment: TenderPayment): TenderPayment => (reference ? { ...payment, reference } : payment);

  if (entry.method !== 'cash') {
    return { ok: true, payment: withReference({ method: entry.method, amountTendered: orderTotal }), changePreview: 0 };
  }
  const tendered = parseMoneyText(entry.amountText);
  if (tendered === null || tendered <= 0) return { ok: false, reason: 'Enter the cash received as a number, for example 20 or 7.500.' };
  const tenderedMinor = toMinorUnits(tendered, currencyCode);
  if (tenderedMinor === null || Math.abs(tendered * 10 ** exponent - tenderedMinor) > 1e-6) {
    return { ok: false, reason: `${currencyCode} has ${exponent} decimal place${exponent === 1 ? '' : 's'}. Check the amount.` };
  }
  if (tenderedMinor < totalMinor) return { ok: false, reason: 'The cash received is less than the total.' };
  return { ok: true, payment: withReference({ method: 'cash', amountTendered: tendered }), changePreview: (tenderedMinor - totalMinor) / 10 ** exponent };
}
