// NEW-BI-02 - Business Operations' READ-ONLY sales and operations facts for one business and period (contract `bo-sales-facts/1`). BO owns the order and
// order-line records; Business Intelligence derives every ratio, share, rate and ranking from what this returns (architecture finding V-09).
//
// Raw means: sums and counts of recorded facts grouped by calendar day (UTC) and CURRENCY; nothing converted, netted or estimated. Amounts and quantities are
// exact decimal strings (numeric(18,4)). Only COMPLETED orders carry sales; every other status is only counted. A customer is "returning" when they have a
// completed order dated BEFORE the period (any currency). Every statement is a SELECT under the caller's tenant and workspace (RLS applies); it writes nothing.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Json = Record<string, unknown>;

/** Mirrors SALES_FACTS_PRODUCT_CAP in the handoff contract (the database package does not depend on it). */
export const SALES_PRODUCT_ROW_CAP = 200;

export interface RawSalesFacts {
  completedOrders: { date: string; currency: string; amount: string; count: number; withCustomer: number }[];
  customers: { currency: string; distinct: number; returning: number }[];
  lines: { date: string; currency: string; itemType: string; lines: number; quantity: string; lineTotal: string }[];
  lineCoverage: { currency: string; orders: number; ordersWithLines: number }[];
  fulfilment: { currency: string; lines: number; orderedQuantity: string; fulfilledQuantity: string }[];
  products: { currency: string; productId: string; name: string; quantity: string; lineTotal: string; lines: number }[];
  productsTruncated: boolean;
  productLinesWithoutProduct: number;
  ordersByStatus: { status: string; count: number }[];
}

const empty = (): RawSalesFacts => ({
  completedOrders: [], customers: [], lines: [], lineCoverage: [], fulfilment: [], products: [], productsTruncated: false, productLinesWithoutProduct: 0, ordersByStatus: [],
});

export class SalesFactsRepository {
  /** `from` and `to` are inclusive `YYYY-MM-DD` dates (UTC). An invalid business id or date yields no facts, never an error from the database. */
  async read(ctx: TenantContext, businessId: string, from: string, to: string): Promise<RawSalesFacts> {
    if (!UUID.test(businessId) || !DATE.test(from) || !DATE.test(to) || from > to) return empty();
    const p = [businessId, from, to];
    return withTenantTransaction(ctx, async (client) => {
      const orders = await client.query<Json>(
        `SELECT order_date::text AS d, currency_code AS c, SUM(total_amount)::numeric(18,4)::text AS amount, count(*)::int AS n,
                count(*) FILTER (WHERE customer_id IS NOT NULL)::int AS with_customer
           FROM platform.orders
          WHERE business_id = $1 AND operational_status = 'completed' AND order_date BETWEEN $2::date AND $3::date
          GROUP BY 1, 2 ORDER BY 1, 2`, p);
      const customers = await client.query<Json>(
        `WITH cur AS (
           SELECT DISTINCT currency_code AS c, customer_id FROM platform.orders
            WHERE business_id = $1 AND operational_status = 'completed' AND order_date BETWEEN $2::date AND $3::date AND customer_id IS NOT NULL)
         SELECT c, count(*)::int AS distinct_customers,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM platform.orders o WHERE o.business_id = $1 AND o.customer_id = cur.customer_id AND o.operational_status = 'completed' AND o.order_date < $2::date))::int AS returning_customers
           FROM cur GROUP BY c ORDER BY c`, p);
      const lines = await client.query<Json>(
        `SELECT o.order_date::text AS d, o.currency_code AS c, l.item_type AS t, count(*)::int AS n,
                SUM(l.quantity)::numeric(18,4)::text AS quantity, SUM(l.line_total)::numeric(18,4)::text AS total
           FROM platform.orders o JOIN business_operations.order_line_items l ON l.order_id = o.id AND l.business_id = o.business_id
          WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, p);
      const coverage = await client.query<Json>(
        `SELECT o.currency_code AS c, count(*)::int AS n,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM business_operations.order_line_items l WHERE l.order_id = o.id AND l.business_id = o.business_id))::int AS with_lines
           FROM platform.orders o
          WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date
          GROUP BY 1 ORDER BY 1`, p);
      const fulfilment = await client.query<Json>(
        `SELECT o.currency_code AS c, count(*)::int AS n, SUM(l.quantity)::numeric(18,4)::text AS ordered,
                SUM(LEAST(l.fulfilled_qty, l.quantity))::numeric(18,4)::text AS fulfilled
           FROM platform.orders o JOIN business_operations.order_line_items l ON l.order_id = o.id AND l.business_id = o.business_id
          WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date AND l.item_type = 'product'
          GROUP BY 1 ORDER BY 1`, p);
      const products = await client.query<Json>(
        `SELECT o.currency_code AS c, l.product_id AS product_id, pr.name AS name, count(*)::int AS n,
                SUM(l.quantity)::numeric(18,4)::text AS quantity, SUM(l.line_total)::numeric(18,4) AS total
           FROM platform.orders o
           JOIN business_operations.order_line_items l ON l.order_id = o.id AND l.business_id = o.business_id
           JOIN platform.products pr ON pr.id = l.product_id AND pr.business_id = o.business_id
          WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date AND l.item_type = 'product'
          GROUP BY 1, 2, 3 ORDER BY total DESC, name, product_id LIMIT ${SALES_PRODUCT_ROW_CAP + 1}`, p);
      const unattributed = await client.query<Json>(
        `SELECT count(*)::int AS n FROM platform.orders o JOIN business_operations.order_line_items l ON l.order_id = o.id AND l.business_id = o.business_id
          WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date AND l.item_type = 'product' AND l.product_id IS NULL`, p);
      const statuses = await client.query<Json>(
        `SELECT operational_status AS s, count(*)::int AS n FROM platform.orders
          WHERE business_id = $1 AND order_date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`, p);
      const truncated = products.rows.length > SALES_PRODUCT_ROW_CAP;
      return {
        completedOrders: orders.rows.map((r) => ({ date: r.d as string, currency: r.c as string, amount: r.amount as string, count: Number(r.n), withCustomer: Number(r.with_customer) })),
        customers: customers.rows.map((r) => ({ currency: r.c as string, distinct: Number(r.distinct_customers), returning: Number(r.returning_customers) })),
        lines: lines.rows.map((r) => ({ date: r.d as string, currency: r.c as string, itemType: r.t as string, lines: Number(r.n), quantity: r.quantity as string, lineTotal: r.total as string })),
        lineCoverage: coverage.rows.map((r) => ({ currency: r.c as string, orders: Number(r.n), ordersWithLines: Number(r.with_lines) })),
        fulfilment: fulfilment.rows.map((r) => ({ currency: r.c as string, lines: Number(r.n), orderedQuantity: r.ordered as string, fulfilledQuantity: r.fulfilled as string })),
        products: products.rows.slice(0, SALES_PRODUCT_ROW_CAP).map((r) => ({
          currency: r.c as string, productId: r.product_id as string, name: r.name as string, quantity: r.quantity as string, lineTotal: String(r.total), lines: Number(r.n),
        })),
        productsTruncated: truncated,
        productLinesWithoutProduct: Number(unattributed.rows[0].n),
        ordersByStatus: statuses.rows.map((r) => ({ status: r.s as string, count: Number(r.n) })),
      };
    });
  }
}
