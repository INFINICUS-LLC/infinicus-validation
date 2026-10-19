/**
 * POS-1.6: currency minor units (decimal places). Pure tests: no database. Also keeps the browser copy of the table identical to the server one.
 */
import { describe, it, expect } from 'vitest';
import { minorUnitsOf, roundToCurrency, UnsupportedCurrencyError } from '../src/currency/minorUnits.js';
import { minorUnitsOf as webMinorUnitsOf, formatMoney } from '../../../apps/web/lib/client/currency';

describe('currency minor units (POS-1.6)', () => {
  it('knows the decimal places of the currencies that matter, including KWD (3), JPY (0) and CLF (4)', () => {
    expect(minorUnitsOf('USD')).toBe(2);
    expect(minorUnitsOf('EUR')).toBe(2);
    expect(minorUnitsOf('KWD')).toBe(3);
    expect(minorUnitsOf('BHD')).toBe(3);
    expect(minorUnitsOf('OMR')).toBe(3);
    expect(minorUnitsOf('JPY')).toBe(0);
    expect(minorUnitsOf('KRW')).toBe(0);
    expect(minorUnitsOf('CLF')).toBe(4);
  });

  it('fails closed for anything that is not a known code (no silent two-decimal default)', () => {
    for (const code of ['ZZZ', 'usd', 'US', '', 'USDX', 'XXX']) expect(minorUnitsOf(code), code).toBeNull();
    expect(() => roundToCurrency(1, 'ZZZ')).toThrow(UnsupportedCurrencyError);
    expect(new UnsupportedCurrencyError('ZZZ').name).toBe('ConflictError');   // the API maps this name to 409
  });

  it('rounds to the currency, half away from zero, without binary-float surprises', () => {
    expect(roundToCurrency(0.125, 'KWD')).toBe(0.125);
    expect(roundToCurrency(0.1255, 'KWD')).toBe(0.126);
    expect(roundToCurrency(3 * 0.125, 'KWD')).toBe(0.375);
    expect(roundToCurrency(1.005, 'USD')).toBe(1.01);
    expect(roundToCurrency(2.675, 'USD')).toBe(2.68);
    expect(roundToCurrency(0.125, 'USD')).toBe(0.13);
    expect(roundToCurrency(2.5, 'JPY')).toBe(3);
    expect(roundToCurrency(0.49, 'JPY')).toBe(0);
    expect(roundToCurrency(12.34567, 'CLF')).toBe(12.3457);
    expect(roundToCurrency(-1.005, 'USD')).toBe(-1.01);
    expect(roundToCurrency(0, 'USD')).toBe(0);
    expect(roundToCurrency(Number.NaN, 'USD')).toBe(0);
    expect(roundToCurrency(Number.POSITIVE_INFINITY, 'USD')).toBe(0);
  });

  it('the browser table is identical to the server table for every possible three-letter code', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let known = 0;
    for (const a of letters) for (const b of letters) for (const c of letters) {
      const code = `${a}${b}${c}`;
      expect(webMinorUnitsOf(code), code).toBe(minorUnitsOf(code));
      if (minorUnitsOf(code) !== null) known += 1;
    }
    expect(known).toBeGreaterThan(150);
  });

  it('display shows exactly the currency decimals, or 2 to 4 decimals when the currency is unknown, and never rounds 0.125 up', () => {
    expect(formatMoney(0.125, 'KWD')).toBe('0.125');
    expect(formatMoney(3.5, 'KWD')).toBe('3.500');
    expect(formatMoney(3.5, 'USD')).toBe('3.50');
    expect(formatMoney(1234.5, 'USD')).toBe('1,234.50');
    expect(formatMoney(300, 'JPY')).toBe('300');
    expect(formatMoney(0.125)).toBe('0.125');
    expect(formatMoney(0.125, null)).toBe('0.125');
    expect(formatMoney(3.5)).toBe('3.50');
    expect(formatMoney(0.125, 'ZZZ')).toBe('0.125');
  });
});
