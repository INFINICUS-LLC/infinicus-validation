import { type TenantContext, withTenantTransaction } from '@infinicus/database';

export interface AssetInspection {
  id: string;
  businessId: string;
  assetId: string;
  inspectionType: string;
  conditionRating: string;
  pass: boolean;
  inspectedAt: Date;
}

export class AssetService {
  async listInspections(
    ctx: TenantContext,
    businessId: string,
    assetId: string,
    limit = 50
  ): Promise<AssetInspection[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT id, business_id, asset_id, inspection_type, condition_rating, pass_fail, inspected_at
         FROM business_operations.asset_inspections
         WHERE business_id = $1 AND asset_id = $2
         ORDER BY inspected_at DESC
         LIMIT $3`,
        [businessId, assetId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        businessId: row.business_id as string,
        assetId: row.asset_id as string,
        inspectionType: row.inspection_type as string,
        conditionRating: row.condition_rating as string,
        pass: row.pass_fail as boolean,
        inspectedAt: row.inspected_at as Date,
      }));
    });
  }
}
