import { type TenantContext, withTenantTransaction } from '@infinicus/database';

export interface SupplierPerformanceSnapshot {
  id: string;
  businessId: string;
  supplierId: string;
  periodStart: Date;
  periodEnd: Date;
  overallScore: number;
}

export interface SupplierOperationalView {
  id: string;
  name: string;
  supplierCode: string;
  riskStatus: string;
  status: string;
  latestPerformanceScore: number | null;
  latestPerformanceAt: Date | null;
}

export class SupplierService {
  async listSuppliers(
    ctx: TenantContext,
    businessId: string,
    limit = 50
  ): Promise<SupplierOperationalView[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT s.id, s.name, s.supplier_code, s.risk_status, s.status,
                perf.overall_score, perf.period_end
         FROM platform.suppliers s
         LEFT JOIN LATERAL (
           SELECT overall_score, period_end
           FROM business_operations.supplier_performance_scores p
           WHERE p.supplier_id = s.id AND p.business_id = s.business_id
           ORDER BY p.period_end DESC, p.created_at DESC
           LIMIT 1
         ) perf ON true
         WHERE s.business_id = $1 AND s.deleted_at IS NULL
         ORDER BY s.name
         LIMIT $2`,
        [businessId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        supplierCode: row.supplier_code as string,
        riskStatus: row.risk_status as string,
        status: row.status as string,
        latestPerformanceScore: row.overall_score === null ? null : Number(row.overall_score),
        latestPerformanceAt: row.period_end === null ? null : new Date(String(row.period_end)),
      }));
    });
  }

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
        periodStart: new Date(String(row.period_start)),
        periodEnd: new Date(String(row.period_end)),
        overallScore: Number(row.overall_score),
      }));
    });
  }
}
