import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError } from './errors.js';

export interface CreateProductInput {
  businessId: string;
  name: string;
  price: number;
  category?: string;
  icon?: string;
  sortOrder?: number;
}

export interface UpdateProductInput {
  name?: string;
  price?: number;
  category?: string;
  icon?: string;
  active?: boolean;
  sortOrder?: number;
}

export interface Product {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  name: string;
  price: number;
  category: string;
  icon: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    name: row.name as string,
    price: parseFloat(String(row.price)),
    category: row.category as string,
    icon: row.icon as string | null,
    active: row.active as boolean,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * A business's own catalog of sellable items — see 0161's migration
 * comment. Purely a convenience layer feeding the Operations "tap to log a
 * sale" grid; the resulting sale is still just a normal
 * BusinessEventRepository.logEvent() call, not modeled here.
 */
export class ProductRepository {
  async create(ctx: TenantContext, input: CreateProductInput): Promise<Product> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.products
           (tenant_id, workspace_id, business_id, name, price, category, icon, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          ctx.tenantId, ctx.workspaceId, input.businessId,
          input.name, input.price, input.category ?? 'other',
          input.icon ?? null, input.sortOrder ?? 0,
        ]
      );
      return rowToProduct(result.rows[0]);
    });
  }

  async list(ctx: TenantContext, businessId: string, activeOnly = true): Promise<Product[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.products
         WHERE business_id = $1 ${activeOnly ? 'AND active = true' : ''}
         ORDER BY category, sort_order, name`,
        [businessId]
      );
      return result.rows.map(rowToProduct);
    });
  }

  async getById(ctx: TenantContext, productId: string): Promise<Product> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.products WHERE id = $1`,
        [productId]
      );
      if (result.rows.length === 0) throw new NotFoundError('Product', productId);
      return rowToProduct(result.rows[0]);
    });
  }

  async update(ctx: TenantContext, productId: string, input: UpdateProductInput, businessId: string): Promise<Product> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.products SET
           name       = COALESCE($2, name),
           price      = COALESCE($3, price),
           category   = COALESCE($4, category),
           icon       = COALESCE($5, icon),
           active     = COALESCE($6, active),
           sort_order = COALESCE($7, sort_order)
         WHERE id = $1 AND business_id = $8
         RETURNING *`,
        [
          productId, input.name ?? null, input.price ?? null,
          input.category ?? null, input.icon ?? null,
          input.active ?? null, input.sortOrder ?? null, businessId,
        ]
      );
      if (result.rows.length === 0) throw new NotFoundError('Product', productId);
      return rowToProduct(result.rows[0]);
    });
  }
}
