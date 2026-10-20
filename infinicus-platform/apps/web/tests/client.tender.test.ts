import { describe, it, expect } from 'vitest';
import { buildTender, buildTenderPlan, MAX_TENDERS, looksLikeCardNumber, parseMoneyText } from '../lib/client/tender';
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

describe('split tender preview (POS-6c, advisory only)', () => {
  it('builds ordered card/other/cash inputs with exact KWD change and trimmed references', () => {
    expect(buildTenderPlan([
      entry({ method: 'card', amountText: '0.500', reference: ' SLIP-A ' }),
      entry({ method: 'other', amountText: '0.250' }),
      entry({ method: 'cash', amountText: '1.000' }),
    ], 1.375, 'KWD')).toEqual({ ok: true, payments: [
      { method: 'card', amountTendered: 0.5, reference: 'SLIP-A' },
      { method: 'other', amountTendered: 0.25 },
      { method: 'cash', amountTendered: 1 },
    ], changePreview: 0.375 });
  });
  it('preserves the single-card/other shortcut but requires amounts on every split row', () => {
    expect(buildTenderPlan([entry({ method: 'card' })], 5, 'USD')).toMatchObject({ ok: true, payments: [{ method: 'card', amountTendered: 5 }] });
    expect(buildTenderPlan([entry({ method: 'other' })], 5, 'USD')).toMatchObject({ ok: true });
    expect(buildTenderPlan([entry({ method: 'card' }), entry({ amountText: '3' })], 5, 'USD')).toMatchObject({ ok: false });
    expect(buildTenderPlan([entry({ method: 'card', amountText: '2' })], 5, 'USD')).toMatchObject({ ok: false });
  });
  it('takes no payment for zero-total orders, and refuses payments or missing tender where inappropriate', () => {
    expect(buildTenderPlan([], 0, 'KWD')).toEqual({ ok: true, payments: [], changePreview: 0 });
    expect(buildTenderPlan([entry({ amountText: '1' })], 0, 'KWD')).toMatchObject({ ok: false });
    expect(buildTenderPlan([], 1, 'KWD')).toMatchObject({ ok: false });
  });
  it('refuses underpayment, non-cash overpayment and an extra payment after full settlement', () => {
    for (const rows of [
      [entry({ method: 'card', amountText: '1' }), entry({ amountText: '1' })],
      [entry({ amountText: '1' }), entry({ method: 'card', amountText: '5' })],
      [entry({ amountText: '5' }), entry({ method: 'other', amountText: '1' })],
      [entry({ amountText: '3' }), entry({ method: 'other', amountText: '1' })],
    ]) expect(buildTenderPlan(rows, 3, 'USD')).toMatchObject({ ok: false });
  });
  it('supports cash first or last and integer minor units without floating-point drift', () => {
    expect(buildTenderPlan([entry({ amountText: '0.10' }), entry({ method: 'card', amountText: '0.20' })], 0.3, 'USD')).toMatchObject({ ok: true, changePreview: 0 });
    expect(buildTenderPlan([entry({ method: 'card', amountText: '200' }), entry({ amountText: '500' })], 300, 'JPY')).toMatchObject({ ok: true, changePreview: 400 });
    expect(buildTenderPlan([entry({ amountText: '0.25' }), entry({ amountText: '1' })], 1, 'USD')).toMatchObject({ ok: true, changePreview: 0.25 });
  });
  it('checks precision, bounds and malformed amounts independently for each row', () => {
    for (const amountText of ['', '0', '-1', '1e3', 'abc', '0.0001']) {
      expect(buildTenderPlan([entry({ method: 'card', amountText: '0.5' }), entry({ amountText })], 1, 'USD')).toMatchObject({ ok: false });
    }
    for (const total of [NaN, Infinity, -1, 0.001, Number.MAX_SAFE_INTEGER]) expect(buildTenderPlan([entry({ method: 'card' })], total, 'USD')).toMatchObject({ ok: false });
    expect(buildTenderPlan([], 0, 'ZZZ')).toMatchObject({ ok: false });
    expect(buildTenderPlan([entry({ amountText: '1.5' })], 1, 'JPY')).toMatchObject({ ok: false });
  });
  it('enforces the existing ten-payment bound and reference checks on every row', () => {
    const rows = Array.from({ length: MAX_TENDERS }, () => entry({ method: 'card', amountText: '1' }));
    expect(buildTenderPlan(rows, 10, 'USD')).toMatchObject({ ok: true });
    expect(buildTenderPlan([...rows, rows[0]], 11, 'USD')).toMatchObject({ ok: false });
    for (const reference of ['4111 1111 1111 1111', 'x'.repeat(65)]) {
      expect(buildTenderPlan([entry({ method: 'card', amountText: '1' }), entry({ amountText: '1', reference })], 2, 'USD')).toMatchObject({ ok: false });
    }
  });
});
