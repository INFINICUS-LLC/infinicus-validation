/**
 * Calendar arithmetic for financial reports (NEW-BI-01). Pure, UTC, on `YYYY-MM-DD` strings through integer day numbers, so it never depends on the machine's
 * time zone or on daylight saving. Weeks start on Monday (ISO); months are calendar months.
 */
import type { FinancialDateRange, TrendGranularity } from '@infinicus/handoff-contracts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export const toDayNumber = (isoDate: string): number => Math.floor(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / MS_PER_DAY);
export const fromDayNumber = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;   // toISOString() throws on an invalid date, hence the guard
}

export const rangeDays = (range: FinancialDateRange): number => toDayNumber(range.to) - toDayNumber(range.from) + 1;

/** The period of equal length that ends the day before `range` starts. */
export function previousRange(range: FinancialDateRange): FinancialDateRange {
  const length = rangeDays(range);
  const start = toDayNumber(range.from);
  return { from: fromDayNumber(start - length), to: fromDayNumber(start - 1) };
}

/** The first day of the bucket that contains `date`. */
export function bucketStart(date: string, granularity: TrendGranularity): string {
  if (granularity === 'day') return date;
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  const day = toDayNumber(date);
  const weekday = (day + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
  return fromDayNumber(day - weekday);
}

function nextBucketStart(start: string, granularity: TrendGranularity): string {
  if (granularity === 'day') return fromDayNumber(toDayNumber(start) + 1);
  if (granularity === 'week') return fromDayNumber(toDayNumber(start) + 7);
  const year = Number(start.slice(0, 4)); const month = Number(start.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

export interface Bucket { start: string; end: string }

/**
 * The buckets that tile `range`, in order. The first and last bucket are CLIPPED to the range (a partial first week keeps its Monday-based identity through
 * `start` being the range start, so no figure from outside the range can enter a bucket).
 */
export function buckets(range: FinancialDateRange, granularity: TrendGranularity): Bucket[] {
  const out: Bucket[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    const natural = bucketStart(cursor, granularity);
    const nextNatural = nextBucketStart(natural, granularity);
    const end = fromDayNumber(toDayNumber(nextNatural) - 1);
    out.push({ start: cursor, end: end < range.to ? end : range.to });
    cursor = nextNatural;
  }
  return out;
}
