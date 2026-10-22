/** NEW-BI-01: exact money arithmetic and UTC calendar arithmetic (pure, no database). */
import { describe, expect, it } from 'vitest';
import { divRound, formatMoney, MoneyFormatError, parseMoney, percent, roundToExponent } from '../src/financial/money.js';
import { bucketStart, buckets, fromDayNumber, isRealDate, previousRange, rangeDays, toDayNumber } from '../src/financial/periods.js';

describe('money is exact decimal arithmetic', () => {
  it('parses and formats decimals without any float', () => {
    expect(parseMoney('0')).toBe(0n);
    expect(parseMoney('12.5')).toBe(125_000n);
    expect(parseMoney('-0.0001')).toBe(-1n);
    expect(parseMoney('99999999999999.9999')).toBe(999_999_999_999_999_999n);
    expect(formatMoney(125_000n, 2)).toBe('12.50');
    expect(formatMoney(125_000n, 3)).toBe('12.500');
    expect(formatMoney(120_000n, 0)).toBe('12');
    expect(formatMoney(125_001n, 2)).toBe('12.5001');          // sub-minor-unit precision is kept, never silently rounded away
    expect(formatMoney(-5_000n, 2)).toBe('-0.50');
    expect(formatMoney(0n, 2)).toBe('0.00');
  });

  it('refuses anything that is not a plain decimal with at most 4 decimals', () => {
    for (const bad of ['', ' 1', '1e3', 'NaN', 'Infinity', '1.23456', '--1', '1,5', '.5', '5.', '0x10']) expect(() => parseMoney(bad), bad).toThrow(MoneyFormatError);
  });

  it('is exact where floating point is not: 0.1 + 0.2 and a long sum', () => {
    expect(parseMoney('0.1') + parseMoney('0.2')).toBe(parseMoney('0.3'));
    let total = 0n; for (let i = 0; i < 10_000; i += 1) total += parseMoney('0.1');
    expect(formatMoney(total, 2)).toBe('1000.00');
  });

  it('divides and rounds half away from zero in both signs', () => {
    expect(divRound(5n, 2n)).toBe(3n); expect(divRound(-5n, 2n)).toBe(-3n); expect(divRound(5n, -2n)).toBe(-3n); expect(divRound(4n, 3n)).toBe(1n); expect(divRound(-4n, 3n)).toBe(-1n);
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });

  it('percentages have 2 decimals, half away from zero, and keep the sign', () => {
    expect(percent(parseMoney('1'), parseMoney('3'))).toBe('33.33');
    expect(percent(parseMoney('2'), parseMoney('3'))).toBe('66.67');
    expect(percent(parseMoney('-1'), parseMoney('3'))).toBe('-33.33');
    expect(percent(parseMoney('1'), parseMoney('-4'))).toBe('25.00');   // the base is its magnitude: +1 on a -4 base is +25%
    expect(percent(parseMoney('0.5'), parseMoney('100'))).toBe('0.50');
    expect(percent(parseMoney('0.0005'), parseMoney('100'))).toBe('0.00');   // below the 2-decimal resolution
  });

  it('rounds to a currency minor unit', () => {
    expect(roundToExponent(parseMoney('10.005'), 2)).toBe(parseMoney('10.01'));
    expect(roundToExponent(parseMoney('10.004'), 2)).toBe(parseMoney('10.00'));
    expect(roundToExponent(parseMoney('10.5'), 0)).toBe(parseMoney('11'));
    expect(roundToExponent(parseMoney('10.0005'), 3)).toBe(parseMoney('10.001'));
    expect(roundToExponent(parseMoney('-10.005'), 2)).toBe(parseMoney('-10.01'));
  });
});

describe('UTC calendar arithmetic', () => {
  it('validates real dates only', () => {
    for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31']) expect(isRealDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-01-01', '2026-1-1', '']) expect(isRealDate(bad), bad).toBe(false);
  });

  it('round-trips day numbers across leap days and year ends', () => {
    for (const d of ['1970-01-01', '2024-02-29', '2026-12-31', '2027-01-01']) expect(fromDayNumber(toDayNumber(d))).toBe(d);
    expect(toDayNumber('2027-01-01') - toDayNumber('2026-12-31')).toBe(1);
    expect(toDayNumber('2024-03-01') - toDayNumber('2024-02-28')).toBe(2);
  });

  it('counts inclusive days and builds the immediately preceding period of equal length', () => {
    expect(rangeDays({ from: '2026-03-01', to: '2026-03-31' })).toBe(31);
    expect(rangeDays({ from: '2026-03-05', to: '2026-03-05' })).toBe(1);
    expect(previousRange({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-01-29', to: '2026-02-28' });
    expect(previousRange({ from: '2026-03-05', to: '2026-03-05' })).toEqual({ from: '2026-03-04', to: '2026-03-04' });
    expect(previousRange({ from: '2024-03-01', to: '2024-03-10' })).toEqual({ from: '2024-02-20', to: '2024-02-29' });   // across a leap day
  });

  it('starts weeks on Monday and months on the 1st', () => {
    expect(bucketStart('2026-10-21', 'week')).toBe('2026-10-19');   // a Wednesday
    expect(bucketStart('2026-10-19', 'week')).toBe('2026-10-19');   // the Monday
    expect(bucketStart('2026-10-25', 'week')).toBe('2026-10-19');   // the Sunday
    expect(bucketStart('2026-10-21', 'month')).toBe('2026-10-01');
    expect(bucketStart('2026-10-21', 'day')).toBe('2026-10-21');
  });

  it('tiles a range with no gap and no overlap, clipping the first and last bucket to the range', () => {
    const range = { from: '2026-10-21', to: '2026-11-04' };
    for (const granularity of ['day', 'week', 'month'] as const) {
      const tiles = buckets(range, granularity);
      expect(tiles[0].start).toBe(range.from);
      expect(tiles.at(-1)!.end).toBe(range.to);
      for (let i = 1; i < tiles.length; i += 1) expect(toDayNumber(tiles[i].start)).toBe(toDayNumber(tiles[i - 1].end) + 1);
      expect(tiles.reduce((n, b) => n + toDayNumber(b.end) - toDayNumber(b.start) + 1, 0)).toBe(rangeDays(range));
    }
    expect(buckets(range, 'week').map((b) => [b.start, b.end])).toEqual([['2026-10-21', '2026-10-25'], ['2026-10-26', '2026-11-01'], ['2026-11-02', '2026-11-04']]);
    expect(buckets(range, 'month').map((b) => [b.start, b.end])).toEqual([['2026-10-21', '2026-10-31'], ['2026-11-01', '2026-11-04']]);
  });

  it('handles a December to January month boundary and a single-day range', () => {
    expect(buckets({ from: '2026-12-30', to: '2027-01-02' }, 'month').map((b) => [b.start, b.end])).toEqual([['2026-12-30', '2026-12-31'], ['2027-01-01', '2027-01-02']]);
    expect(buckets({ from: '2026-10-21', to: '2026-10-21' }, 'week')).toEqual([{ start: '2026-10-21', end: '2026-10-21' }]);
  });
});
