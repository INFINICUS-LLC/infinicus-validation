/**
 * OFF-1 step 3 - the pure core of offline sale processing (no database): exact minor-unit arithmetic, the door, the digest, the D4 drift policy and the outcome planner.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { roundToCurrency } from '../src/currency/minorUnits.js';
import {
  MAX_OFFLINE_LINES, MAX_OFFLINE_QUANTITY, MAX_OFFLINE_TENDERS, OFFLINE_MAX_AGE_SECONDS,
  parseScaled4, planOfflineSale, requestDigest, unitPriceMinor, validateOfflineSaleRequest,
  type OfflineSaleConfig, type OfflineSaleRequest, type ServerProduct,
} from '../src/repositories/bo/offlineSale.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const SNAPSHOT = new Date('2026-10-21T09:00:00Z');
const BEFORE_SNAPSHOT = new Date('2026-10-21T08:00:00Z');
const AFTER_SNAPSHOT = new Date('2026-10-21T10:00:00Z');
const CONFIG: OfflineSaleConfig = { maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS, futureToleranceSeconds: 300, driftLimitMinorByCurrency: { KWD: 500 } };
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const request = (over: Partial<OfflineSaleRequest> = {}): OfflineSaleRequest => ({
  clientSaleId: '99999999-9999-4999-8999-999999999999', deviceId: 'tablet-1', registerSessionId: '88888888-8888-4888-8888-888888888888',
  deviceCreatedAt: new Date('2026-10-21T11:00:00Z'), catalogueSnapshotAt: SNAPSHOT, currencyCode: 'KWD',
  lines: [{ productId: P1, quantity: 2, unitPriceShownMinor: 1500 }], provisionalTotalMinor: 3000,
  tenders: [{ method: 'cash', amountTenderedMinor: 5000 }], ...over,
});
const product = (id: string, priceScaled4: bigint, over: Partial<ServerProduct> = {}): ServerProduct => ({ id, name: `P-${id.slice(0, 2)}`, active: true, priceScaled4, updatedAt: BEFORE_SNAPSHOT, ...over });
const catalogue = (...ps: ServerProduct[]) => new Map(ps.map((p) => [p.id.toLowerCase(), p]));
const plan = (req: OfflineSaleRequest, products: ReadonlyMap<string, ServerProduct>, limit = 500) => planOfflineSale({ request: req, exponent: 3, products, driftLimitMinor: limit });

describe('exact minor-unit arithmetic', () => {
  it('parses numeric(18,4) text exactly and rejects everything else', () => {
    expect(parseScaled4('12.5000')).toBe(125000n);
    expect(parseScaled4('0.5')).toBe(5000n);
    expect(parseScaled4('7')).toBe(70000n);
    expect(parseScaled4('0.0001')).toBe(1n);
    expect(parseScaled4(' 3.1 ')).toBe(31000n);
    for (const bad of ['', '.5', '-1', '1e3', '1.23456', '1.2.3', 'abc', '1,5', '123456789012345', '1.']) expect(parseScaled4(bad), bad).toBeNull();
  });

  it('turns a price into whole minor units only when it is exact for the currency', () => {
    expect(unitPriceMinor(15000n, 3)).toBe(1500);   // 1.5 KWD = 1500 fils
    expect(unitPriceMinor(12345n, 3)).toBeNull();   // 1.2345 KWD is not a whole number of fils
    expect(unitPriceMinor(5000n, 2)).toBe(50);      // 0.5 USD
    expect(unitPriceMinor(1000000n, 0)).toBe(100);  // 100 JPY
    expect(unitPriceMinor(1005000n, 0)).toBeNull(); // 100.5 JPY
    expect(unitPriceMinor(0n, 3)).toBe(0);
    expect(unitPriceMinor(10n ** 13n, 0)).toBe(10 ** 9);
    expect(unitPriceMinor(10n ** 21n, 0)).toBeNull(); // beyond the safe-integer range fails closed
  });

  it('agrees with the online path (roundToCurrency of quantity x price) for thousands of random exact prices in KWD, USD and JPY', () => {
    let seed = 20261021;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    let compared = 0;
    for (const [code, exp] of [['KWD', 3], ['USD', 2], ['JPY', 0]] as const) {
      for (let i = 0; i < 4000; i += 1) {
        const unit = Math.floor(rnd() * 5_000_000);               // minor units
        const qty = 1 + Math.floor(rnd() * 500);
        const major = unit / 10 ** exp;                            // what numeric(18,4) holds, read back as a JS number
        const online = roundToCurrency(qty * major, code);
        const offline = (qty * unit) / 10 ** exp;
        expect(offline, `${code} qty=${qty} unit=${unit}`).toBe(online);
        compared += 1;
      }
    }
    expect(compared).toBe(12000);
  });
});

describe('the door (validateOfflineSaleRequest)', () => {
  const ok = () => validateOfflineSaleRequest(request(), CONFIG, NOW);
  const refused = (req: OfflineSaleRequest, message: RegExp, cfg = CONFIG) => {
    expect(() => validateOfflineSaleRequest(req, cfg, NOW)).toThrow(message);
    try { validateOfflineSaleRequest(req, cfg, NOW); } catch (e) { expect((e as Error).name).toBe('ValidationError'); }
  };

  it('accepts a well-formed request and reports the currency exponent', () => { expect(ok()).toEqual({ exponent: 3 }); });
  it('fails closed on an unsupported currency', () => { expect(() => validateOfflineSaleRequest(request({ currencyCode: 'XXX' }), CONFIG, NOW)).toThrow(/not a supported ISO 4217 code/); });
  it('refuses malformed identities', () => {
    refused(request({ clientSaleId: 'nope' }), /client_sale_id must be a UUID/);
    refused(request({ deviceId: '' }), /device_id/);
    refused(request({ deviceId: 'x'.repeat(65) }), /device_id/);
    refused(request({ deviceId: 'has space' }), /device_id/);
    refused(request({ registerSessionId: 'nope' }), /register_session_id/);
  });
  it('refuses invalid or inconsistent dates', () => {
    refused(request({ deviceCreatedAt: new Date('nope') }), /device_created_at/);
    refused(request({ catalogueSnapshotAt: new Date('2026-10-21T11:30:00Z') }), /snapshot cannot be newer/);
  });
  it('enforces the D3 age limit and the future tolerance', () => {
    refused(request({ deviceCreatedAt: new Date(NOW.getTime() - (OFFLINE_MAX_AGE_SECONDS + 1) * 1000), catalogueSnapshotAt: new Date(NOW.getTime() - (OFFLINE_MAX_AGE_SECONDS + 5) * 1000) }), /older than the offline limit/);
    expect(() => validateOfflineSaleRequest(request({ deviceCreatedAt: new Date(NOW.getTime() - OFFLINE_MAX_AGE_SECONDS * 1000), catalogueSnapshotAt: new Date(NOW.getTime() - OFFLINE_MAX_AGE_SECONDS * 1000) }), CONFIG, NOW)).not.toThrow();
    refused(request({ deviceCreatedAt: new Date(NOW.getTime() + 301_000) }), /clock is ahead/);
    expect(() => validateOfflineSaleRequest(request({ deviceCreatedAt: new Date(NOW.getTime() + 300_000) }), CONFIG, NOW)).not.toThrow();
  });
  it('refuses an invalid configuration (the owner-approved clock bound has no default)', () => {
    refused(request(), /configuration is invalid/, { ...CONFIG, futureToleranceSeconds: Number.NaN });
    refused(request(), /configuration is invalid/, { ...CONFIG, maxAgeSeconds: 0 });
  });
  it('refuses empty, oversized and malformed lines', () => {
    refused(request({ lines: [], provisionalTotalMinor: 0 }), /at least one line/);
    refused(request({ lines: Array.from({ length: MAX_OFFLINE_LINES + 1 }, () => ({ productId: P1, quantity: 1, unitPriceShownMinor: 1 })), provisionalTotalMinor: MAX_OFFLINE_LINES + 1 }), /at most/);
    for (const q of [0, -1, 1.5, MAX_OFFLINE_QUANTITY + 1, Number.NaN]) refused(request({ lines: [{ productId: P1, quantity: q, unitPriceShownMinor: 100 }], provisionalTotalMinor: 100 }), /quantity/);
    for (const p of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) refused(request({ lines: [{ productId: P1, quantity: 1, unitPriceShownMinor: p }], provisionalTotalMinor: 0 }), /shown unit price|too large|provisional/);
    refused(request({ lines: [{ productId: 'nope', quantity: 1, unitPriceShownMinor: 100 }], provisionalTotalMinor: 100 }), /product_id/);
  });
  it('refuses a provisional total that is not the sum of the shown lines, and totals beyond safe integers', () => {
    refused(request({ provisionalTotalMinor: 2999 }), /provisional total does not equal/);
    refused(request({ lines: [{ productId: P1, quantity: MAX_OFFLINE_QUANTITY, unitPriceShownMinor: Number.MAX_SAFE_INTEGER }], provisionalTotalMinor: 1 }), /too large/);
  });
  it('accepts only cash, positive whole amounts and a safe reference', () => {
    refused(request({ tenders: [] }), /cash payment is required/);
    refused(request({ tenders: Array.from({ length: MAX_OFFLINE_TENDERS + 1 }, () => ({ method: 'cash' as const, amountTenderedMinor: 1 })) }), /at most/);
    refused(request({ tenders: [{ method: 'card' as unknown as 'cash', amountTenderedMinor: 5000 }] }), /only cash/);
    for (const a of [0, -5, 1.5, Number.NaN]) refused(request({ tenders: [{ method: 'cash', amountTenderedMinor: a }] }), /positive whole number/);
    refused(request({ tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: '4111 1111 1111 1111' }] }), /looks like a card number/);
    refused(request({ tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: 'x'.repeat(65) }] }), /too long/);
    expect(() => validateOfflineSaleRequest(request({ tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: 'slip 1234' }] }), CONFIG, NOW)).not.toThrow();
  });
});

describe('requestDigest', () => {
  it('is stable, case-insensitive on ids, and changes with every field that matters (line order included)', () => {
    const base = requestDigest(request());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(requestDigest(request())).toBe(base);
    expect(requestDigest(request({ clientSaleId: request().clientSaleId.toUpperCase() }))).toBe(base);
    for (const changed of [
      request({ deviceId: 'tablet-2' }), request({ currencyCode: 'USD' }), request({ deviceCreatedAt: new Date('2026-10-21T11:00:01Z') }),
      request({ catalogueSnapshotAt: new Date('2026-10-21T08:59:59Z') }), request({ provisionalTotalMinor: 3001 }),
      request({ lines: [{ productId: P1, quantity: 3, unitPriceShownMinor: 1500 }] }),
      request({ tenders: [{ method: 'cash', amountTenderedMinor: 5001 }] }), request({ tenders: [{ method: 'cash', amountTenderedMinor: 5000, reference: 'a' }] }),
    ]) expect(requestDigest(changed)).not.toBe(base);
    const two = request({ lines: [{ productId: P1, quantity: 1, unitPriceShownMinor: 100 }, { productId: P2, quantity: 1, unitPriceShownMinor: 200 }], provisionalTotalMinor: 300 });
    const swapped = request({ lines: [{ productId: P2, quantity: 1, unitPriceShownMinor: 200 }, { productId: P1, quantity: 1, unitPriceShownMinor: 100 }], provisionalTotalMinor: 300 });
    expect(requestDigest(two)).not.toBe(requestDigest(swapped));
  });
});

describe('planOfflineSale', () => {
  it('accepts a sale whose shown prices equal the server prices, with no drift and the server total as the order total', () => {
    const r = plan(request(), catalogue(product(P1, 15000n)));
    expect(r).toMatchObject({ kind: 'accept', outcome: 'accepted', orderTotalMinor: 3000, serverTotalMinor: 3000 });
    if (r.kind === 'accept') {
      expect(r.lines).toEqual([{ productId: P1, name: 'P-11', quantity: 2, shownUnitMinor: 1500, serverUnitMinor: 1500, usedUnitMinor: 1500, honouredDrift: false }]);
      expect(r.lineDetails[0]).toEqual({ product_id: P1, quantity: 2, shown_unit_minor: 1500, server_unit_minor: 1500, used_unit_minor: 1500, product_changed_after_snapshot: false, drift: 'none' });
    }
  });

  it('a product that changed after the snapshot but still has the same price is not drift', () => {
    expect(plan(request(), catalogue(product(P1, 15000n, { updatedAt: AFTER_SNAPSHOT })))).toMatchObject({ kind: 'accept', outcome: 'accepted' });
  });

  describe('D4 drift', () => {
    const higher = (extra: Partial<ServerProduct> = {}) => catalogue(product(P1, 15500n, { updatedAt: AFTER_SNAPSHOT, ...extra }));   // server now 1.550, shown 1.500
    it('honours the shown price when the product changed after the snapshot and the difference is within the limit', () => {
      const r = plan(request(), higher());   // line difference = (1500-1550) x 2 = -100
      expect(r).toMatchObject({ kind: 'accept', outcome: 'accepted_with_difference', orderTotalMinor: 3000, serverTotalMinor: 3100 });
      if (r.kind === 'accept') {
        expect(r.lines[0]).toMatchObject({ shownUnitMinor: 1500, serverUnitMinor: 1550, usedUnitMinor: 1500, honouredDrift: true });
        expect(r.lineDetails[0].drift).toBe('honoured');
      }
    });
    it('also honours a price the customer was shown that is HIGHER than the server now charges, within the limit', () => {
      const r = plan(request(), catalogue(product(P1, 14500n, { updatedAt: AFTER_SNAPSHOT })));   // server 1450, shown 1500: +100
      expect(r).toMatchObject({ kind: 'accept', outcome: 'accepted_with_difference', orderTotalMinor: 3000, serverTotalMinor: 2900 });
    });
    it('refuses the difference when the product did NOT change after the snapshot (a data error, not drift)', () => {
      expect(plan(request(), higher({ updatedAt: BEFORE_SNAPSHOT }))).toMatchObject({ kind: 'review', reason: 'price_drift_not_allowed', serverTotalMinor: 3100 });
      expect(plan(request(), higher({ updatedAt: SNAPSHOT }))).toMatchObject({ kind: 'review', reason: 'price_drift_not_allowed' });   // equal to the snapshot is not "after"
    });
    it('refuses a difference over the limit, per line and for the sale', () => {
      expect(plan(request(), higher(), 99)).toMatchObject({ kind: 'review', reason: 'price_drift_not_allowed' });
      expect(plan(request(), higher(), 100)).toMatchObject({ kind: 'accept', outcome: 'accepted_with_difference' });
      // two lines, each within the limit, but the net difference of the sale exceeds it
      const two = request({ lines: [{ productId: P1, quantity: 1, unitPriceShownMinor: 1000 }, { productId: P2, quantity: 1, unitPriceShownMinor: 1000 }], provisionalTotalMinor: 2000 });
      const cat = catalogue(product(P1, 13000n, { updatedAt: AFTER_SNAPSHOT }), product(P2, 13000n, { updatedAt: AFTER_SNAPSHOT }));
      expect(plan(two, cat, 400)).toMatchObject({ kind: 'review', reason: 'price_drift_not_allowed' });   // each line -300 (within 400), net -600 (over)
      expect(plan(two, cat, 600)).toMatchObject({ kind: 'accept', outcome: 'accepted_with_difference' });
    });
    it('with NO limit configured (limit 0 or invalid) every difference goes to review: it fails closed', () => {
      for (const limit of [0, -5, Number.NaN, 1.5]) expect(plan(request(), higher(), limit)).toMatchObject({ kind: 'review', reason: 'price_drift_not_allowed' });
      expect(plan(request(), catalogue(product(P1, 15000n)), 0)).toMatchObject({ kind: 'accept', outcome: 'accepted' });   // no difference, nothing to refuse
    });
    it('one refused line sends the whole sale to review, and no line is reported as honoured', () => {
      const two = request({ lines: [{ productId: P1, quantity: 1, unitPriceShownMinor: 1000 }, { productId: P2, quantity: 1, unitPriceShownMinor: 1000 }], provisionalTotalMinor: 2000 });
      const r = plan(two, catalogue(product(P1, 10100n, { updatedAt: AFTER_SNAPSHOT }), product(P2, 10100n, { updatedAt: BEFORE_SNAPSHOT })));
      expect(r.kind).toBe('review');
      if (r.kind === 'review') expect(r.lineDetails.map((d) => d.drift)).toEqual(['refused', 'refused']);
    });
  });

  it('sends an unknown, inactive or foreign product to review with no server total', () => {
    expect(plan(request(), catalogue())).toMatchObject({ kind: 'review', reason: 'product_unavailable', serverTotalMinor: null });
    expect(plan(request(), catalogue(product(P1, 15000n, { active: false })))).toMatchObject({ kind: 'review', reason: 'product_unavailable', serverTotalMinor: null });
    const two = request({ lines: [{ productId: P1, quantity: 1, unitPriceShownMinor: 1500 }, { productId: P2, quantity: 1, unitPriceShownMinor: 1500 }], provisionalTotalMinor: 3000 });
    expect(plan(two, catalogue(product(P1, 15000n)))).toMatchObject({ kind: 'review', reason: 'product_unavailable' });
  });

  it('sends a server price that is not an exact number of minor units to review as an invariant failure', () => {
    expect(plan(request(), catalogue(product(P1, 12345n)))).toMatchObject({ kind: 'review', reason: 'invariant_failed', serverTotalMinor: null });
  });

  it('checks the cash against the order total: short is underpaid, exact and over are accepted', () => {
    const cat = catalogue(product(P1, 15000n));
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 2999 }] }), cat)).toMatchObject({ kind: 'review', reason: 'underpaid', serverTotalMinor: 3000 });
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 3000 }] }), cat)).toMatchObject({ kind: 'accept' });
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 10000 }] }), cat)).toMatchObject({ kind: 'accept' });
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 1000 }, { method: 'cash', amountTenderedMinor: 2000 }] }), cat)).toMatchObject({ kind: 'accept' });
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 1000 }, { method: 'cash', amountTenderedMinor: 1999 }] }), cat)).toMatchObject({ kind: 'review', reason: 'underpaid' });
  });

  it('when drift is honoured the cash is judged against the price the customer saw, not the server\'s higher price', () => {
    const cat = catalogue(product(P1, 20000n, { updatedAt: AFTER_SNAPSHOT }));   // server 2000, shown 1500: drift -500 x 2 = -1000, outside limit 500
    expect(plan(request(), cat, 1000)).toMatchObject({ kind: 'accept', orderTotalMinor: 3000, serverTotalMinor: 4000 });
    expect(plan(request({ tenders: [{ method: 'cash', amountTenderedMinor: 3000 }] }), cat, 1000)).toMatchObject({ kind: 'accept' });
  });

  it('handles duplicate lines for one product and mixed quantities exactly', () => {
    const req = request({ lines: [{ productId: P1, quantity: 3, unitPriceShownMinor: 1500 }, { productId: P1, quantity: 2, unitPriceShownMinor: 1500 }, { productId: P2, quantity: 7, unitPriceShownMinor: 250 }], provisionalTotalMinor: 4500 + 3000 + 1750, tenders: [{ method: 'cash', amountTenderedMinor: 9250 }] });
    expect(plan(req, catalogue(product(P1, 15000n), product(P2, 2500n)))).toMatchObject({ kind: 'accept', outcome: 'accepted', orderTotalMinor: 9250, serverTotalMinor: 9250 });
  });

  it('property: over thousands of random sales an accepted plan never costs more than the cash, never carries unlisted drift, and honours only changed products within the limit', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    let accepted = 0; let reviewed = 0;
    for (let i = 0; i < 4000; i += 1) {
      const n = 1 + Math.floor(rnd() * 4);
      const ids = Array.from({ length: n }, () => randomUUID());
      const limit = Math.floor(rnd() * 400);
      const prods = ids.map((id) => product(id, BigInt(Math.floor(rnd() * 3000)) * 10n, { updatedAt: rnd() < 0.5 ? BEFORE_SNAPSHOT : AFTER_SNAPSHOT, active: rnd() < 0.95 }));
      const lines = ids.map((id, k) => {
        const server = Number(prods[k].priceScaled4 / 10n);
        const shown = Math.max(0, server + (rnd() < 0.5 ? 0 : Math.floor((rnd() - 0.5) * 300)));
        return { productId: id, quantity: 1 + Math.floor(rnd() * 5), unitPriceShownMinor: shown };
      });
      const total = lines.reduce((s, l) => s + l.quantity * l.unitPriceShownMinor, 0);
      const req = request({ lines, provisionalTotalMinor: total, tenders: [{ method: 'cash', amountTenderedMinor: Math.max(1, total + Math.floor((rnd() - 0.3) * 500)) }] });
      const r = planOfflineSale({ request: req, exponent: 3, products: catalogue(...prods), driftLimitMinor: limit });
      if (r.kind === 'review') { reviewed += 1; continue; }
      accepted += 1;
      const tendered = req.tenders[0].amountTenderedMinor;
      expect(r.orderTotalMinor).toBeLessThanOrEqual(tendered);
      expect(r.orderTotalMinor).toBe(r.lines.reduce((s, l) => s + l.quantity * l.usedUnitMinor, 0));
      const net = r.lines.reduce((s, l) => s + (l.shownUnitMinor - l.serverUnitMinor) * l.quantity, 0);
      expect(Math.abs(net)).toBeLessThanOrEqual(limit);
      for (const [k, l] of r.lines.entries()) {
        const diff = (l.shownUnitMinor - l.serverUnitMinor) * l.quantity;
        if (diff === 0) { expect(l.honouredDrift).toBe(false); expect(l.usedUnitMinor).toBe(l.serverUnitMinor); } else {
          expect(l.honouredDrift).toBe(true); expect(prods[k].updatedAt.getTime()).toBeGreaterThan(SNAPSHOT.getTime()); expect(Math.abs(diff)).toBeLessThanOrEqual(limit);
          expect(l.usedUnitMinor).toBe(l.shownUnitMinor);
        }
      }
      expect(r.outcome).toBe(r.lines.some((l) => l.honouredDrift) ? 'accepted_with_difference' : 'accepted');
    }
    expect(accepted).toBeGreaterThan(200);
    expect(reviewed).toBeGreaterThan(200);
  });
});
