import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HarnessInputError, minorInteger, quantityRational, rational, roundRational } from '../src/commerce/exactMoneyHarness.js';
import {
  SYNTHETIC_TAX_HARNESS_AUTHORITATIVE, allocateSyntheticDiscount, compareSyntheticTaxBasket,
  type SyntheticBasket, type SyntheticLine,
} from '../src/commerce/syntheticTaxComparison.js';

const taxable = (id: string, amount: string, rateId = 'rate-10', rateNumerator = '1', rateDenominator = '10'): SyntheticLine => ({
  id, quantity: '1', uomMaxFractionDigits: 0, unitPriceMinor: amount, discountEligible: true,
  taxClass: 'TAXABLE', priceTreatment: 'EXCLUSIVE', rate: { id: rateId, numerator: rateNumerator, denominator: rateDenominator },
});
const basket = (lines: SyntheticLine[], amountMinor = '0'): SyntheticBasket => ({
  currencyCode: 'USD', currencyExponent: 2, lines,
  discount: { mode: 'PROPORTIONAL_LARGEST_REMAINDER', amountMinor },
  rounding: { stage: 'PER_LINE_PER_RATE', mode: 'HALF_AWAY_FROM_ZERO' },
});

describe('pure exact-money arithmetic', () => {
  it('rounds signed half-minor boundaries by explicit mode', () => {
    expect(roundRational(rational(1n, 2n), 'HALF_AWAY_FROM_ZERO')).toBe(1n);
    expect(roundRational(rational(1n, 2n), 'TIES_TO_EVEN')).toBe(0n);
    expect(roundRational(rational(3n, 2n), 'TIES_TO_EVEN')).toBe(2n);
    expect(roundRational(rational(-1n, 2n), 'HALF_AWAY_FROM_ZERO')).toBe(-1n);
    expect(roundRational(rational(-3n, 2n), 'TIES_TO_EVEN')).toBe(-2n);
    expect(roundRational(rational(-5n, 2n), 'TIES_TO_EVEN')).toBe(-2n);
  });

  it('refuses binary floats, unsafe numbers, divide by zero and unsupported quantity scale', () => {
    expect(() => minorInteger(1.5 as never)).toThrow(HarnessInputError);
    expect(() => minorInteger(9_007_199_254_740_993 as never)).toThrow(HarnessInputError);
    expect(() => minorInteger('1'.repeat(39))).toThrow(HarnessInputError);
    expect(() => rational(10n ** 38n, 1n)).toThrow(HarnessInputError);
    expect(() => rational(1n, 0n)).toThrow(HarnessInputError);
    expect(() => roundRational({ numerator: 1n, denominator: 0n }, 'TIES_TO_EVEN')).toThrow(HarnessInputError);
    expect(() => quantityRational('0.125', 0)).toThrow(HarnessInputError);
    expect(() => quantityRational('0.1250', 3)).toThrow(HarnessInputError);
    expect(quantityRational('0.125', 3)).toEqual({ numerator: 1n, denominator: 8n });
  });
});

describe('illustrative basket comparison', () => {
  it('reconciles exclusive and inclusive synthetic vectors without authority', () => {
    const exclusive = compareSyntheticTaxBasket(basket([taxable('a', '10000')], '1000'));
    expect(exclusive).toMatchObject({ illustrative: true, authoritative: false, taxPolicyActivated: false,
      subtotalMinor: '10000', discountMinor: '1000', exclusiveTaxMinor: '900', includedTaxMinor: '0', payableMinor: '9900' });
    expect(SYNTHETIC_TAX_HARNESS_AUTHORITATIVE).toBe(false);
    const inclusive = compareSyntheticTaxBasket(basket([{ ...taxable('a', '11000'), priceTreatment: 'INCLUSIVE' }], '1100'));
    expect(inclusive).toMatchObject({ subtotalMinor: '11000', discountMinor: '1100', includedTaxMinor: '900',
      exclusiveTaxMinor: '0', payableMinor: '9900' });
  });

  it('reconciles mixed rates and mixed inclusive/exclusive treatments', () => {
    const mixedRates = compareSyntheticTaxBasket(basket([
      taxable('a', '1000'), taxable('b', '1000', 'rate-5', '1', '20'),
    ], '300'));
    expect(mixedRates).toMatchObject({ subtotalMinor: '2000', discountMinor: '300', exclusiveTaxMinor: '128', payableMinor: '1828' });
    expect(mixedRates.lines.map((line) => line.discountMinor)).toEqual(['150', '150']);
    const mixedTreatment = compareSyntheticTaxBasket(basket([
      { ...taxable('a', '11000'), priceTreatment: 'INCLUSIVE' }, taxable('b', '10000'),
    ], '2100'));
    expect(mixedTreatment).toMatchObject({ includedTaxMinor: '900', exclusiveTaxMinor: '900', payableMinor: '19800' });
  });

  it('keeps zero-rated and exempt distinct and validates fractional quantity', () => {
    const result = compareSyntheticTaxBasket(basket([
      { ...taxable('a', '2000'), taxClass: 'ZERO_RATED', rate: null },
      { ...taxable('b', '2000'), taxClass: 'EXEMPT', rate: null },
      { ...taxable('c', '800'), quantity: '0.125', uomMaxFractionDigits: 3, taxClass: 'EXEMPT', rate: null },
    ]));
    expect(result).toMatchObject({ subtotalMinor: '4100', includedTaxMinor: '0', exclusiveTaxMinor: '0', payableMinor: '4100' });
    expect(result.lines.map((line) => line.taxClass)).toEqual(['ZERO_RATED', 'EXEMPT', 'EXEMPT']);
    expect(result.lines[2].displayedMinor).toBe('100');
    expect(() => compareSyntheticTaxBasket(basket([{ ...taxable('a', '800'), quantity: '0.125', uomMaxFractionDigits: 0 }])))
      .toThrow(/precision/);
  });

  it('compares per-line and aggregate rounding, and half-away versus ties-even', () => {
    const input = basket([taxable('a', '5'), taxable('b', '5')]);
    expect(compareSyntheticTaxBasket(input).exclusiveTaxMinor).toBe('2');
    expect(compareSyntheticTaxBasket({ ...input, rounding: { stage: 'AGGREGATE_PER_RATE', mode: 'HALF_AWAY_FROM_ZERO' } }).exclusiveTaxMinor).toBe('1');
    expect(compareSyntheticTaxBasket({ ...input, rounding: { stage: 'PER_LINE_PER_RATE', mode: 'TIES_TO_EVEN' } }).exclusiveTaxMinor).toBe('0');
    expect(compareSyntheticTaxBasket({ ...input, rounding: { stage: 'AGGREGATE_PER_RATE', mode: 'TIES_TO_EVEN' } }).exclusiveTaxMinor).toBe('1');
  });

  it('allocates one residual minor unit by stable line ID and conserves both modes', () => {
    const lines = [{ id: 'b', eligible: true, capacityMinor: '100' }, { id: 'a', eligible: true, capacityMinor: '100' }];
    expect(allocateSyntheticDiscount(lines, { mode: 'PROPORTIONAL_LARGEST_REMAINDER', amountMinor: '1' }))
      .toEqual([{ lineId: 'a', amountMinor: '1' }, { lineId: 'b', amountMinor: '0' }]);
    expect(allocateSyntheticDiscount(lines, { mode: 'LINE_SPECIFIC', amountMinor: '31',
      explicit: [{ lineId: 'b', amountMinor: '30' }, { lineId: 'a', amountMinor: '1' }] }))
      .toEqual([{ lineId: 'a', amountMinor: '1' }, { lineId: 'b', amountMinor: '30' }]);
  });

  it('refuses over-allocation, ineligible allocation, unknown currency and conflicting rate IDs', () => {
    const lines = [{ id: 'a', eligible: false, capacityMinor: '100' }, { id: 'b', eligible: true, capacityMinor: '100' }];
    expect(() => allocateSyntheticDiscount(lines, { mode: 'PROPORTIONAL_LARGEST_REMAINDER', amountMinor: '101' })).toThrow(/eligible/);
    expect(() => allocateSyntheticDiscount(lines, { mode: 'LINE_SPECIFIC', amountMinor: '1',
      explicit: [{ lineId: 'a', amountMinor: '1' }] })).toThrow(/ineligible/);
    expect(() => allocateSyntheticDiscount(lines, { mode: 'LINE_SPECIFIC', amountMinor: '2',
      explicit: [{ lineId: 'b', amountMinor: '1' }] })).toThrow(/conserve/);
    expect(() => compareSyntheticTaxBasket({ ...basket([taxable('a', '1')]), currencyCode: 'ZZZ' })).toThrow(/currency/);
    expect(() => compareSyntheticTaxBasket(basket([taxable('a', '100'), taxable('b', '100', 'rate-10', '1', '20')])))
      .toThrow(/conflicting/);
  });

  it('is stable under input reordering and repeated evaluation', () => {
    const lines = [taxable('c', '11000'), taxable('a', '9000'), taxable('b', '5000', 'rate-5', '1', '20')];
    const first = compareSyntheticTaxBasket(basket(lines, '101'));
    expect(compareSyntheticTaxBasket(basket([...lines].reverse(), '101'))).toEqual(first);
    expect(compareSyntheticTaxBasket(basket(lines, '101'))).toEqual(first);
    expect(first.lines.reduce((total, line) => total + BigInt(line.discountMinor), 0n).toString()).toBe(first.discountMinor);
  });

  it('responds to rate and eligibility mutations while remaining illustrative', () => {
    const original = basket([taxable('a', '1000'), taxable('b', '1000')], '100');
    const base = compareSyntheticTaxBasket(original);
    const changedRate = compareSyntheticTaxBasket({ ...original,
      lines: [taxable('a', '1000', 'rate-20', '1', '5'), taxable('b', '1000', 'rate-20', '1', '5')] });
    expect(changedRate.payableMinor).not.toBe(base.payableMinor);
    const changedEligibility = compareSyntheticTaxBasket({ ...original,
      lines: [{ ...taxable('a', '1000'), discountEligible: false }, taxable('b', '1000')] });
    expect(changedEligibility.lines.map((line) => line.discountMinor)).toEqual(['0', '100']);
    for (const result of [base, changedRate, changedEligibility]) {
      expect(result).toMatchObject({ illustrative: true, authoritative: false, taxPolicyActivated: false });
    }
  });

  it('passes a seeded allocation conservation and permutation sweep', () => {
    let seed = 371;
    const next = () => { seed = (seed * 48271) % 2147483647; return seed; };
    for (let iteration = 0; iteration < 500; iteration++) {
      const lines = Array.from({ length: 1 + next() % 8 }, (_, index) => ({
        id: `line-${index.toString().padStart(2, '0')}`, eligible: next() % 4 !== 0,
        capacityMinor: String(1 + next() % 10_000),
      }));
      const capacity = lines.filter((line) => line.eligible).reduce((total, line) => total + BigInt(line.capacityMinor), 0n);
      const amount = capacity === 0n ? 0n : BigInt(next()) % (capacity + 1n);
      const request = { mode: 'PROPORTIONAL_LARGEST_REMAINDER' as const, amountMinor: amount.toString() };
      const allocated = allocateSyntheticDiscount(lines, request);
      expect(allocated).toEqual(allocateSyntheticDiscount([...lines].reverse(), request));
      expect(allocated.reduce((total, line) => total + BigInt(line.amountMinor), 0n)).toBe(amount);
      for (const row of allocated) {
        const source = lines.find((line) => line.id === row.lineId)!;
        expect(BigInt(row.amountMinor)).toBeLessThanOrEqual(BigInt(source.capacityMinor));
        if (!source.eligible) expect(row.amountMinor).toBe('0');
      }
    }
  });

  it('passes a seeded mixed-basket reconciliation and determinism sweep', () => {
    let seed = 911;
    const next = () => { seed = (seed * 48271) % 2147483647; return seed; };
    for (let iteration = 0; iteration < 200; iteration++) {
      const lines = Array.from({ length: 1 + next() % 6 }, (_, index) => {
        const line = taxable(`line-${index}`, String(1 + next() % 10_000), next() % 2 ? 'rate-10' : 'rate-5', '1', '10');
        if (line.rate?.id === 'rate-5') line.rate.denominator = '20';
        const taxClass = next() % 3;
        return { ...line, taxClass: taxClass === 0 ? 'EXEMPT' as const : taxClass === 1 ? 'ZERO_RATED' as const : 'TAXABLE' as const,
          rate: taxClass === 2 ? line.rate : null, priceTreatment: next() % 2 ? 'INCLUSIVE' as const : 'EXCLUSIVE' as const };
      });
      const total = lines.reduce((value, line) => value + BigInt(line.unitPriceMinor), 0n);
      const amount = BigInt(next()) % (total + 1n);
      const data = basket(lines, amount.toString());
      const result = compareSyntheticTaxBasket(data);
      expect(result).toEqual(compareSyntheticTaxBasket({ ...data, lines: [...lines].reverse() }));
      expect(result.lines.reduce((value, line) => value + BigInt(line.discountMinor), 0n)).toBe(amount);
      expect(BigInt(result.payableMinor)).toBe(BigInt(result.subtotalMinor) - amount + BigInt(result.exclusiveTaxMinor));
      expect(result.authoritative).toBe(false);
    }
  });

  it('is absent from the existing online/offline POS writers and routes', () => {
    for (const path of [
      '../../database/src/repositories/bo/OrderRepository.ts',
      '../../database/src/repositories/bo/OfflineSaleRepository.ts',
      '../../../apps/api/src/routes/orders.ts',
      '../../../apps/api/src/routes/offlineSales.ts',
    ]) expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toContain('compareSyntheticTaxBasket');
  });
});
