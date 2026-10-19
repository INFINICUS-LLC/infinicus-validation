/**
 * POS-5: tender planning (pure; no database). Exact integer minor-unit arithmetic, per currency.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeCardNumber, planPayments, PaymentError } from '../src/repositories/bo/tender.js';
import { UnsupportedCurrencyError } from '../src/currency/minorUnits.js';

const cash = (amountTendered: number, reference?: string) => ({ method: 'cash' as const, amountTendered, reference });
const card = (amountTendered: number, reference?: string) => ({ method: 'card' as const, amountTendered, reference });

describe('tender planning (POS-5)', () => {
  it('cash above the total: applied = total, change = the rest', () => {
    expect(planPayments(4.5, 'USD', [cash(5)])).toEqual([
      { position: 1, method: 'cash', currencyCode: 'USD', amountTendered: 5, amountApplied: 4.5, changeGiven: 0.5, reference: null },
    ]);
  });

  it('is exact where floating point is not: 0.1 + 0.2, and three-decimal KWD change', () => {
    const p = planPayments(0.3, 'USD', [cash(0.1), cash(0.2)]);
    expect(p.map((x) => x.amountApplied)).toEqual([0.1, 0.2]);
    expect(planPayments(1.375, 'KWD', [cash(2)])[0]).toMatchObject({ amountApplied: 1.375, changeGiven: 0.625 });
    expect(planPayments(0.7, 'USD', [cash(1)])[0].changeGiven).toBe(0.3);
    expect(planPayments(300, 'JPY', [cash(500)])[0]).toMatchObject({ amountApplied: 300, changeGiven: 200 });
  });

  it('split tender: card then cash with change; positions run 1, 2, ...', () => {
    const p = planPayments(10, 'USD', [card(4, ' SLIP-1 '), cash(20)]);
    expect(p.map((x) => [x.position, x.method, x.amountApplied, x.changeGiven, x.reference])).toEqual([[1, 'card', 4, 0, 'SLIP-1'], [2, 'cash', 6, 14, null]]);
    expect(p.reduce((s, x) => s + x.amountApplied, 0)).toBe(10);
  });

  it('refuses short, over-card, extra, empty, zero-total-with-payment, non-positive and over-precise payments', () => {
    const bad = (total: number, code: string, inputs: Parameters<typeof planPayments>[2]) => () => planPayments(total, code, inputs);
    expect(bad(10, 'USD', [cash(4)])).toThrow(/short by 6/);
    expect(bad(10, 'USD', [card(11)])).toThrow(/cannot be more than the amount still due/);
    expect(bad(10, 'USD', [card(10), cash(1)])).toThrow(/already fully paid/);
    expect(bad(10, 'USD', [])).toThrow(/payment is required/);
    expect(bad(0, 'USD', [cash(1)])).toThrow(/total is zero/);
    expect(bad(5, 'USD', [cash(0)])).toThrow(/positive/);
    expect(bad(5, 'USD', [cash(-1)])).toThrow(/positive/);
    expect(bad(5, 'USD', [cash(Number.NaN)])).toThrow(/positive/);
    expect(bad(5, 'USD', [cash(5.005)])).toThrow(/decimal places/);
    expect(bad(5, 'JPY', [cash(5.5)])).toThrow(/decimal places/);
    expect(bad(5, 'USD', [{ method: 'cheque' as 'cash', amountTendered: 5 }])).toThrow(/cash, card or other/);
    expect(bad(5, 'USD', Array.from({ length: 11 }, () => cash(1)))).toThrow(/at most 10/);
    expect(bad(5.005, 'USD', [cash(6)])).toThrow(PaymentError);
  });

  it('a zero total takes no payment and returns none', () => {
    expect(planPayments(0, 'USD', [])).toEqual([]);
  });

  it('refuses a reference that looks like a card number, however it is separated, and a reference that is too long', () => {
    for (const ref of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '1234567890123']) {
      expect(() => planPayments(5, 'USD', [card(5, ref)]), ref).toThrow(/card number/);
    }
    expect(() => planPayments(5, 'USD', [card(5, 'x'.repeat(65))])).toThrow(/too long/);
    expect(planPayments(5, 'USD', [card(5, 'SLIP 123456')])[0].reference).toBe('SLIP 123456');
    expect(planPayments(5, 'USD', [card(5, '   ')])[0].reference).toBeNull();
  });

  it('the card-number scan matches the database rule: 13+ digits with single separators, not 12, not double separators', () => {
    expect(looksLikeCardNumber('1234567890123')).toBe(true);
    expect(looksLikeCardNumber('1234 5678 9012 3')).toBe(true);
    expect(looksLikeCardNumber('1-2-3-4-5-6-7-8-9-0-1-2-3')).toBe(true);
    expect(looksLikeCardNumber('ref 123456789012')).toBe(false);          // 12 digits
    expect(looksLikeCardNumber('123456  7890123')).toBe(false);           // a double space breaks the run (database regex: same)
    expect(looksLikeCardNumber('SLIP-2026-10-19-0042')).toBe(false);
    expect(looksLikeCardNumber('')).toBe(false);
  });

  it('an unsupported currency fails closed', () => {
    expect(() => planPayments(5, 'ZZZ', [cash(5)])).toThrow(UnsupportedCurrencyError);
  });

  it('the error names map to the API statuses (400 for a refused payment)', () => {
    expect(new PaymentError('x').name).toBe('ValidationError');
  });
});
