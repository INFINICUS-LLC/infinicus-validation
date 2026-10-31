/** BI-2-DEV-05: exact decimal arithmetic used by BI-10. Expected values were computed independently (Python decimal, 10 places, round-half-even). */
import { describe, expect, it } from 'vitest';
import { add, compare, decimalToString as str, divide, fromInteger, half, isZero, multiply, parseDecimal, subtract, toDecimal, ZERO, DIVISION_SCALE } from '../src/bi10/exactDecimal.js';

const d = (t: string) => parseDecimal(t)!;
const div = (a: string, b: string) => { const r = divide(d(a), d(b)); return r === null ? null : str(r); };

describe('parsing and canonical text', () => {
  it.each([
    ['0', '0'], ['-0', '0'], ['1.50', '1.5'], ['001.0', '1'], ['-0.05', '-0.05'], ['1e3', '1000'], ['1.5E2', '150'], ['2e-3', '0.002'], ['+7', '7'],
    ['123456789012345678901234567890.123456789', '123456789012345678901234567890.123456789'],
  ])('parses %s as %s', (input, expected) => { expect(str(d(input))).toBe(expected); });

  it.each(['', ' ', ' 1', '1 ', '1.', '.5', '--1', '1,5', 'abc', '1e', 'NaN', 'Infinity', '0x10', '1e999', '1_000'])('refuses %j', (input) => { expect(parseDecimal(input)).toBeNull(); });

  it('takes a JavaScript number by its shortest text (0.1 is 0.1) and refuses non-finite numbers, booleans, objects and padded text', () => {
    expect(str(toDecimal(0.1)!)).toBe('0.1');
    expect(str(toDecimal(1e21)!)).toBe('1000000000000000000000');
    expect(str(toDecimal(1e-7)!)).toBe('0.0000001');
    expect(str(toDecimal(-12.5)!)).toBe('-12.5');
    expect(str(toDecimal(5n)!)).toBe('5');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, true, null, undefined, {}, [], ' 1', '1 ']) expect(toDecimal(bad)).toBeNull();
  });
});

describe('exact add, subtract, multiply, compare', () => {
  it('0.1 + 0.2 is exactly 0.3 (the double result is 0.30000000000000004)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(str(add(d('0.1'), d('0.2')))).toBe('0.3');
  });

  it('115.4 - 115.3 is exactly 0.1 (the double result is 0.10000000000000853)', () => {
    expect(115.4 - 115.3).not.toBe(0.1);
    expect(str(subtract(d('115.4'), d('115.3')))).toBe('0.1');
  });

  it('sums beyond 2^53 stay exact', () => {
    expect(str(add(d('9007199254740993'), d('1')))).toBe('9007199254740994');
    expect(str(add(d('99999999999999999999.99'), d('0.01')))).toBe('100000000000000000000');
  });

  it('multiplies exactly and handles signs and zero', () => {
    expect(str(multiply(d('1.1'), d('1.1')))).toBe('1.21');
    expect(str(multiply(d('-2.5'), d('4')))).toBe('-10');
    expect(str(multiply(d('0'), d('123.456')))).toBe('0');
  });

  it('compares values of different scales and signs', () => {
    expect(compare(d('1.0'), d('1'))).toBe(0);
    expect(compare(d('0.30'), d('0.3'))).toBe(0);
    expect(compare(d('-1'), d('0'))).toBe(-1);
    expect(compare(d('10.000000001'), d('10'))).toBe(1);
    expect(isZero(ZERO)).toBe(true); expect(isZero(d('0.0'))).toBe(true); expect(isZero(d('0.1'))).toBe(false);
  });

  it('halves exactly and never rounds', () => {
    expect(str(half(d('0.3')))).toBe('0.15'); expect(str(half(d('1')))).toBe('0.5'); expect(str(half(d('0.0000000001')))).toBe('0.00000000005');
  });
});

describe('division (the only rounding: 10 places, half to even)', () => {
  it('uses ten decimal places', () => { expect(DIVISION_SCALE).toBe(10); });
  it.each([
    ['1', '3', '0.3333333333'], ['2', '3', '0.6666666667'], ['-1', '3', '-0.3333333333'], ['7', '-3', '-2.3333333333'], ['-6', '-3', '2'], ['1', '8', '0.125'],
    ['115.3', '115.4', '0.9991334489'], ['11530', '115.4', '99.9133448873'], ['0', '5', '0'], ['5', '0.5', '10'],
  ])('%s / %s = %s', (a, b, expected) => { expect(div(a, b)).toBe(expected); });

  it('rounds an exact tie to the even digit', () => {
    expect(div('1', '2048')).toBe('0.0004882812'); // 0.00048828125 -> ...12 (2 is even)
    expect(div('3', '2048')).toBe('0.0014648438'); // 0.00146484375 -> ...38 (7 is odd, rounds up)
  });

  it('division by zero is not a number: it returns null', () => { expect(div('1', '0')).toBeNull(); expect(divide(fromInteger(0), ZERO)).toBeNull(); });
});

describe('canonical text', () => {
  it('has no exponent, no trailing zeros and no negative zero; equal values give equal text', () => {
    expect(str(d('0.000'))).toBe('0'); expect(str(d('-0.000'))).toBe('0'); expect(str(subtract(d('1'), d('1')))).toBe('0');
    expect(str(d('100'))).toBe('100'); expect(str(d('0.10'))).toBe('0.1'); expect(str(d('-0.001'))).toBe('-0.001');
    expect(str(d('1e-10'))).toBe('0.0000000001');
  });
});
