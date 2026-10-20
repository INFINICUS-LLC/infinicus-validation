import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';
import { BusinessDeclaredCurrencyReader } from '../onboarding/index.js';
import { minorUnitsOf, roundToCurrency, UnsupportedCurrencyError } from '../../currency/minorUnits.js';
import { planPayments, type PaymentInput, type TenderMethod } from './tender.js';
import { planDiscount } from './discount.js';
import { planNote } from './note.js';

export type OrderOperationalStatus = 'planned' | 'authorized' | 'executed' | 'completed' | 'failed' | 'reversed';

export interface CreateOrderInput {
  businessId: string;
  customerId?: string;
}

// The sellable BO catalog and platform.products have distinct identities.
// Catalog selections are resolved by BO; canonical product references remain separate.
export type AddLineItemInput = {
  catalogProductId: string;
  quantity: number;
} | {
  description: string;
  quantity: number;
  unitPrice: number;
  productId?: string;
  itemType?: 'product' | 'service' | 'fee' | 'discount' | 'other';
};

export interface OrderLineItem {
  id: string;
  lineNumber: number;
  itemType: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OrderPayment {
  id: string;
  position: number;
  method: TenderMethod;
  currencyCode: string;
  amountTendered: number;
  amountApplied: number;
  changeGiven: number;
  reference: string | null;
  createdAt: Date;
}

export interface Order {
  id: string;
  businessId: string;
  customerId: string | null;
  orderNumber: string;
  orderDate: Date;
  currencyCode: string;
  /** The register session the order was taken in; null for orders taken before register linking (migration 0202). */
  registerSessionId: string | null;
  /** The cashier's internal note on the order (POS-6c, migration 0207); null when there is none. Editable only while the order is open. */
  note: string | null;
  totalAmount: number;
  operationalStatus: OrderOperationalStatus;
  createdAt: Date;
  updatedAt: Date;
  lineItems: OrderLineItem[];
  /** The tender taken when the order was completed (empty until then). */
  payments: OrderPayment[];
  /** Change to hand back: the sum of the cash change of the payments (0 until completed). */
  changeDue: number;
}

/** Quantities (not money) keep two decimals. Money is rounded to the order's currency with roundToCurrency (KWD 3, USD 2, JPY 0). */
function roundQuantity(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

function rowToLineItem(row: Record<string, unknown>): OrderLineItem {
  return {
    id: row.id as string,
    lineNumber: row.line_number as number,
    itemType: row.item_type as string,
    productId: row.product_id as string | null,
    description: row.description as string,
    quantity: parseFloat(String(row.quantity)),
    unitPrice: parseFloat(String(row.unit_price)),
    lineTotal: parseFloat(String(row.line_total)),
  };
}

function rowToPayment(row: Record<string, unknown>): OrderPayment {
  return {
    id: row.id as string,
    position: row.position as number,
    method: row.method as TenderMethod,
    currencyCode: row.currency_code as string,
    amountTendered: parseFloat(String(row.amount_tendered)),
    amountApplied: parseFloat(String(row.amount_applied)),
    changeGiven: parseFloat(String(row.change_given)),
    reference: (row.reference as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

function rowToOrder(row: Record<string, unknown>, lineItems: OrderLineItem[], payments: OrderPayment[] = []): Order {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    customerId: row.customer_id as string | null,
    orderNumber: row.order_number as string,
    orderDate: row.order_date as Date,
    currencyCode: row.currency_code as string,
    registerSessionId: (row.register_session_id as string | null) ?? null,
    note: (row.note as string | null | undefined) ?? null,
    totalAmount: parseFloat(String(row.total_amount)),
    operationalStatus: row.operational_status as OrderOperationalStatus,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lineItems,
    payments,
    changeDue: payments.reduce((sum, p) => sum + p.changeGiven, 0),
  };
}

function generateOrderNumber(): string {
  return 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + randomUUID().slice(0, 4).toUpperCase();
}

/**
 * A cart/order sits on top of the canonical platform.orders +
 * business_operations.order_line_items / order_events tables, already
 * migrated as part of the original platform build-out but never given a
 * repository until now. Completing an order writes a business_events
 * 'sale' row in the same transaction, so the existing KPI summary / Digital
 * Twin / register-session close-out — all of which read business_events —
 * pick it up with no changes of their own.
 */
export class OrderRepository {
  constructor(private readonly currencies: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'> = new BusinessDeclaredCurrencyReader()) {}

  /**
   * A new order takes the business's DECLARED currency (Business Administration, migration 0185), read through the governed read-only
   * boundary. An undeclared business fails closed with a ConflictError: there is no default currency and the database column default is
   * never relied on.
   */
  async create(ctx: TenantContext, input: CreateOrderInput): Promise<Order> {
    const state = await this.currencies.getCurrent(ctx, input.businessId);
    if (state.status !== 'DECLARED') {
      throw new ConflictError('Order', `business ${input.businessId} has no declared currency; declare one before creating orders`);
    }
    const currencyCode = state.current.currency;
    if (minorUnitsOf(currencyCode) === null) throw new UnsupportedCurrencyError(currencyCode);   // fail closed: an unknown exponent would mis-state money
    return withTenantTransaction(ctx, async (client) => {
      // POS-4: an order is taken in the business's open register session. FOR SHARE keeps the session from being closed under us until this
      // transaction ends. No open register, or a register whose currency is not the declared one (opened earlier, or before 0202), fails closed.
      const open = await client.query<Record<string, unknown>>(
        `SELECT id, currency_code FROM business_operations.register_sessions WHERE business_id = $1 AND status = 'open' FOR SHARE`,
        [input.businessId]
      );
      if (open.rows.length === 0) {
        throw new ConflictError('Order', `no register session is open for business ${input.businessId}; open the register first`);
      }
      if (open.rows[0].currency_code !== currencyCode) {
        throw new ConflictError('Order', `the open register session is not in the business's declared currency ${currencyCode}; close it and open a new one`);
      }
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO platform.orders
           (tenant_id, workspace_id, business_id, customer_id, order_number, order_date, currency_code, register_session_id, operational_status, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,'planned',$8,$9)
         RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.customerId ?? null, generateOrderNumber(), currencyCode, open.rows[0].id, randomUUID(), ctx.userId]
      );
      return rowToOrder(result.rows[0], []);
    });
  }

  private async loadLineItems(client: PoolClient, orderId: string): Promise<OrderLineItem[]> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM business_operations.order_line_items WHERE order_id = $1 ORDER BY line_number`,
      [orderId]
    );
    return result.rows.map(rowToLineItem);
  }

  private async loadPayments(client: PoolClient, orderId: string): Promise<OrderPayment[]> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM business_operations.order_payments WHERE order_id = $1 ORDER BY position`,
      [orderId]
    );
    return result.rows.map(rowToPayment);
  }

  private async loadOrderRow(client: PoolClient, orderId: string, businessId: string, lock = false): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM platform.orders WHERE id = $1 AND business_id = $2${lock ? ' FOR UPDATE' : ''}`, [orderId, businessId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Order', orderId);
    return result.rows[0];
  }

  async getById(ctx: TenantContext, orderId: string, businessId: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      const payments = await this.loadPayments(client, orderId);
      return rowToOrder(row, lineItems, payments);
    });
  }

  async list(ctx: TenantContext, businessId: string, opts: { status?: OrderOperationalStatus; limit?: number; before?: string } = {}): Promise<Order[]> {
    return withTenantTransaction(ctx, async (client) => {
      const conditions = ['business_id = $1'];
      const params: unknown[] = [businessId];
      if (opts.status) {
        params.push(opts.status);
        conditions.push(`operational_status = $${params.length}`);
      }
      if (opts.before) {
        await this.loadOrderRow(client, opts.before, businessId);
        params.push(opts.before);
        // Keep timestamp precision in PostgreSQL and break ties by ID. A concurrent new sale cannot shift older pages.
        conditions.push(`(created_at, id) < (SELECT created_at, id FROM platform.orders WHERE id = $${params.length} AND business_id = $1)`);
      }
      params.push(opts.limit ?? 20);
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM platform.orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params
      );
      return result.rows.map((row) => rowToOrder(row, []));
    });
  }

  async addLineItem(ctx: TenantContext, orderId: string, businessId: string, input: AddLineItemInput): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      let selected: Exclude<AddLineItemInput, { catalogProductId: string }>;
      if ('catalogProductId' in input) {
        const catalog = await client.query<Record<string, unknown>>(
          `SELECT name, price FROM business_operations.products WHERE id = $1 AND business_id = $2 AND active = true FOR SHARE`,
          [input.catalogProductId, businessId]
        );
        if (!catalog.rows[0]) throw new NotFoundError('Product', input.catalogProductId);
        selected = { description: catalog.rows[0].name as string, unitPrice: Number(catalog.rows[0].price), quantity: input.quantity, itemType: 'product' };
      } else {
        selected = input;
      }
      const nextLine = await client.query<Record<string, unknown>>(
        `SELECT COALESCE(MAX(line_number), 0) + 1 AS next FROM business_operations.order_line_items WHERE order_id = $1`,
        [orderId]
      );
      const lineNumber = Number(nextLine.rows[0].next);
      const lineTotal = roundToCurrency(selected.quantity * selected.unitPrice, order.currency_code as string);
      const added = await client.query<{ id: string }>(
        `INSERT INTO business_operations.order_line_items
           (tenant_id, workspace_id, business_id, order_id, line_number, item_type, product_id, description, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          ctx.tenantId, ctx.workspaceId, businessId, orderId, lineNumber,
          selected.itemType ?? 'product', selected.productId ?? null, selected.description,
          selected.quantity, selected.unitPrice, lineTotal,
        ]
      );
      if ('catalogProductId' in input) {
        // Persist catalog provenance with the snapshot, without putting a BO ID in the canonical FK.
        await client.query(
          `INSERT INTO business_operations.order_events
             (tenant_id, workspace_id, business_id, order_id, event_type, payload, correlation_id)
           VALUES ($1,$2,$3,$4,'note',$5,$6)`,
          [ctx.tenantId, ctx.workspaceId, businessId, orderId,
            JSON.stringify({ kind: 'catalog_line_added', lineItemId: added.rows[0].id, catalogProductId: input.catalogProductId }), randomUUID()]
        );
      }
      await this.recomputeTotal(client, orderId);
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  async removeLineItem(ctx: TenantContext, orderId: string, lineItemId: string, businessId: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      const deleted = await client.query(
        `DELETE FROM business_operations.order_line_items WHERE id = $1 AND order_id = $2`,
        [lineItemId, orderId]
      );
      if (deleted.rowCount === 0) throw new NotFoundError('OrderLineItem', lineItemId);
      await this.recomputeTotal(client, orderId);
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  async updateLineQuantity(ctx: TenantContext, orderId: string, lineItemId: string, businessId: string, quantity: number): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') throw new ConflictError('Order', 'only planned orders can be edited');
      const line = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.order_line_items WHERE id = $1 AND order_id = $2`, [lineItemId, orderId]
      );
      if (!line.rows[0]) throw new NotFoundError('OrderLineItem', lineItemId);
      const item = line.rows[0];
      // POS-6b: a discount is created only through addDiscount (owner/admin); changing its quantity would multiply it past that check.
      if (item.item_type === 'discount') throw new ConflictError('OrderLineItem', 'a discount line cannot be edited; remove it and add a new discount');
      // Keep the captured price and any existing line discount/tax; never reprice an existing order from the catalog.
      const total = roundToCurrency(quantity * Number(item.unit_price) * (1 - Number(item.discount_rate)) * (1 + Number(item.tax_rate)), order.currency_code as string);
      await client.query(
        `UPDATE business_operations.order_line_items SET quantity = $3, line_total = $4 WHERE id = $1 AND order_id = $2`,
        [lineItemId, orderId, quantity, total]
      );
      await this.recomputeTotal(client, orderId);
      return rowToOrder(await this.loadOrderRow(client, orderId, businessId), await this.loadLineItems(client, orderId));
    });
  }

  /**
   * Set or clear the note of an open order (POS-6c). The text is planned first (trimmed, empty clears, at most 500 characters, never a card number); the order
   * row is locked so the status check and the write cannot interleave with a completion. A note is read-only once the order is completed or voided. Each change
   * leaves an order event recording that a note was set or cleared (not its text).
   */
  async setNote(ctx: TenantContext, orderId: string, businessId: string, input: string | null): Promise<Order> {
    const note = planNote(input);
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      await client.query(`UPDATE platform.orders SET note = $2 WHERE id = $1`, [orderId, note]);
      await client.query(
        `INSERT INTO business_operations.order_events
           (tenant_id, workspace_id, business_id, order_id, event_type, payload, correlation_id)
         VALUES ($1,$2,$3,$4,'note',$5,$6)`,
        [ctx.tenantId, ctx.workspaceId, businessId, orderId,
          JSON.stringify({ kind: note === null ? 'order_note_cleared' : 'order_note_set', length: note === null ? 0 : note.length }), randomUUID()]
      );
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  /**
   * Take an amount off an open order (POS-6b). Stored as a SIGNED line (item_type 'discount'), so the total stays the sum of the lines. The order row
   * is locked so two discounts added at once cannot together take the total below zero. Who may do this is decided by the API (permission bo:admin).
   */
  async addDiscount(ctx: TenantContext, orderId: string, businessId: string, input: { amount: number; reason?: string | null }): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      const existing = await client.query<Record<string, unknown>>(
        `SELECT count(*)::int AS n FROM business_operations.order_line_items WHERE order_id = $1 AND item_type = 'discount'`,
        [orderId]
      );
      const planned = planDiscount(Number(order.total_amount), order.currency_code as string, input.amount, input.reason, Number(existing.rows[0].n));
      const nextLine = await client.query<Record<string, unknown>>(
        `SELECT COALESCE(MAX(line_number), 0) + 1 AS next FROM business_operations.order_line_items WHERE order_id = $1`,
        [orderId]
      );
      await client.query(
        `INSERT INTO business_operations.order_line_items
           (tenant_id, workspace_id, business_id, order_id, line_number, item_type, product_id, description, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,'discount',NULL,$6,$7,$8,$9)`,
        [ctx.tenantId, ctx.workspaceId, businessId, orderId, Number(nextLine.rows[0].next), planned.description, planned.quantity, planned.unitPrice, planned.lineTotal]
      );
      await this.recomputeTotal(client, orderId);
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  private async recomputeTotal(client: PoolClient, orderId: string): Promise<void> {
    const updated = await client.query<{ total_amount: string }>(
      `UPDATE platform.orders SET total_amount = (
         SELECT COALESCE(SUM(line_total), 0) FROM business_operations.order_line_items WHERE order_id = $1
       ) WHERE id = $1 RETURNING total_amount`,
      [orderId]
    );
    // POS-6b: with discounts on the order, removing a line or lowering a quantity could leave the discounts larger than the rest. Every edit path ends
    // here, so one check covers them all; the throw rolls the whole transaction back, so the edit does not happen and the cashier removes the discount first.
    if (updated.rows[0] && Number(updated.rows[0].total_amount) < 0) {
      throw new ConflictError('Order', 'this change would leave the discounts larger than the order; remove the discount first');
    }
  }

  /**
   * Complete an order and record its tender in ONE transaction (POS-5). `payments` are what the cashier entered; the rows stored (applied amount,
   * change) are computed here, exactly, in the order's currency. The database independently refuses an order whose applied payments do not equal
   * its total (migration 0206). An order with a non-zero total cannot be completed without payment.
   */
  async complete(ctx: TenantContext, orderId: string, businessId: string, payments: readonly PaymentInput[] = []): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      // The order row is locked so two completions of the same order serialise; the second then sees it completed and is refused.
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} cannot be completed (status: ${order.operational_status})`);
      }
      const lineItems = await this.loadLineItems(client, orderId);
      if (lineItems.length === 0) {
        throw new ConflictError('Order', `order ${orderId} has no line items to complete`);
      }
      // POS-4: a sale is recorded only into a register session that is still open. An order taken before register linking (no session) cannot be
      // completed: void it and start a new one. FOR SHARE keeps the session from being closed while this transaction completes the sale.
      if (order.register_session_id === null || order.register_session_id === undefined) {
        throw new ConflictError('Order', `order ${orderId} was taken before register linking; void it and start a new order`);
      }
      const session = await client.query<Record<string, unknown>>(
        `SELECT status FROM business_operations.register_sessions WHERE id = $1 FOR SHARE`,
        [order.register_session_id]
      );
      if (session.rows.length === 0 || session.rows[0].status !== 'open') {
        throw new ConflictError('Order', `the register session of order ${orderId} is closed; the sale cannot be recorded into it`);
      }
      const planned = planPayments(Number(order.total_amount), order.currency_code as string, payments);
      await client.query(
        `UPDATE platform.orders SET operational_status = 'completed', version = version + 1 WHERE id = $1`,
        [orderId]
      );
      for (const p of planned) {
        await client.query(
          `INSERT INTO business_operations.order_payments
             (tenant_id, workspace_id, business_id, order_id, register_session_id, position, method, currency_code,
              amount_tendered, amount_applied, change_given, reference, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [ctx.tenantId, ctx.workspaceId, businessId, orderId, order.register_session_id, p.position, p.method, p.currencyCode,
           p.amountTendered, p.amountApplied, p.changeGiven, p.reference, ctx.userId]
        );
      }
      await client.query(
        `INSERT INTO business_operations.order_events
           (tenant_id, workspace_id, business_id, order_id, event_type, previous_status, new_status, correlation_id)
         VALUES ($1,$2,$3,$4,'completed','planned','completed',$5)`,
        [ctx.tenantId, ctx.workspaceId, businessId, orderId, randomUUID()]
      );
      // A discount line is money off, not a unit sold: it does not count towards the quantity of the sale.
      const totalQuantity = roundQuantity(lineItems.filter((li) => li.itemType !== 'discount').reduce((sum, li) => sum + li.quantity, 0));
      await client.query(
        `INSERT INTO business_operations.business_events
           (tenant_id, workspace_id, business_id, event_type, amount, quantity, customer_id, notes, correlation_id)
         VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,$8)`,
        [
          ctx.tenantId, ctx.workspaceId, businessId,
          Number(order.total_amount), totalQuantity, order.customer_id ?? null,
          `Order ${order.order_number as string}`, orderId,
        ]
      );
      const row = await this.loadOrderRow(client, orderId, businessId);
      const stored = await this.loadPayments(client, orderId);
      return rowToOrder(row, lineItems, stored);
    });
  }

  async void(ctx: TenantContext, orderId: string, businessId: string, reason?: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId, businessId, true);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} cannot be voided (status: ${order.operational_status})`);
      }
      await client.query(
        `UPDATE platform.orders SET operational_status = 'failed', version = version + 1 WHERE id = $1`,
        [orderId]
      );
      await client.query(
        `INSERT INTO business_operations.order_events
           (tenant_id, workspace_id, business_id, order_id, event_type, previous_status, new_status, notes, correlation_id)
         VALUES ($1,$2,$3,$4,'failed','planned','failed',$5,$6)`,
        [ctx.tenantId, ctx.workspaceId, businessId, orderId, reason ?? null, randomUUID()]
      );
      const row = await this.loadOrderRow(client, orderId, businessId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }
}
