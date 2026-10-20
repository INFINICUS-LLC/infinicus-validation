import { describe, it, expect } from 'vitest';
import { planDiscount, DiscountError, MAX_DISCOUNTS_PER_ORDER, DISCOUNT_REASON_MAX } from '../src/repositories/bo/discount.js';
import { planPayments, PaymentError } from '../src/repositories/bo/tender.js';

describe('planDiscount (pure, exact, minor units)', () => {
  it('stores a signed line: quantity 1, negative price and total, a plain description', () => {
    expect(planDiscount(10, 'USD', 2.5, null, 0)).toEqual({ description: 'Discount', quantity: 1, unitPrice: -2.5, lineTotal: -2.5 });
    expect(planDiscount(10, 'USD', 2.5, '  Staff meal  ', 0).description).toBe('Discount: Staff meal');
  });

  it('is exact in the currency: KWD allows fils, USD and JPY do not allow more than their decimals', () => {
    expect(planDiscount(4.25, 'KWD', 0.125, null, 0).lineTotal).toBe(-0.125);
    expect(() => planDiscount(10, 'USD', 0.125, null, 0)).toThrow(DiscountError);
    expect(() => planDiscount(1000, 'JPY', 0.5, null, 0)).toThrow(/decimal places/);
    expect(planDiscount(1000, 'JPY', 150, null, 0).unitPrice).toBe(-150);
  });

  it('can take the whole order but never more (the total never goes below zero)', () => {
    expect(planDiscount(10, 'USD', 10, null, 0).lineTotal).toBe(-10);
    expect(() => planDiscount(10, 'USD', 10.01, null, 0)).toThrow(/more than the order total/);
    expect(() => planDiscount(0, 'USD', 0.01, null, 0)).toThrow(DiscountError);
  });

  it('refuses a zero, negative or non-finite amount and an unsupported currency', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => planDiscount(10, 'USD', bad, null, 0)).toThrow(/positive number/);
    expect(() => planDiscount(10, 'ZZZ', 1, null, 0)).toThrow(/ZZZ|unsupported/i);
  });

  it('limits the number of discounts and the length of the reason', () => {
    expect(() => planDiscount(100, 'USD', 1, null, MAX_DISCOUNTS_PER_ORDER)).toThrow(/at most/);
    expect(planDiscount(100, 'USD', 1, null, MAX_DISCOUNTS_PER_ORDER - 1).lineTotal).toBe(-1);
    expect(() => planDiscount(100, 'USD', 1, 'x'.repeat(DISCOUNT_REASON_MAX + 1), 0)).toThrow(/too long/);
    expect(planDiscount(100, 'USD', 1, 'x'.repeat(DISCOUNT_REASON_MAX), 0).description.length).toBe('Discount: '.length + DISCOUNT_REASON_MAX);
  });

  it('a refused discount carries the name the API maps to 400', () => {
    try { planDiscount(10, 'USD', -1, null, 0); } catch (e) { expect((e as Error).name).toBe('ValidationError'); return; }
    throw new Error('expected a refusal');
  });
});

describe('planPayments: a negative order total can never be paid or completed', () => {
  it('is refused with a plain reason', () => {
    expect(() => planPayments(-1, 'USD', [])).toThrow(PaymentError);
    expect(() => planPayments(-1, 'USD', [{ method: 'cash', amountTendered: 5 }])).toThrow(/below zero/);
  });
});
