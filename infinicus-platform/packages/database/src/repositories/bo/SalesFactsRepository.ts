import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

/**
 * Business Operations' READ-ONLY sales facts: orders and their lines aggregated per order day and currency, for one business. Business Operations owns
 * orders; this repository only reads them (no statement here writes). Business Intelligence consumes it through the structural port composed at the API
 * (it never imports Business Operations). Row-level security (tenant + workspace) applies to every table read; the business is an explicit predicate.
 *
 * Money stays EXACT: amounts are numeric in the database and leave this repository as decimal STRINGS (never through a JavaScript float); the caller
 * converts them to integer minor units of the row's own currency. A row is always one currency; amounts of different currencies are never added here.
 *
 * Definitions (the single place they are stated):
 *  - the reporting day of an order is its recorded `order_date` (the database calendar date at creation);
 *  - a SALE is an order whose operational_status is 'completed'; its net amount is the order's authoritative total_amount;
 *  - gross = the sum of the order's non-discount lines, discount = the (positive) sum of its discount lines, so gross - discount = net for a consistent order;
 *  - 'failed' orders are voided orders, 'planned' orders are still open, any other status is counted separately and never as a sale.
 */
export interface SalesDayCurrencyFacts {
  /** YYYY-MM-DD. */
  orderDate: string;
  currencyCode: string;
  completedOrders: number;
  voidedOrders: number;
  openOrders: number;
  otherStatusOrders: number;
  /** Exact decimal strings (numeric(18,4) text), completed orders only. */
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
}

export class SalesFactsRepository {
  /** Facts for the inclusive order-date range [from, to] (both YYYY-MM-DD), ordered by date then currency. */
  async byDayAndCurrency(ctx: TenantContext, businessId: string, from: string, to: string): Promise<SalesDayCurrencyFacts[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `WITH line_sums AS (
           SELECT l.order_id,
                  COALESCE(SUM(l.line_total) FILTER (WHERE l.item_type <> 'discount'), 0)  AS gross,
                  COALESCE(-SUM(l.line_total) FILTER (WHERE l.item_type = 'discount'), 0)  AS discount
             FROM business_operations.order_line_items l
            WHERE l.business_id = $1
            GROUP BY l.order_id
         )
         SELECT o.order_date::text AS order_date,
                o.currency_code,
                count(*) FILTER (WHERE o.operational_status = 'completed')::int AS completed_orders,
                count(*) FILTER (WHERE o.operational_status = 'failed')::int    AS voided_orders,
                count(*) FILTER (WHERE o.operational_status = 'planned')::int   AS open_orders,
                count(*) FILTER (WHERE o.operational_status NOT IN ('completed','failed','planned'))::int AS other_status_orders,
                COALESCE(SUM(s.gross)        FILTER (WHERE o.operational_status = 'completed'), 0)::numeric(18,4)::text AS gross_amount,
                COALESCE(SUM(s.discount)     FILTER (WHERE o.operational_status = 'completed'), 0)::numeric(18,4)::text AS discount_amount,
                COALESCE(SUM(o.total_amount) FILTER (WHERE o.operational_status = 'completed'), 0)::numeric(18,4)::text AS net_amount
           FROM platform.orders o
           LEFT JOIN line_sums s ON s.order_id = o.id
          WHERE o.business_id = $1 AND o.order_date BETWEEN $2::date AND $3::date
          GROUP BY o.order_date, o.currency_code
          ORDER BY o.order_date, o.currency_code`,
        [businessId, from, to]
      );
      return result.rows.map((r) => ({
        orderDate: r.order_date as string,
        currencyCode: r.currency_code as string,
        completedOrders: Number(r.completed_orders),
        voidedOrders: Number(r.voided_orders),
        openOrders: Number(r.open_orders),
        otherStatusOrders: Number(r.other_status_orders),
        grossAmount: r.gross_amount as string,
        discountAmount: r.discount_amount as string,
        netAmount: r.net_amount as string,
      }));
    });
  }
}
