import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';
import { BusinessDeclaredCurrencyReader } from '../onboarding/index.js';

export type OrderOperationalStatus = 'planned' | 'authorized' | 'executed' | 'completed' | 'failed' | 'reversed';

export interface CreateOrderInput {
  businessId: string;
  customerId?: string;
}

// productId, when given, links to the canonical platform.products catalog —
// a separate, richer entity from business_operations.products (the
// lightweight tap-to-sell catalog built for the Foodics-style Catalog tab).
// Reconciling the two catalogs is out of scope here: the Catalog UI adds
// line items by description/price only, leaving productId unset.
export interface AddLineItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
  productId?: string;
  itemType?: 'product' | 'service' | 'fee' | 'discount' | 'other';
}

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

export interface Order {
  id: string;
  businessId: string;
  customerId: string | null;
  orderNumber: string;
  orderDate: Date;
  currencyCode: string;
  totalAmount: number;
  operationalStatus: OrderOperationalStatus;
  createdAt: Date;
  updatedAt: Date;
  lineItems: OrderLineItem[];
}

function round2(n: number): number {
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

function rowToOrder(row: Record<string, unknown>, lineItems: OrderLineItem[]): Order {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    customerId: row.customer_id as string | null,
    orderNumber: row.order_number as string,
    orderDate: row.order_date as Date,
    currencyCode: row.currency_code as string,
    totalAmount: parseFloat(String(row.total_amount)),
    operationalStatus: row.operational_status as OrderOperationalStatus,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lineItems,
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
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO platform.orders
           (tenant_id, workspace_id, business_id, customer_id, order_number, order_date, currency_code, operational_status, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,'planned',$7,$8)
         RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.customerId ?? null, generateOrderNumber(), currencyCode, randomUUID(), ctx.userId]
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

  private async loadOrderRow(client: PoolClient, orderId: string): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(`SELECT * FROM platform.orders WHERE id = $1`, [orderId]);
    if (result.rows.length === 0) throw new NotFoundError('Order', orderId);
    return result.rows[0];
  }

  async getById(ctx: TenantContext, orderId: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const row = await this.loadOrderRow(client, orderId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  async list(ctx: TenantContext, businessId: string, opts: { status?: OrderOperationalStatus; limit?: number } = {}): Promise<Order[]> {
    return withTenantTransaction(ctx, async (client) => {
      const conditions = ['business_id = $1'];
      const params: unknown[] = [businessId];
      if (opts.status) {
        params.push(opts.status);
        conditions.push(`operational_status = $${params.length}`);
      }
      params.push(opts.limit ?? 20);
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM platform.orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      return result.rows.map((row) => rowToOrder(row, []));
    });
  }

  async addLineItem(ctx: TenantContext, orderId: string, businessId: string, input: AddLineItemInput): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      const nextLine = await client.query<Record<string, unknown>>(
        `SELECT COALESCE(MAX(line_number), 0) + 1 AS next FROM business_operations.order_line_items WHERE order_id = $1`,
        [orderId]
      );
      const lineNumber = Number(nextLine.rows[0].next);
      const lineTotal = round2(input.quantity * input.unitPrice);
      await client.query(
        `INSERT INTO business_operations.order_line_items
           (tenant_id, workspace_id, business_id, order_id, line_number, item_type, product_id, description, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          ctx.tenantId, ctx.workspaceId, businessId, orderId, lineNumber,
          input.itemType ?? 'product', input.productId ?? null, input.description,
          input.quantity, input.unitPrice, lineTotal,
        ]
      );
      await this.recomputeTotal(client, orderId);
      const row = await this.loadOrderRow(client, orderId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  async removeLineItem(ctx: TenantContext, orderId: string, lineItemId: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} is not open for editing (status: ${order.operational_status})`);
      }
      const deleted = await client.query(
        `DELETE FROM business_operations.order_line_items WHERE id = $1 AND order_id = $2`,
        [lineItemId, orderId]
      );
      if (deleted.rowCount === 0) throw new NotFoundError('OrderLineItem', lineItemId);
      await this.recomputeTotal(client, orderId);
      const row = await this.loadOrderRow(client, orderId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  private async recomputeTotal(client: PoolClient, orderId: string): Promise<void> {
    await client.query(
      `UPDATE platform.orders SET total_amount = (
         SELECT COALESCE(SUM(line_total), 0) FROM business_operations.order_line_items WHERE order_id = $1
       ) WHERE id = $1`,
      [orderId]
    );
  }

  async complete(ctx: TenantContext, orderId: string, businessId: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId);
      if (order.operational_status !== 'planned') {
        throw new ConflictError('Order', `order ${orderId} cannot be completed (status: ${order.operational_status})`);
      }
      const lineItems = await this.loadLineItems(client, orderId);
      if (lineItems.length === 0) {
        throw new ConflictError('Order', `order ${orderId} has no line items to complete`);
      }
      await client.query(
        `UPDATE platform.orders SET operational_status = 'completed', version = version + 1 WHERE id = $1`,
        [orderId]
      );
      await client.query(
        `INSERT INTO business_operations.order_events
           (tenant_id, workspace_id, business_id, order_id, event_type, previous_status, new_status, correlation_id)
         VALUES ($1,$2,$3,$4,'completed','planned','completed',$5)`,
        [ctx.tenantId, ctx.workspaceId, businessId, orderId, randomUUID()]
      );
      const totalQuantity = round2(lineItems.reduce((sum, li) => sum + li.quantity, 0));
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
      const row = await this.loadOrderRow(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }

  async void(ctx: TenantContext, orderId: string, businessId: string, reason?: string): Promise<Order> {
    return withTenantTransaction(ctx, async (client) => {
      const order = await this.loadOrderRow(client, orderId);
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
      const row = await this.loadOrderRow(client, orderId);
      const lineItems = await this.loadLineItems(client, orderId);
      return rowToOrder(row, lineItems);
    });
  }
}
