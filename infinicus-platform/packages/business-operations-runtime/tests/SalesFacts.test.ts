/**
 * BI-SALES-1 - Business Operations' read-only sales facts: exact decimal-to-minor-unit conversion and fail-closed behaviour (no database).
 */
import { describe, expect, it } from 'vitest';
import type { SalesDayCurrencyFacts, TenantContext } from '@infinicus/database';
import { AmountNotRepresentableError, decimalToMinorUnits, SalesFactsService } from '../src/index.js';

const ctx: TenantContext = { tenantId: 't', workspaceId: 'w', userId: 'u' };
const row = (over: Partial<SalesDayCurrencyFacts> = {}): SalesDayCurrencyFacts => ({
  orderDate: '2026-03-10', currencyCode: 'KWD', completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0,
  grossAmount: '5.2500', discountAmount: '0.5000', netAmount: '4.7500', ...over,
});
const serviceOver = (rows: SalesDayCurrencyFacts[]) => new SalesFactsService({ byDayAndCurrency: async () => rows });
const request = { businessId: 'b', from: '2026-03-10', to: '2026-03-10' };

describe('decimalToMinorUnits', () => {
  it.each([
    ['4.7500', 3, 4750], ['1500.0000', 0, 1500], ['0', 2, 0], ['0.0000', 3, 0], ['12.34', 2, 1234], ['12', 2, 1200], ['0.05', 2, 5], ['1234567.8900', 2, 123456789],
    ['-2.5000', 2, -250], ['-0.0000', 2, 0], ['0.1230', 3, 123], ['9.9990', 3, 9999],
  ])('%s at %i decimals is %i minor units, exactly', (amount, exponent, expected) => {
    expect(decimalToMinorUnits(amount, exponent)).toBe(expected);
  });
  it('never rounds: a non-zero digit beyond the minor unit is refused', () => {
    expect(() => decimalToMinorUnits('4.7510', 2)).toThrow(AmountNotRepresentableError);
    expect(() => decimalToMinorUnits('0.0001', 3)).toThrow(AmountNotRepresentableError);
    expect(() => decimalToMinorUnits('10.5', 0)).toThrow(AmountNotRepresentableError);
  });
  it('is not fooled by float behaviour: 0.1 + 0.2 style amounts are exact strings', () => {
    expect(decimalToMinorUnits('0.3000', 2)).toBe(30);
    expect(decimalToMinorUnits('1.0050', 3)).toBe(1005);
  });
  it('refuses malformed text and amounts beyond the safe integer range', () => {
    for (const bad of ['', 'abc', '1,5', '1e3', '1.2.3', ' ', '--1', '+1']) expect(() => decimalToMinorUnits(bad, 2), bad).toThrow(AmountNotRepresentableError);
    expect(() => decimalToMinorUnits('90071992547409.93', 2)).toThrow(AmountNotRepresentableError);
    expect(decimalToMinorUnits('90071992547409.91', 2)).toBe(9007199254740991);
  });
  it('refuses an unsupported exponent', () => {
    expect(() => decimalToMinorUnits('1', 5)).toThrow(AmountNotRepresentableError);
    expect(() => decimalToMinorUnits('1', -1)).toThrow(AmountNotRepresentableError);
  });
});

describe('SalesFactsService', () => {
  it('states each row in integer minor units of its own currency, with the currency exponent', async () => {
    const out = await serviceOver([row(), row({ currencyCode: 'JPY', grossAmount: '1500.0000', discountAmount: '0.0000', netAmount: '1500.0000', completedOrders: 1, voidedOrders: 0 })]).load(ctx, request);
    expect(out).toEqual({ outcome: 'FACTS', facts: [
      { date: '2026-03-10', currencyCode: 'KWD', currencyExponent: 3, completedOrders: 2, voidedOrders: 1, openOrders: 0, otherStatusOrders: 0, grossMinor: 5250, discountMinor: 500, netMinor: 4750 },
      { date: '2026-03-10', currencyCode: 'JPY', currencyExponent: 0, completedOrders: 1, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 1500, discountMinor: 0, netMinor: 1500 },
    ] });
  });
  it('returns an empty fact set when nothing was ordered (nothing is invented)', async () => {
    expect(await serviceOver([]).load(ctx, request)).toEqual({ outcome: 'FACTS', facts: [] });
  });
  it('fails closed on a currency it does not know', async () => {
    const out = await serviceOver([row({ currencyCode: 'XXX' })]).load(ctx, request);
    expect(out).toMatchObject({ outcome: 'UNAVAILABLE', code: 'UNSUPPORTED_CURRENCY' });
  });
  it('fails closed on an amount that is not an exact multiple of the minor unit', async () => {
    const out = await serviceOver([row({ netAmount: '4.7505' })]).load(ctx, request);
    expect(out).toMatchObject({ outcome: 'UNAVAILABLE', code: 'AMOUNT_NOT_REPRESENTABLE' });
  });
  it('passes the business and the period to the repository unchanged and scopes nothing itself', async () => {
    const seen: unknown[] = [];
    await new SalesFactsService({ byDayAndCurrency: async (...args) => { seen.push(args); return []; } }).load(ctx, request);
    expect(seen).toEqual([[ctx, 'b', '2026-03-10', '2026-03-10']]);
  });
});
