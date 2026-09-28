import { withTenantTransaction, type TenantContext } from '../../client.js';
import { BusinessNotFoundError, BusinessCodeConflictError } from './errors.js';
import { boundedPage, type PageOptions } from '../da/pagination.js';

export interface Business {
  id: string;
  tenantId: string;
  workspaceId: string;
  legalName: string;
  tradingName: string | null;
  businessCode: string;
  industry: string | null;
  legalStructure: string | null;
  businessModel: string | null;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBusinessInput {
  legalName: string;
  tradingName?: string;
  businessCode: string;
  industry?: string;
  legalStructure?: string;
  businessModel?: string;
}

export interface PagedBusinesses {
  items: Business[];
  total: number;
}

const VALID_STATUSES = ['draft', 'active', 'suspended', 'closed', 'archived'];

function rowToBusiness(row: Record<string, unknown>): Business {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    legalName: row.legal_name as string,
    tradingName: row.trading_name as string | null,
    businessCode: row.business_code as string,
    industry: row.industry as string | null,
    legalStructure: row.legal_structure as string | null,
    businessModel: row.business_model as string | null,
    status: row.status as string,
    version: row.version as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
    && 'constraint' in err && (err as { constraint: unknown }).constraint === constraint;
}

export class BusinessRepository {
  /** Onboarding-created businesses are activated immediately, not left in the schema's 'draft' default. */
  async create(ctx: TenantContext, input: CreateBusinessInput): Promise<Business> {
    return withTenantTransaction(ctx, async (client) => {
      try {
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO platform.businesses
             (tenant_id, workspace_id, legal_name, trading_name, business_code, industry, legal_structure, business_model, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING *`,
          [
            ctx.tenantId, ctx.workspaceId, input.legalName, input.tradingName ?? null, input.businessCode,
            input.industry ?? null, input.legalStructure ?? null, input.businessModel ?? null, ctx.userId,
          ]
        );
        return rowToBusiness(result.rows[0]);
      } catch (err) {
        if (isUniqueViolation(err, 'businesses_code_tenant_unique')) {
          throw new BusinessCodeConflictError('Business', `business code already used in this tenant: ${input.businessCode}`);
        }
        throw err;
      }
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<Business> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM platform.businesses WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new BusinessNotFoundError('Business', id);
      return rowToBusiness(result.rows[0]);
    });
  }

  /**
   * Business selection: lists non-deleted businesses in the caller's workspace,
   * alphabetically by legal name, bounded by LIMIT/OFFSET rather than fetched
   * in full — see known-limitations-build21.md, "Pagination is applied after
   * a full repository fetch, not pushed into SQL".
   *
   * `page` is optional so existing callers keep working; omitting it yields
   * the explicit DEFAULT_PAGE_SIZE rather than an unbounded scan. Both
   * queries run on the same transaction client, so the count reflects a
   * consistent snapshot with the page rather than a value read separately.
   */
  async listForWorkspace(ctx: TenantContext, page: PageOptions = {}): Promise<PagedBusinesses> {
    const { limit, offset } = boundedPage(page);

    return withTenantTransaction(ctx, async (client) => {
      const itemsResult = await client.query<Record<string, unknown>>(
        `SELECT * FROM platform.businesses
         WHERE workspace_id = $1 AND deleted_at IS NULL
         ORDER BY legal_name
         LIMIT $2 OFFSET $3`,
        [ctx.workspaceId, limit, offset]
      );
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM platform.businesses WHERE workspace_id = $1 AND deleted_at IS NULL`,
        [ctx.workspaceId]
      );
      return {
        items: itemsResult.rows.map(rowToBusiness),
        total: Number(countResult.rows[0].count),
      };
    });
  }

  async updateStatus(ctx: TenantContext, id: string, status: string): Promise<Business> {
    if (!VALID_STATUSES.includes(status)) throw new BusinessNotFoundError('Business', id);
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE platform.businesses SET status = $2, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, status]
      );
      if (result.rows.length === 0) throw new BusinessNotFoundError('Business', id);
      return rowToBusiness(result.rows[0]);
    });
  }
}
