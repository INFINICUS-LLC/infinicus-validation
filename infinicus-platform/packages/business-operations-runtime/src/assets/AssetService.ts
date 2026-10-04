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

export interface AssetOperationalView {
  id: string;
  assetCode: string;
  name: string;
  assetType: string;
  conditionStatus: string;
  status: string;
  latestInspectionRating: string | null;
  latestInspectionPass: boolean | null;
  latestInspectedAt: Date | null;
}

export class AssetService {
  async listAssets(
    ctx: TenantContext,
    businessId: string,
    limit = 50
  ): Promise<AssetOperationalView[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT a.id, a.asset_code, a.name, a.asset_type, a.condition_status, a.status,
                inspection.condition_rating, inspection.pass_fail, inspection.inspected_at
         FROM platform.assets a
         LEFT JOIN LATERAL (
           SELECT condition_rating, pass_fail, inspected_at
           FROM business_operations.asset_inspections i
           WHERE i.asset_id = a.id AND i.business_id = a.business_id
           ORDER BY i.inspected_at DESC, i.created_at DESC
           LIMIT 1
         ) inspection ON true
         WHERE a.business_id = $1
         ORDER BY a.name
         LIMIT $2`,
        [businessId, bounded]
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        assetCode: row.asset_code as string,
        name: row.name as string,
        assetType: row.asset_type as string,
        conditionStatus: row.condition_status as string,
        status: row.status as string,
        latestInspectionRating: row.condition_rating as string | null,
        latestInspectionPass: row.pass_fail as boolean | null,
        latestInspectedAt: row.inspected_at as Date | null,
      }));
    });
  }

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
