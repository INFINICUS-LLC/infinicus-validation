import { describe, it, expect } from 'vitest';
import { buildTender, looksLikeCardNumber, parseMoneyText } from '../lib/client/tender';
import { toMinorUnits } from '../lib/client/currency';

const entry = (over: Partial<{ method: 'cash' | 'card' | 'other'; amountText: string; reference: string }> = {}) => ({ method: 'cash' as const, amountText: '', reference: '', ...over });

describe('tender entry (POS-5)', () => {
  it('parses a typed money amount strictly', () => {
    expect(parseMoneyText('20')).toBe(20);
    expect(parseMoneyText(' 7.500 ')).toBe(7.5);
    for (const bad of ['', '-1', '1,5', '1e3', '.5', '5.', 'abc', '1.23456', '1 000', '1.2.3']) expect(parseMoneyText(bad), bad).toBeNull();
  });

  it('cash must be a clear number covering the total; the change preview is exact in the currency', () => {
    const ok = buildTender(entry({ amountText: '2' }), 1.375, 'KWD');
    expect(ok).toEqual({ ok: true, payment: { method: 'cash', amountTendered: 2 }, changePreview: 0.625 });
    const usd = buildTender(entry({ amountText: '1' }), 0.7, 'USD');
    expect(usd.ok && usd.changePreview).toBe(0.3);
    expect(buildTender(entry({ amountText: '' }), 5, 'USD')).toMatchObject({ ok: false });
    expect(buildTender(entry({ amountText: 'abc' }), 5, 'USD')).toMatchObject({ ok: false });
    expect(buildTender(entry({ amountText: '0' }), 5, 'USD')).toMatchObject({ ok: false });
    expect(buildTender(entry({ amountText: '4.99' }), 5, 'USD')).toMatchObject({ ok: false, reason: 'The cash received is less than the total.' });
  });

  it('refuses more decimals than the currency has (JPY none, USD two, KWD three)', () => {
    expect(buildTender(entry({ amountText: '300.5' }), 300, 'JPY')).toMatchObject({ ok: false });
    expect(buildTender(entry({ amountText: '5.005' }), 5, 'USD')).toMatchObject({ ok: false });
    expect(buildTender(entry({ amountText: '5.005' }), 5, 'KWD')).toMatchObject({ ok: true });
  });

  it('card and other pay exactly the server total and need no typed amount', () => {
    expect(buildTender(entry({ method: 'card' }), 12.5, 'USD')).toEqual({ ok: true, payment: { method: 'card', amountTendered: 12.5 }, changePreview: 0 });
    expect(buildTender(entry({ method: 'other', reference: 'VOUCHER 77' }), 12.5, 'USD')).toEqual({ ok: true, payment: { method: 'other', amountTendered: 12.5, reference: 'VOUCHER 77' }, changePreview: 0 });
  });

  it('never sends a reference that looks like a card number, or one that is too long', () => {
    for (const reference of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
      expect(buildTender(entry({ method: 'card', reference }), 5, 'USD'), reference).toMatchObject({ ok: false });
    }
    expect(buildTender(entry({ method: 'card', reference: 'x'.repeat(65) }), 5, 'USD')).toMatchObject({ ok: false });
    expect(looksLikeCardNumber('SLIP-2026-10-19-0042')).toBe(false);
    expect(looksLikeCardNumber('1234 5678 9012 3')).toBe(true);
  });

  it('an unsupported currency cannot take a payment', () => {
    expect(buildTender(entry({ method: 'card' }), 5, 'ZZZ')).toMatchObject({ ok: false });
    expect(toMinorUnits(1.5, 'ZZZ')).toBeNull();
    expect(toMinorUnits(1.375, 'KWD')).toBe(1375);
  });
});
