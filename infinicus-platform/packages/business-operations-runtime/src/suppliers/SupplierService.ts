import { type TenantContext, withTenantTransaction } from '@infinicus/database';

export interface SupplierPerformanceSnapshot {
  id: string;
  businessId: string;
  supplierId: string;
  periodStart: Date;
  periodEnd: Date;
  overallScore: number;
}

export class SupplierService {
  async listPerformance(
    ctx: TenantContext,
    businessId: string,
    supplierId: string,
    limit = 50
  ): Promise<SupplierPerformanceSnapshot[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, supplier_id, period_start, period_end, overall_score
         FROM business_operations.supplier_performance_scores
         WHERE business_id = $1 AND supplier_id = $2
         ORDER BY period_end DESC
         LIMIT $3`,
        [businessId, supplierId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        businessId: row.business_id as string,
        supplierId: row.supplier_id as string,
        periodStart: row.period_start as Date,
        periodEnd: row.period_end as Date,
        overallScore: Number(row.overall_score),
      }));
    });
  }
}
