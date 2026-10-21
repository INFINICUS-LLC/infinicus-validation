import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withSharedTenantTransaction, withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError } from './errors.js';
import { BusinessDeclaredCurrencyReader } from '../onboarding/index.js';
import { OrderRepository } from './OrderRepository.js';
import { PaymentError, type PaymentInput } from './tender.js';
import {
  minorToMajor, parseScaled4, planOfflineSale, requestDigest, validateOfflineSaleRequest,
  type LineDetail, type OfflineSaleConfig, type OfflineSaleOutcome, type OfflineSaleRequest, type ReviewReason, type ServerProduct,
} from './offlineSale.js';

export interface OfflineSaleResult {
  offlineSaleId: string;
  clientSaleId: string;
  outcome: OfflineSaleOutcome;
  /** True when this answer is the first recorded one returned again (the same client_sale_id and the same request). */
  replayed: boolean;
  orderId: string | null;
  orderNumber: string | null;
  currencyCode: string;
  deviceTotalMinor: number;
  /** What the server computed at its current prices; null when it could not (for example a product no longer exists). The server's figure is the record. */
  serverTotalMinor: number | null;
  /** server - device; null when serverTotalMinor is null. */
  differenceMinor: number | null;
  reviewReason: ReviewReason | null;
}

/** The domain errors that mean "this sale cannot be completed as sent" (so it is kept for review) and not "the system is broken" (which must surface). */
function isRecordableFailure(error: unknown): boolean {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof PaymentError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('23');   // integrity constraint violation class
}

const SAVEPOINT = 'offline_sale_order';

/**
 * Server side of offline selling (OFF-1). One call = one sale intent from a device. In ONE tenant transaction it either completes the sale through the
 * existing order code (create, add lines, complete: so every online rule, including the payments-equal-total trigger, still applies) or records why it could
 * not and creates NO order. Every call leaves exactly one offline_sales row. A replay returns the first answer; a replay with a different body is refused.
 *
 * What it does not do: resolve exceptions (OFF-4), enable offline selling, or decide the owner inputs (drift limits, clock bound): those arrive as `config`.
 */
export class OfflineSaleRepository {
  constructor(
    private readonly orders: Pick<OrderRepository, 'create' | 'addLineItem' | 'complete'> = new OrderRepository(),
    private readonly currencies: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'> = new BusinessDeclaredCurrencyReader(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(ctx: TenantContext, businessId: string, request: OfflineSaleRequest, config: OfflineSaleConfig): Promise<OfflineSaleResult> {
    const received = this.now();
    const { exponent } = validateOfflineSaleRequest(request, config, received);   // the door: malformed or untrustworthy requests store nothing
    const digest = requestDigest(request);
    return withSharedTenantTransaction(ctx, () => withTenantTransaction(ctx, (client) => this.processInTransaction(client, ctx, businessId, request, config, exponent, digest, received)));
  }

  private async processInTransaction(
    client: PoolClient, ctx: TenantContext, businessId: string, request: OfflineSaleRequest, config: OfflineSaleConfig,
    exponent: number, digest: string, received: Date,
  ): Promise<OfflineSaleResult> {
    // One sale at a time per (business, client_sale_id): a concurrent duplicate waits here and then finds the first answer below.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`offline-sale:${businessId}:${request.clientSaleId.toLowerCase()}`]);

    const existing = await client.query<Record<string, unknown>>(
      `SELECT s.*, o.order_number FROM business_operations.offline_sales s
         LEFT JOIN platform.orders o ON o.id = s.order_id
        WHERE s.business_id = $1 AND s.client_sale_id = $2`,
      [businessId, request.clientSaleId.toLowerCase()]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_digest !== digest) {
        throw new ConflictError('OfflineSale', `client_sale_id ${request.clientSaleId} was already used with a different request`);
      }
      return rowToResult(existing.rows[0], true);
    }

    const declared = await this.currencies.getCurrent(ctx, businessId);
    if (declared.status !== 'DECLARED') {
      throw new ConflictError('OfflineSale', `business ${businessId} has no declared currency; declare one before offline sales can be processed`);
    }

    const skewSeconds = Math.round((received.getTime() - request.deviceCreatedAt.getTime()) / 1000);
    const base = {
      tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId, request, digest, received, skewSeconds,
    };

    // The register session: it must be this business's, open, in the sale's currency, and open when the sale was made. FOR SHARE keeps it open until we finish.
    const sessionRes = await client.query<Record<string, unknown>>(
      `SELECT id, status, currency_code, opened_at FROM business_operations.register_sessions WHERE id = $1 AND business_id = $2 FOR SHARE`,
      [request.registerSessionId.toLowerCase(), businessId]
    );
    const session = sessionRes.rows[0];
    const detailsBare: LineDetail[] = request.lines.map((l) => ({
      product_id: l.productId.toLowerCase(), quantity: l.quantity, shown_unit_minor: l.unitPriceShownMinor,
      server_unit_minor: null, used_unit_minor: null, product_changed_after_snapshot: null, drift: null,
    }));
    const reviewRow = (reason: ReviewReason, serverTotalMinor: number | null, lineDetails: LineDetail[], verifiedSessionId: string | null) =>
      this.insertRow(client, ctx, base, { outcome: 'needs_review', reason, orderId: null, verifiedSessionId, serverTotalMinor, lineDetails });

    if (!session) return reviewRow('session_not_found', null, detailsBare, null);
    const sessionId = session.id as string;
    if (session.status !== 'open') return reviewRow('session_closed', null, detailsBare, sessionId);
    if (session.currency_code !== request.currencyCode || declared.current.currency !== request.currencyCode) {
      return reviewRow('session_currency_mismatch', null, detailsBare, sessionId);
    }
    const openedAt = session.opened_at as Date;
    if (request.deviceCreatedAt.getTime() + config.futureToleranceSeconds * 1000 < openedAt.getTime()) {
      return reviewRow('invariant_failed', null, detailsBare, sessionId);   // the sale predates the register session it claims
    }

    // The products, locked for the duration, loaded by business so a foreign product id simply is not found.
    const productIds = [...new Set(request.lines.map((l) => l.productId.toLowerCase()))];
    const productRows = await client.query<Record<string, unknown>>(
      `SELECT id, name, active, price::text AS price, updated_at FROM business_operations.products WHERE business_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
      [businessId, productIds]
    );
    const products = new Map<string, ServerProduct>();
    let unparsable = false;
    for (const r of productRows.rows) {
      const priceScaled4 = parseScaled4(String(r.price));
      if (priceScaled4 === null) { unparsable = true; continue; }
      products.set(String(r.id).toLowerCase(), { id: String(r.id), name: String(r.name), active: r.active === true, priceScaled4, updatedAt: r.updated_at as Date });
    }
    if (unparsable) return reviewRow('invariant_failed', null, detailsBare, sessionId);

    const plan = planOfflineSale({ request, exponent, products, driftLimitMinor: config.driftLimitMinorByCurrency[request.currencyCode] ?? 0 });
    if (plan.kind === 'review') return reviewRow(plan.reason, plan.serverTotalMinor, plan.lineDetails, sessionId);

    // Create and complete the order through the EXISTING order code, inside a savepoint: if anything refuses it, the order disappears and the sale is recorded for review.
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const created = await this.orders.create(ctx, { businessId });
      if (created.registerSessionId !== sessionId) throw new ConflictError('OfflineSale', 'the open register session is not the one the sale was made in');
      await client.query('UPDATE platform.orders SET client_sale_id = $1 WHERE id = $2 AND business_id = $3', [request.clientSaleId.toLowerCase(), created.id, businessId]);
      for (const line of plan.lines) {
        if (!line.honouredDrift) {
          await this.orders.addLineItem(ctx, created.id, businessId, { catalogProductId: line.productId, quantity: line.quantity });
        } else {
          // The customer-shown price is honoured (D4): a custom-priced line carrying the same provenance event a catalogue line gets.
          const after = await this.orders.addLineItem(ctx, created.id, businessId, {
            description: line.name, quantity: line.quantity, unitPrice: minorToMajor(line.usedUnitMinor, exponent), itemType: 'product',
          });
          const added = after.lineItems[after.lineItems.length - 1];
          await client.query(
            `INSERT INTO business_operations.order_events (tenant_id, workspace_id, business_id, order_id, event_type, payload, correlation_id)
             VALUES ($1,$2,$3,$4,'note',$5,$6)`,
            [ctx.tenantId, ctx.workspaceId, businessId, created.id,
              JSON.stringify({ kind: 'catalog_line_added', lineItemId: added.id, catalogProductId: line.productId, offline: true, shownUnitMinor: line.shownUnitMinor, serverUnitMinor: line.serverUnitMinor }),
              randomUUID()]
          );
        }
      }
      const payments: PaymentInput[] = request.tenders.map((t) => ({ method: 'cash', amountTendered: minorToMajor(t.amountTenderedMinor, exponent), reference: t.reference ?? null }));
      const completed = await this.orders.complete(ctx, created.id, businessId, payments);
      // The integer plan and the order code must agree to the minor unit. If they ever do not, nothing is recorded as a sale: the sale goes to review.
      if (Math.round(completed.totalAmount * 10 ** exponent) !== plan.orderTotalMinor) {
        throw new ConflictError('OfflineSale', `the order total ${completed.totalAmount} differs from the planned ${plan.orderTotalMinor} minor units`);
      }
      const result = await this.insertRow(client, ctx, base, {
        outcome: plan.outcome, reason: null, orderId: completed.id, verifiedSessionId: sessionId, serverTotalMinor: plan.serverTotalMinor, lineDetails: plan.lineDetails,
      });
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { ...result, orderNumber: completed.orderNumber };
    } catch (error) {
      if (!isRecordableFailure(error)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      // A payment that does not cover the order is the only PaymentError that means "underpaid"; any other refusal is an invariant the plan did not foresee.
      const short = error instanceof PaymentError && /short by/.test(error.message);
      return reviewRow(short ? 'underpaid' : 'invariant_failed', plan.serverTotalMinor, plan.lineDetails, sessionId);
    }
  }

  private async insertRow(
    client: PoolClient, ctx: TenantContext,
    base: { tenantId: string; workspaceId: string; businessId: string; request: OfflineSaleRequest; digest: string; received: Date; skewSeconds: number },
    r: { outcome: OfflineSaleOutcome; reason: ReviewReason | null; orderId: string | null; verifiedSessionId: string | null; serverTotalMinor: number | null; lineDetails: LineDetail[] },
  ): Promise<OfflineSaleResult> {
    const req = base.request;
    const difference = r.serverTotalMinor === null ? null : r.serverTotalMinor - req.provisionalTotalMinor;
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO business_operations.offline_sales
         (tenant_id, workspace_id, business_id, client_sale_id, device_id, claimed_register_session_id, register_session_id, order_id, outcome, review_reason,
          currency_code, device_created_at, received_at, clock_skew_seconds, catalogue_snapshot_at, device_total_minor, server_total_minor, difference_minor,
          request_digest, lines_detail, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [base.tenantId, base.workspaceId, base.businessId, req.clientSaleId.toLowerCase(), req.deviceId, req.registerSessionId.toLowerCase(), r.verifiedSessionId, r.orderId,
        r.outcome, r.reason, req.currencyCode, req.deviceCreatedAt, base.received, base.skewSeconds, req.catalogueSnapshotAt, req.provisionalTotalMinor, r.serverTotalMinor,
        difference, base.digest, JSON.stringify(r.lineDetails), ctx.userId]
    );
    return rowToResult(inserted.rows[0], false);
  }
}

function rowToResult(row: Record<string, unknown>, replayed: boolean): OfflineSaleResult {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    offlineSaleId: String(row.id),
    clientSaleId: String(row.client_sale_id),
    outcome: row.outcome as OfflineSaleOutcome,
    replayed,
    orderId: (row.order_id as string | null) ?? null,
    orderNumber: (row.order_number as string | null | undefined) ?? null,
    currencyCode: String(row.currency_code),
    deviceTotalMinor: Number(row.device_total_minor),
    serverTotalMinor: num(row.server_total_minor),
    differenceMinor: num(row.difference_minor),
    reviewReason: (row.review_reason as ReviewReason | null) ?? null,
  };
}

