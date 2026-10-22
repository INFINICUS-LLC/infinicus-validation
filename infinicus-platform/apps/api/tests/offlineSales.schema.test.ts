/**
 * OFF-1 step 4: the request contract of POST /v1/businesses/:businessId/offline-sales, checked at the schema layer alone (no database).
 * The service re-validates everything, so these pin the first line of defence independently.
 */
import { describe, expect, it } from 'vitest';
import { offlineSaleBodySchema, offlineSaleResponseSchema } from '../src/schemas/offlineSales.js';

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const valid = () => ({
  clientSaleId: U(1), deviceId: 'tablet-1', registerSessionId: U(2), deviceCreatedAt: '2026-10-21T10:00:00.000Z', catalogueSnapshotAt: '2026-10-21T09:00:00Z', currencyCode: 'KWD',
  lines: [{ productId: U(3), quantity: 2, unitPriceShownMinor: 1500 }], provisionalTotalMinor: 3000,
  tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: 'slip 1' }],
});
const ok = (b: unknown) => offlineSaleBodySchema.safeParse(b).success;

describe('offline sale body schema', () => {
  it('accepts a well-formed sale (offset dates, optional reference)', () => {
    expect(ok(valid())).toBe(true);
    expect(ok({ ...valid(), deviceCreatedAt: '2026-10-21T13:00:00+03:00' })).toBe(true);
    expect(ok({ ...valid(), tenders: [{ method: 'cash', amountTenderedMinor: 5000 }] })).toBe(true);
    expect(ok({ ...valid(), tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: null }] })).toBe(true);
  });
  it('is CASH ONLY (D5): any other method is refused here, before the service sees it', () => {
    for (const method of ['card', 'other', 'CASH', '']) expect(ok({ ...valid(), tenders: [{ method, amountTenderedMinor: 5000 }] }), method).toBe(false);
  });
  it('refuses unknown keys at every level, so a client cannot supply authority or server-owned values', () => {
    expect(ok({ ...valid(), tenantId: U(9) })).toBe(false);
    expect(ok({ ...valid(), serverTotalMinor: 1 })).toBe(false);
    expect(ok({ ...valid(), status: 'completed' })).toBe(false);
    expect(ok({ ...valid(), lines: [{ ...valid().lines[0], discount: 1 }] })).toBe(false);
    expect(ok({ ...valid(), tenders: [{ ...valid().tenders[0], changeGiven: 1 }] })).toBe(false);
  });
  it('allows only whole, safe, correctly signed minor-unit amounts', () => {
    for (const v of [10.5, -1, Number.NaN, 2 ** 53, '1500']) expect(ok({ ...valid(), lines: [{ ...valid().lines[0], unitPriceShownMinor: v }] }), String(v)).toBe(false);
    for (const v of [0, 1.5, -1]) expect(ok({ ...valid(), tenders: [{ method: 'cash', amountTenderedMinor: v }] }), String(v)).toBe(false);
    expect(ok({ ...valid(), provisionalTotalMinor: -1 })).toBe(false);
    expect(ok({ ...valid(), lines: [{ ...valid().lines[0], unitPriceShownMinor: 0 }], provisionalTotalMinor: 0 })).toBe(true);   // a free item is a legitimate line
  });
  it('bounds quantities, lines and payments, and needs at least one of each', () => {
    for (const q of [0, -1, 1.5, 100_001]) expect(ok({ ...valid(), lines: [{ ...valid().lines[0], quantity: q }] }), String(q)).toBe(false);
    expect(ok({ ...valid(), lines: [] })).toBe(false);
    expect(ok({ ...valid(), lines: Array.from({ length: 101 }, () => valid().lines[0]) })).toBe(false);
    expect(ok({ ...valid(), lines: Array.from({ length: 100 }, () => valid().lines[0]) })).toBe(true);
    expect(ok({ ...valid(), tenders: [] })).toBe(false);
    expect(ok({ ...valid(), tenders: Array.from({ length: 11 }, () => valid().tenders[0]) })).toBe(false);
  });
  it('requires UUID identities, a safe device id, an upper-case currency, ISO date-times and a short reference', () => {
    expect(ok({ ...valid(), clientSaleId: 'nope' })).toBe(false);
    expect(ok({ ...valid(), registerSessionId: 'nope' })).toBe(false);
    expect(ok({ ...valid(), lines: [{ ...valid().lines[0], productId: 'nope' }] })).toBe(false);
    for (const d of ['', 'x'.repeat(65), 'has space', "q'uote", 'ünï']) expect(ok({ ...valid(), deviceId: d }), d).toBe(false);
    for (const c of ['kwd', 'KW', 'KWDD', '']) expect(ok({ ...valid(), currencyCode: c }), c).toBe(false);
    for (const d of ['yesterday', '2026-10-21', '2026-10-21 10:00:00', 1761040800000]) expect(ok({ ...valid(), deviceCreatedAt: d }), String(d)).toBe(false);
    expect(ok({ ...valid(), tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: 'x'.repeat(65) }] })).toBe(false);
  });
  it('the response schema names exactly the fields the contract promises', () => {
    const shape = Object.keys((offlineSaleResponseSchema as unknown as { shape: Record<string, unknown> }).shape).sort();
    expect(shape).toEqual(['clientSaleId', 'currencyCode', 'deviceTotalMinor', 'differenceMinor', 'offlineSaleId', 'orderId', 'orderNumber', 'outcome', 'replayed', 'reviewReason', 'serverTotalMinor']);
  });
});
