/**
 * The sales report screen's pure logic (BI-WEB-1): the response contract (a copy of the BI-SALES-1 API shape, validated on every read), the explicit
 * period, and exact display of integer minor units. No React, no network: the page wraps it. Everything shown comes from the server report; this file
 * computes no totals. Money arrives as integers in minor units with the currency's exponent and is displayed by digit manipulation, never by float math.
 */
import { z } from 'zod';
import { minorUnitsOf } from './currency';

const count = z.number().int().nonnegative();
const money = z.number().int();
const point = z.object({
  completedOrders: count, voidedOrders: count, openOrders: count, otherStatusOrders: count,
  grossMinor: money, discountMinor: money, netMinor: money,
});
export const salesReportResponseSchema = z.union([
  z.object({
    outcome: z.literal('REPORT'),
    report: z.object({
      businessId: z.string().uuid(),
      period: z.object({ from: z.string(), to: z.string(), days: z.number().int().positive(), basis: z.literal('order_date'), inclusive: z.literal(true) }),
      source: z.object({ layer: z.literal('BO'), definition: z.string() }),
      currencies: z.array(z.object({
        currency: z.object({ code: z.string(), minorUnitExponent: z.number().int().min(0).max(4) }),
        totals: point.extend({ averageOrderNetMinor: money.nullable(), reconciles: z.boolean() }),
        daily: z.array(point.extend({ date: z.string() })),
      })),
    }),
  }),
  z.object({ outcome: z.literal('NOT_AVAILABLE'), code: z.string(), detail: z.string() }),
]);
export type SalesReportResponse = z.infer<typeof salesReportResponseSchema>;
export type SalesReport = Extract<SalesReportResponse, { outcome: 'REPORT' }>['report'];
export type SalesCurrencySection = SalesReport['currencies'][number];

export const MAX_REPORT_DAYS = 366;
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A UTC day number for a real YYYY-MM-DD calendar date, else null. */
export function dayNumber(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms / DAY_MS : null;
}
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The device's local calendar date as YYYY-MM-DD (the day the person is looking at), independent of the time zone offset arithmetic. */
export function localDate(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export type PeriodPreset = 'today' | 'last7' | 'last30';
/** A period ending on `today` (inclusive): 1, 7 or 30 days. */
export function presetPeriod(preset: PeriodPreset, today: string): { from: string; to: string } {
  const end = dayNumber(today);
  if (end === null) throw new RangeError('today must be a YYYY-MM-DD date');
  const days = preset === 'today' ? 1 : preset === 'last7' ? 7 : 30;
  return { from: dateOf(end - (days - 1)), to: today };
}

/** The reason a period cannot be requested, or null when it can. The server enforces the same rules; this only saves a round trip. */
export function periodProblem(from: string, to: string): string | null {
  const f = dayNumber(from);
  const t = dayNumber(to);
  if (f === null) return 'Choose a valid start date.';
  if (t === null) return 'Choose a valid end date.';
  if (t < f) return 'The end date cannot be before the start date.';
  if (t - f + 1 > MAX_REPORT_DAYS) return `The period can cover at most ${MAX_REPORT_DAYS} days.`;
  return null;
}

export const salesReportPath = (businessId: string, from: string, to: string): string =>
  `/v1/businesses/${encodeURIComponent(businessId)}/bi/sales-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/**
 * An integer amount in minor units for display, exact: 4750 at exponent 3 is "4.750", -250 at 2 is "-2.50", 1500 at 0 is "1,500". Returns null (the page
 * shows an error, never a guess) when the amount is not a safe integer or the server's exponent disagrees with the platform's currency table.
 */
export function formatMinor(minor: number, exponent: number, currencyCode: string): string | null {
  if (!Number.isSafeInteger(minor) || currencyScaleMismatch(exponent, currencyCode)) return null;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const factor = 10 ** exponent;                                   // 1, 10, 100, 1000 or 10000: exact in binary floating point
  const remainder = abs % factor;                                  // exact for safe integers
  const whole = (abs - remainder) / factor;                        // an exact division: the dividend is a multiple of the divisor
  const fraction = String(remainder).padStart(exponent, '0');
  const grouped = new Intl.NumberFormat('en', { useGrouping: true, maximumFractionDigits: 0 }).format(whole);
  return `${negative ? '-' : ''}${grouped}${exponent > 0 ? `.${fraction}` : ''}`;
}
function currencyScaleMismatch(exponent: number, currencyCode: string): boolean {
  return minorUnitsOf(currencyCode) !== exponent;
}

/** The share of the largest day, 0..100, for a simple bar (integer percent; 0 when the largest is 0). */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.round((value * 100) / max));
}
