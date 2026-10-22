// NEW-BI-01 - Business Operations' READ-ONLY financial facts for one business and period. BO owns the operational records; Business Intelligence derives
// every analytical figure from what this returns (architecture finding V-09: raw operational aggregates here, derived KPIs in BI).
//
// Raw means: sums and counts of recorded facts, grouped by calendar day (UTC) and CURRENCY. Nothing is converted between currencies, nothing is netted
// across sources, nothing is estimated. Amounts are exact decimal strings of the storage precision (numeric(18,4)).
//
// What counts, and what does not:
//   revenue          completed orders only (operational_status = 'completed'), by order_date, in the order's currency. Open, failed (voided) and reversed orders
//                    are counted by status, never valued. Credit notes are not netted (no order link exists to avoid double counting).
//   expenses         items of APPROVED or PAID expense claims, by expense_date. An item whose currency is missing or differs from its claim's is excluded and counted.
//   goods received   purchase receipt lines with a recorded unit cost, by receipt date (UTC); lines without a cost are counted, never valued.
//   cost of sales    only where PROVABLE: a sale line (not a discount) of a completed order whose whole quantity is covered by `issue` movements that reference
//                    the line and carry a unit cost in the order's currency. Anything less is "no evidence" for that line.
// Every statement is a SELECT under the caller's tenant and workspace (RLS applies). It writes nothing.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Json = Record<string, unknown>;

export interface RawDailyAmount { date: string; currency: string; amount: string; count: number }
export interface RawCostOfSales { currency: string; saleLines: number; saleLinesWithCostEvidence: number; evidencedCost: string }
export interface RawIndicator {
  metricCode: string; metricName: string; category: string; unit: string | null;
  value: string; target: string | null; variance: string | null; periodStart: string; periodEnd: string;
}
export interface RawFinancialFacts {
  completedOrders: RawDailyAmount[];
  ordersByStatus: { status: string; count: number }[];
  expenseItems: RawDailyAmount[];
  expenseItemsExcludedForCurrency: number;
  goodsReceived: RawDailyAmount[];
  goodsReceivedWithoutCost: number;
  costOfSales: RawCostOfSales[];
  indicators: RawIndicator[];
}

const empty = (): RawFinancialFacts => ({
  completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [],
});
const daily = (rows: Json[]): RawDailyAmount[] => rows.map((r) => ({ date: r.d as string, currency: r.c as string, amount: r.amount as string, count: Number(r.n) }));

export class FinancialFactsRepository {
  /** `from` and `to` are inclusive `YYYY-MM-DD` dates (UTC). An invalid business id or date yields no facts, never an error from the database. */
  async read(ctx: TenantContext, businessId: string, from: string, to: string): Promise<RawFinancialFacts> {
    if (!UUID.test(businessId) || !DATE.test(from) || !DATE.test(to) || from > to) return empty();
    return withTenantTransaction(ctx, async (client) => {
      const orders = await client.query<Json>(
        `SELECT order_date::text AS d, currency_code AS c, SUM(total_amount)::text AS amount, count(*)::int AS n
           FROM platform.orders
          WHERE business_id = $1 AND operational_status = 'completed' AND order_date BETWEEN $2::date AND $3::date
          GROUP BY 1, 2 ORDER BY 1, 2`, [businessId, from, to]);
      const statuses = await client.query<Json>(
        `SELECT operational_status AS s, count(*)::int AS n FROM platform.orders
          WHERE business_id = $1 AND order_date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`, [businessId, from, to]);
      const expenses = await client.query<Json>(
        `SELECT i.expense_date::text AS d, i.currency_code AS c, SUM(i.amount)::text AS amount, count(*)::int AS n
           FROM business_operations.expense_items i
           JOIN business_operations.expense_claims k ON k.id = i.expense_claim_id AND k.business_id = i.business_id
          WHERE i.business_id = $1 AND k.claim_status IN ('approved', 'paid') AND i.expense_date BETWEEN $2::date AND $3::date
            AND i.currency_code IS NOT NULL AND i.currency_code = k.currency_code
          GROUP BY 1, 2 ORDER BY 1, 2`, [businessId, from, to]);
      const excluded = await client.query<Json>(
        `SELECT count(*)::int AS n
           FROM business_operations.expense_items i
           JOIN business_operations.expense_claims k ON k.id = i.expense_claim_id AND k.business_id = i.business_id
          WHERE i.business_id = $1 AND k.claim_status IN ('approved', 'paid') AND i.expense_date BETWEEN $2::date AND $3::date
            AND (i.currency_code IS NULL OR i.currency_code IS DISTINCT FROM k.currency_code)`, [businessId, from, to]);
      const received = await client.query<Json>(
        `SELECT (r.received_at AT TIME ZONE 'UTC')::date::text AS d, l.unit_cost_currency AS c,
                SUM(round(l.quantity * l.unit_cost, 4))::text AS amount, count(*)::int AS n
           FROM business_operations.purchase_receipt_lines l
           JOIN business_operations.purchase_receipts r ON r.id = l.purchase_receipt_id AND r.business_id = l.business_id
          WHERE l.business_id = $1 AND l.unit_cost IS NOT NULL AND l.unit_cost_currency IS NOT NULL
            AND (r.received_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
          GROUP BY 1, 2 ORDER BY 1, 2`, [businessId, from, to]);
      const uncosted = await client.query<Json>(
        `SELECT count(*)::int AS n
           FROM business_operations.purchase_receipt_lines l
           JOIN business_operations.purchase_receipts r ON r.id = l.purchase_receipt_id AND r.business_id = l.business_id
          WHERE l.business_id = $1 AND (l.unit_cost IS NULL OR l.unit_cost_currency IS NULL)
            AND (r.received_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`, [businessId, from, to]);
      // A sale line has cost evidence only when issue movements that reference it cover its WHOLE quantity AND every one of them carries a unit cost in the
      // order's currency. A return referencing the line, a partial issue, a missing cost or another currency each leave the line without evidence.
      const cost = await client.query<Json>(
        `WITH sale_lines AS (
           SELECT o.currency_code AS currency, l.id AS line_id, l.quantity AS line_qty
             FROM platform.orders o
             JOIN business_operations.order_line_items l ON l.order_id = o.id AND l.business_id = o.business_id
            WHERE o.business_id = $1 AND o.operational_status = 'completed' AND o.order_date BETWEEN $2::date AND $3::date AND l.item_type <> 'discount'),
         per_line AS (
           SELECT s.currency, s.line_id, s.line_qty,
                  COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'issue'), 0) AS issued_qty,
                  COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'issue' AND m.unit_cost IS NOT NULL AND m.unit_cost_currency = s.currency), 0) AS costed_qty,
                  count(*) FILTER (WHERE m.movement_type <> 'issue') AS other_movements,
                  COALESCE(SUM(round(m.quantity * m.unit_cost, 4)) FILTER (WHERE m.movement_type = 'issue' AND m.unit_cost IS NOT NULL AND m.unit_cost_currency = s.currency), 0) AS cost
             FROM sale_lines s
             LEFT JOIN business_operations.inventory_movements m
                    ON m.business_id = $1 AND m.reference_type = 'order_line' AND m.reference_id = s.line_id
            GROUP BY s.currency, s.line_id, s.line_qty)
         SELECT currency, count(*)::int AS sale_lines,
                count(*) FILTER (WHERE issued_qty = line_qty AND costed_qty = line_qty AND other_movements = 0)::int AS with_evidence,
                COALESCE(SUM(cost) FILTER (WHERE issued_qty = line_qty AND costed_qty = line_qty AND other_movements = 0), 0)::numeric(18,4)::text AS evidenced_cost
           FROM per_line GROUP BY currency ORDER BY currency`, [businessId, from, to]);
      // Indicators are RECORDED by Business Operations; they are reported as recorded, never recomputed. The latest record per metric whose period lies inside the range.
      const indicators = await client.query<Json>(
        `SELECT DISTINCT ON (metric_code) metric_code, metric_name, metric_category, unit, numeric_value::text AS value, target_value::text AS target, variance::text AS variance,
                to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS period_start, to_char(period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS period_end
           FROM business_operations.operational_performance_records
          WHERE business_id = $1 AND numeric_value IS NOT NULL
            AND (period_start AT TIME ZONE 'UTC')::date >= $2::date AND (period_end AT TIME ZONE 'UTC')::date <= ($3::date + 1)
          ORDER BY metric_code, period_end DESC, id`, [businessId, from, to]);
      return {
        completedOrders: daily(orders.rows),
        ordersByStatus: statuses.rows.map((r) => ({ status: r.s as string, count: Number(r.n) })),
        expenseItems: daily(expenses.rows),
        expenseItemsExcludedForCurrency: Number(excluded.rows[0].n),
        goodsReceived: daily(received.rows),
        goodsReceivedWithoutCost: Number(uncosted.rows[0].n),
        costOfSales: cost.rows.map((r) => ({ currency: r.currency as string, saleLines: Number(r.sale_lines), saleLinesWithCostEvidence: Number(r.with_evidence), evidencedCost: r.evidenced_cost as string })),
        indicators: indicators.rows.map((r) => ({
          metricCode: r.metric_code as string, metricName: r.metric_name as string, category: r.metric_category as string, unit: (r.unit as string | null) ?? null,
          value: r.value as string, target: (r.target as string | null) ?? null, variance: (r.variance as string | null) ?? null,
          periodStart: r.period_start as string, periodEnd: r.period_end as string,
        })),
      };
    });
  }
}
