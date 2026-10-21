/**
 * Offline sale planning (OFF-1 step 3): the PURE core of server offline sale processing. No database, no clock, no randomness.
 * Design: docs/implementation-queue/DESIGN-OFF-1-SERVER-OFFLINE-SALE-PROCESSING.md. Decisions: DECISION-RECORD-POS-9-OFFLINE-SELLING.md (D3, D4, D5).
 *
 * All money here is INTEGER MINOR UNITS of the sale's currency (KWD fils, USD cents, JPY yen); there is no floating point in this file.
 * A device sends the prices it showed and the total it printed; the server recomputes everything from its own current prices and decides:
 *   - accepted                    every shown price equals the server's current price;
 *   - accepted_with_difference    some shown price differs, and EVERY difference is allowed by the D4 drift policy (below);
 *   - needs_review                anything else. No order is created; the sale is kept for an owner/admin (OFF-4).
 *
 * D4 drift policy (accepted by the owner 2026-10-21): the price the customer was shown is honoured only if ALL hold:
 *   1. the product changed AFTER the catalogue snapshot the device used (updated_at > catalogue_snapshot_at);
 *   2. the difference (shown - server) x quantity, per line, is within the owner-set limit for the currency, and so is the whole-sale net difference;
 *   3. the shown price is not negative (the door already refuses that).
 * The limit is a parameter, never a built-in figure: a currency with no limit configured has limit ZERO, so every difference goes to review.
 */
import { createHash } from 'node:crypto';
import { minorUnitsOf, UnsupportedCurrencyError } from '../../currency/minorUnits.js';
import { looksLikeCardNumber, PAYMENT_REFERENCE_MAX } from './tender.js';

export type OfflineSaleOutcome = 'accepted' | 'accepted_with_difference' | 'needs_review';
export type ReviewReason =
  | 'session_not_found' | 'session_closed' | 'session_currency_mismatch' | 'product_unavailable'
  | 'price_drift_not_allowed' | 'underpaid' | 'invariant_failed' | 'other';

/** D3: an offline sale older than 24 hours is not accepted. */
export const OFFLINE_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Engineering bounds on one request (not business policy): they keep a single request small and its arithmetic inside safe integers. */
export const MAX_OFFLINE_LINES = 100;
export const MAX_OFFLINE_TENDERS = 10;
export const MAX_OFFLINE_QUANTITY = 100_000;

export interface OfflineSaleLineInput {
  /** The business catalogue product (business_operations.products.id). */
  productId: string;
  /** A whole number of units. */
  quantity: number;
  /** The unit price the device showed, in minor units. */
  unitPriceShownMinor: number;
}

export interface OfflineSaleTenderInput {
  /** Only cash is accepted offline (D5). */
  method: 'cash';
  /** What the customer handed over, in minor units. */
  amountTenderedMinor: number;
  reference?: string | null;
}

export interface OfflineSaleRequest {
  /** Device-generated identity of the sale; the idempotency key. */
  clientSaleId: string;
  deviceId: string;
  /** The register session the device says the sale belongs to. */
  registerSessionId: string;
  deviceCreatedAt: Date;
  catalogueSnapshotAt: Date;
  currencyCode: string;
  lines: OfflineSaleLineInput[];
  /** The total the device showed and printed as PROVISIONAL, in minor units. */
  provisionalTotalMinor: number;
  tenders: OfflineSaleTenderInput[];
}

export interface OfflineSaleConfig {
  /** Maximum age of a sale at receipt (D3: use OFFLINE_MAX_AGE_SECONDS). */
  maxAgeSeconds: number;
  /** How far in the future a device clock may be relative to the server before the sale is refused. REQUIRED: an owner-approved bound, no default. */
  futureToleranceSeconds: number;
  /** D4: tolerated price drift per currency, in minor units. Missing currency = 0 (every difference goes to review). */
  driftLimitMinorByCurrency: Readonly<Record<string, number>>;
}

/** A refused request: it is malformed or cannot be trusted at all, so nothing is stored. The API maps this name to 400. */
export class OfflineSaleRequestError extends Error {
  constructor(reason: string) {
    super(`Offline sale invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

const isSafeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/** Exponent of the currency, failing closed for an unsupported code. */
export function exponentOf(currencyCode: string): number {
  const exponent = minorUnitsOf(currencyCode);
  if (exponent === null) throw new UnsupportedCurrencyError(currencyCode);
  return exponent;
}

/** Minor units to the decimal number the rest of the platform stores (exact for every supported exponent). */
export function minorToMajor(minor: number, exponent: number): number {
  return minor / 10 ** exponent;
}

/**
 * Parse a PostgreSQL numeric(18,4) text value ("12.5000", "0.5") into an exact integer scaled by 10^4. Returns null when the text is not a plain
 * non-negative decimal with at most 4 fractional digits.
 */
export function parseScaled4(text: string): bigint | null {
  const [whole, fraction = '', extra] = text.trim().split('.');
  if (extra !== undefined || whole.length < 1 || whole.length > 14 || fraction.length > 4) return null;
  if (text.includes('.') && fraction.length === 0) return null;   // "1." is not a numeric(18,4) rendering
  if (!/^\d+$/.test(whole) || (fraction.length > 0 && !/^\d+$/.test(fraction))) return null;
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}

/** A server unit price (scaled by 10^4) as whole minor units, or null when it is not an exact number of minor units or not a safe integer. */
export function unitPriceMinor(priceScaled4: bigint, exponent: number): number | null {
  const divisor = 10n ** BigInt(4 - exponent);
  if (priceScaled4 % divisor !== 0n) return null;
  const minor = priceScaled4 / divisor;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

/** The door: everything about the request that can be refused without looking at the database. Throws OfflineSaleRequestError. */
export function validateOfflineSaleRequest(req: OfflineSaleRequest, config: OfflineSaleConfig, now: Date): { exponent: number } {
  const exponent = exponentOf(req.currencyCode);
  if (!/^[A-Z]{3}$/.test(req.currencyCode)) throw new OfflineSaleRequestError('the currency must be a three-letter upper-case code');
  if (!UUID.test(req.clientSaleId)) throw new OfflineSaleRequestError('client_sale_id must be a UUID');
  if (!DEVICE_ID.test(req.deviceId)) throw new OfflineSaleRequestError('device_id must be 1-64 characters from A-Z a-z 0-9 . _ : -');
  if (!UUID.test(req.registerSessionId)) throw new OfflineSaleRequestError('register_session_id must be a UUID');
  for (const [name, d] of [['device_created_at', req.deviceCreatedAt], ['catalogue_snapshot_at', req.catalogueSnapshotAt]] as const) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new OfflineSaleRequestError(`${name} must be a valid date-time`);
  }
  if (req.catalogueSnapshotAt.getTime() > req.deviceCreatedAt.getTime()) throw new OfflineSaleRequestError('the catalogue snapshot cannot be newer than the sale');
  if (!(config.maxAgeSeconds > 0) || !(config.futureToleranceSeconds >= 0)) throw new OfflineSaleRequestError('the offline sale configuration is invalid');
  const ageSeconds = (now.getTime() - req.deviceCreatedAt.getTime()) / 1000;
  if (ageSeconds > config.maxAgeSeconds) throw new OfflineSaleRequestError('the sale is older than the offline limit; it cannot be accepted');
  if (ageSeconds < -config.futureToleranceSeconds) throw new OfflineSaleRequestError('the device clock is ahead of the server beyond the tolerated bound');

  if (!Array.isArray(req.lines) || req.lines.length === 0) throw new OfflineSaleRequestError('at least one line is required');
  if (req.lines.length > MAX_OFFLINE_LINES) throw new OfflineSaleRequestError(`at most ${MAX_OFFLINE_LINES} lines per offline sale`);
  let shownTotal = 0;
  for (const [i, line] of req.lines.entries()) {
    if (!UUID.test(line.productId)) throw new OfflineSaleRequestError(`line ${i + 1}: product_id must be a UUID`);
    if (!isSafeInt(line.quantity) || line.quantity < 1 || line.quantity > MAX_OFFLINE_QUANTITY) {
      throw new OfflineSaleRequestError(`line ${i + 1}: quantity must be a whole number from 1 to ${MAX_OFFLINE_QUANTITY}`);
    }
    if (!isSafeInt(line.unitPriceShownMinor) || line.unitPriceShownMinor < 0) throw new OfflineSaleRequestError(`line ${i + 1}: the shown unit price must be a non-negative whole number of minor units`);
    const lineTotal = line.quantity * line.unitPriceShownMinor;
    shownTotal += lineTotal;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(shownTotal)) throw new OfflineSaleRequestError('the sale total is too large');
  }
  if (!isSafeInt(req.provisionalTotalMinor) || req.provisionalTotalMinor !== shownTotal) {
    throw new OfflineSaleRequestError('the provisional total does not equal the sum of the shown lines');
  }

  if (!Array.isArray(req.tenders) || req.tenders.length === 0) throw new OfflineSaleRequestError('a cash payment is required');
  if (req.tenders.length > MAX_OFFLINE_TENDERS) throw new OfflineSaleRequestError(`at most ${MAX_OFFLINE_TENDERS} payments per sale`);
  for (const [i, t] of req.tenders.entries()) {
    if (t.method !== 'cash') throw new OfflineSaleRequestError(`payment ${i + 1}: only cash is accepted offline`);
    if (!isSafeInt(t.amountTenderedMinor) || t.amountTenderedMinor <= 0) throw new OfflineSaleRequestError(`payment ${i + 1}: the amount must be a positive whole number of minor units`);
    const ref = typeof t.reference === 'string' ? t.reference.trim() : '';
    if (ref.length > PAYMENT_REFERENCE_MAX) throw new OfflineSaleRequestError(`payment ${i + 1}: the reference is too long`);
    if (looksLikeCardNumber(ref)) throw new OfflineSaleRequestError(`payment ${i + 1}: the reference looks like a card number`);
  }
  return { exponent };
}

/** SHA-256 of the canonical request, so a replay with a different body under the same client_sale_id is detectable. Order of lines and payments matters. */
export function requestDigest(req: OfflineSaleRequest): string {
  const canonical = JSON.stringify({
    clientSaleId: req.clientSaleId.toLowerCase(),
    deviceId: req.deviceId,
    registerSessionId: req.registerSessionId.toLowerCase(),
    deviceCreatedAt: req.deviceCreatedAt.toISOString(),
    catalogueSnapshotAt: req.catalogueSnapshotAt.toISOString(),
    currencyCode: req.currencyCode,
    lines: req.lines.map((l) => [l.productId.toLowerCase(), l.quantity, l.unitPriceShownMinor]),
    provisionalTotalMinor: req.provisionalTotalMinor,
    tenders: req.tenders.map((t) => [t.method, t.amountTenderedMinor, (t.reference ?? '').trim()]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** What the server knows about a product at processing time. `priceScaled4` is the exact numeric(18,4) price scaled by 10^4. */
export interface ServerProduct {
  id: string;
  name: string;
  active: boolean;
  priceScaled4: bigint;
  updatedAt: Date;
}

export interface PlannedLine {
  productId: string;
  name: string;
  quantity: number;
  shownUnitMinor: number;
  serverUnitMinor: number;
  /** The unit price the order will carry: the shown price when drift was honoured, otherwise the server's. */
  usedUnitMinor: number;
  honouredDrift: boolean;
}

/** One line as stored in offline_sales.lines_detail: the device's claim and the server's result. No names, no customer data. */
export interface LineDetail {
  product_id: string;
  quantity: number;
  shown_unit_minor: number;
  server_unit_minor: number | null;
  used_unit_minor: number | null;
  product_changed_after_snapshot: boolean | null;
  drift: 'none' | 'honoured' | 'refused' | null;
}

export type OfflineSalePlan =
  | { kind: 'review'; reason: ReviewReason; serverTotalMinor: number | null; lineDetails: LineDetail[] }
  | {
      kind: 'accept';
      outcome: 'accepted' | 'accepted_with_difference';
      orderTotalMinor: number;
      serverTotalMinor: number;
      lines: PlannedLine[];
      lineDetails: LineDetail[];
    };

const review = (reason: ReviewReason, serverTotalMinor: number | null, lineDetails: LineDetail[]): OfflineSalePlan => ({ kind: 'review', reason, serverTotalMinor, lineDetails });

/**
 * Decide the outcome of a (door-validated) request against the server's current products. Pure and total: it never throws for data it can judge.
 * Precedence of review reasons: product_unavailable, invariant_failed (a price that is not an exact number of minor units), price_drift_not_allowed, underpaid.
 */
export function planOfflineSale(args: {
  request: OfflineSaleRequest;
  exponent: number;
  products: ReadonlyMap<string, ServerProduct>;
  driftLimitMinor: number;
}): OfflineSalePlan {
  const { request, exponent, products } = args;
  const limit = Number.isSafeInteger(args.driftLimitMinor) && args.driftLimitMinor > 0 ? args.driftLimitMinor : 0;
  const snapshot = request.catalogueSnapshotAt.getTime();

  const bare: LineDetail[] = request.lines.map((l) => ({
    product_id: l.productId.toLowerCase(), quantity: l.quantity, shown_unit_minor: l.unitPriceShownMinor,
    server_unit_minor: null, used_unit_minor: null, product_changed_after_snapshot: null, drift: null,
  }));

  // 1. every product must exist, belong to the business (the caller loaded by business) and be active
  for (const l of request.lines) {
    const p = products.get(l.productId.toLowerCase());
    if (!p || !p.active) return review('product_unavailable', null, bare);
  }

  // 2. the server's own unit prices, exact in minor units
  const details: LineDetail[] = [];
  const serverUnits: number[] = [];
  for (const [i, l] of request.lines.entries()) {
    const p = products.get(l.productId.toLowerCase()) as ServerProduct;
    const unit = unitPriceMinor(p.priceScaled4, exponent);
    const changed = p.updatedAt.getTime() > snapshot;
    details.push({ ...bare[i], server_unit_minor: unit, product_changed_after_snapshot: changed });
    if (unit === null) return review('invariant_failed', null, details);
    serverUnits.push(unit);
  }

  // 3. totals at the server's current prices (safe-integer checked: an overflow is an invariant failure, not a wrong number)
  let serverTotal = 0;
  for (const [i, l] of request.lines.entries()) {
    serverTotal += l.quantity * serverUnits[i];
    if (!Number.isSafeInteger(serverTotal)) return review('invariant_failed', null, details);
  }

  // 4. D4 drift policy
  let netDifference = 0;
  let anyDifference = false;
  let refused = false;
  const planned: PlannedLine[] = [];
  for (const [i, l] of request.lines.entries()) {
    const p = products.get(l.productId.toLowerCase()) as ServerProduct;
    const serverUnit = serverUnits[i];
    const lineDifference = (l.unitPriceShownMinor - serverUnit) * l.quantity;
    if (lineDifference === 0) {
      details[i].used_unit_minor = serverUnit; details[i].drift = 'none';
      planned.push({ productId: l.productId.toLowerCase(), name: p.name, quantity: l.quantity, shownUnitMinor: l.unitPriceShownMinor, serverUnitMinor: serverUnit, usedUnitMinor: serverUnit, honouredDrift: false });
      continue;
    }
    anyDifference = true;
    netDifference += lineDifference;
    const allowed = details[i].product_changed_after_snapshot === true && Math.abs(lineDifference) <= limit;
    details[i].drift = allowed ? 'honoured' : 'refused';
    details[i].used_unit_minor = allowed ? l.unitPriceShownMinor : null;
    if (!allowed) refused = true;
    planned.push({ productId: l.productId.toLowerCase(), name: p.name, quantity: l.quantity, shownUnitMinor: l.unitPriceShownMinor, serverUnitMinor: serverUnit, usedUnitMinor: allowed ? l.unitPriceShownMinor : serverUnit, honouredDrift: allowed });
  }
  if (refused || Math.abs(netDifference) > limit) {
    for (const d of details) if (d.drift === 'honoured') d.drift = 'refused';
    return review('price_drift_not_allowed', serverTotal, details);
  }

  // 5. what the order will total, and whether the cash covers it (the database independently insists on exactness: migration 0206)
  const orderTotal = planned.reduce((sum, l) => sum + l.quantity * l.usedUnitMinor, 0);
  const tendered = request.tenders.reduce((sum, t) => sum + t.amountTenderedMinor, 0);
  if (!Number.isSafeInteger(orderTotal) || !Number.isSafeInteger(tendered)) return review('invariant_failed', serverTotal, details);
  if (tendered < orderTotal) return review('underpaid', serverTotal, details);

  return {
    kind: 'accept',
    outcome: anyDifference ? 'accepted_with_difference' : 'accepted',
    orderTotalMinor: orderTotal,
    serverTotalMinor: serverTotal,
    lines: planned,
    lineDetails: details,
  };
}
