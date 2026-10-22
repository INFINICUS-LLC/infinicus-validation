import { z } from 'zod';
import { OFFLINE_MAX_AGE_SECONDS, MAX_OFFLINE_LINES, MAX_OFFLINE_QUANTITY, MAX_OFFLINE_TENDERS } from '@infinicus/database';

export { businessIdParamsSchema } from './orders.js';

const uuid = z.string().uuid();
const minor = z.number().int().safe();

/**
 * One offline sale intent (OFF-1). Every money amount is a whole number of MINOR units of `currencyCode` (KWD fils, USD cents, JPY yen); there is no
 * decimal money on this surface. Unknown keys are refused, so a client cannot smuggle authority (tenant, workspace, user, status, totals the server owns).
 * The Idempotency-Key header must equal `clientSaleId`.
 */
export const offlineSaleBodySchema = z.object({
  clientSaleId: uuid,
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  registerSessionId: uuid,
  deviceCreatedAt: z.string().datetime({ offset: true }),
  catalogueSnapshotAt: z.string().datetime({ offset: true }),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(z.object({
    productId: uuid,
    quantity: z.number().int().min(1).max(MAX_OFFLINE_QUANTITY),
    unitPriceShownMinor: minor.min(0),
  }).strict()).min(1).max(MAX_OFFLINE_LINES),
  provisionalTotalMinor: minor.min(0),
  tenders: z.array(z.object({
    method: z.literal('cash'),
    amountTenderedMinor: minor.min(1),
    reference: z.string().max(64).nullish(),
  }).strict()).min(1).max(MAX_OFFLINE_TENDERS),
}).strict();

export const offlineSaleResponseSchema = z.object({
  offlineSaleId: uuid,
  clientSaleId: uuid,
  outcome: z.enum(['accepted', 'accepted_with_difference', 'needs_review']),
  /** True when this is the first recorded answer returned again. */
  replayed: z.boolean(),
  orderId: uuid.nullable(),
  orderNumber: z.string().nullable(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  deviceTotalMinor: z.number().int(),
  /** The server's total at its current prices: the record. Null when it could not be computed. */
  serverTotalMinor: z.number().int().nullable(),
  differenceMinor: z.number().int().nullable(),
  reviewReason: z.enum(['session_not_found', 'session_closed', 'session_currency_mismatch', 'product_unavailable', 'price_drift_not_allowed', 'underpaid', 'invariant_failed', 'other']).nullable(),
});

/** The age limit is a decided rule (D3), exported for the contract test. */
export const OFFLINE_SALE_MAX_AGE_SECONDS = OFFLINE_MAX_AGE_SECONDS;
