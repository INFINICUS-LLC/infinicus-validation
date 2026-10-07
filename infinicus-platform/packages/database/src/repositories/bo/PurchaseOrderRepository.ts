import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError } from './errors.js';

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  supplierId: string;
  poNumber: string;
  orderDate: Date;
  expectedDate: Date | null;
  currencyCode: string;
  totalAmount: number;
  poStatus: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  notes: string | null;
  status: string;
  version: number;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export interface CreatePurchaseOrderInput {
  businessId: string;
  supplierId: string;
  poNumber: string;
  orderDate?: Date;
  expectedDate?: Date;
  currencyCode?: string;
  totalAmount?: number;
  notes?: string;
  correlationId?: string;
  createdBy?: string;
}

function rowToPO(row: Record<string, unknown>): PurchaseOrder {
  return {
    id:           row.id            as string,
    tenantId:     row.tenant_id     as string,
    workspaceId:  row.workspace_id  as string,
    businessId:   row.business_id   as string,
    supplierId:   row.supplier_id   as string,
    poNumber:     row.po_number     as string,
    orderDate:    row.order_date    as Date,
    expectedDate: row.expected_date as Date | null,
    currencyCode: row.currency_code as string,
    totalAmount:  parseFloat(String(row.total_amount)),
    poStatus:     row.po_status     as string,
    approvedBy:   row.approved_by   as string | null,
    approvedAt:   row.approved_at   as Date | null,
    notes:        row.notes         as string | null,
    status:       row.status        as string,
    version:      row.version       as number,
    correlationId: row.correlation_id as string,
    createdAt:    row.created_at    as Date,
    updatedAt:    row.updated_at    as Date,
    createdBy:    row.created_by    as string | null,
  };
}

export class PurchaseOrderRepository {
  async create(ctx: TenantContext, input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.purchase_orders
           (tenant_id, workspace_id, business_id, supplier_id, po_number, order_date,
            expected_date, currency_code, total_amount, notes, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          ctx.tenantId, ctx.workspaceId,
          input.businessId,
          input.supplierId,
          input.poNumber,
          input.orderDate      ?? new Date(),
          input.expectedDate   ?? null,
          input.currencyCode   ?? 'USD',
          input.totalAmount    ?? 0,
          input.notes          ?? null,
          input.correlationId  ?? randomUUID(),
          input.createdBy      ?? null,
        ]
      );
      return rowToPO(result.rows[0]);
    });
  }

  async findById(ctx: TenantContext, id: string): Promise<PurchaseOrder> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM business_operations.purchase_orders WHERE id = $1',
        [id]
      );
      if (result.rows.length === 0) throw new NotFoundError('PurchaseOrder', id);
      return rowToPO(result.rows[0]);
    });
  }

  async listByStatus(ctx: TenantContext, poStatus: string): Promise<PurchaseOrder[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.purchase_orders
         WHERE po_status = $1
         ORDER BY order_date DESC`,
        [poStatus]
      );
      return result.rows.map(rowToPO);
    });
  }

  async approve(
    ctx: TenantContext,
    id: string,
    approvedBy: string
  ): Promise<PurchaseOrder> {
    return withTenantTransaction(ctx, async (client) => {
      const employee = await client.query(
        `SELECT id
         FROM platform.employees
         WHERE id = $1
           AND business_id = (SELECT business_id FROM business_operations.purchase_orders WHERE id = $2)`,
        [approvedBy, id]
      );
      if (employee.rowCount !== 1) {
        throw new ConflictError('PurchaseOrder', 'approver is not an employee of the purchase-order business');
      }

      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.purchase_orders
         SET po_status = 'approved', approved_by = $2, approved_at = now(), version = version + 1
         WHERE id = $1 AND po_status = 'submitted'
         RETURNING *`,
        [id, approvedBy]
      );
      if (result.rows.length === 0) {
        const current = await client.query<{ po_status: string }>(
          'SELECT po_status FROM business_operations.purchase_orders WHERE id = $1',
          [id]
        );
        if (current.rowCount === 0) throw new NotFoundError('PurchaseOrder', id);
        throw new ConflictError(
          'PurchaseOrder',
          `cannot approve from status ${current.rows[0].po_status}`
        );
      }

      const po = rowToPO(result.rows[0]);
      await client.query(
        `SELECT business_operations.emit_purchase_order_approved(
           $1,$2,$3,$4,$5,$6,NULL
         )`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          po.id,
          po.supplierId,
          po.totalAmount,
          po.correlationId,
        ]
      );
      return po;
    });
  }

  async transitionStatus(
    ctx: TenantContext,
    id: string,
    expectedStatus: string,
    nextStatus: string
  ): Promise<PurchaseOrder> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.purchase_orders
         SET po_status = $3, version = version + 1
         WHERE id = $1 AND po_status = $2
         RETURNING *`,
        [id, expectedStatus, nextStatus]
      );
      if (result.rows.length === 0) {
        const current = await client.query<{ po_status: string }>(
          'SELECT po_status FROM business_operations.purchase_orders WHERE id = $1',
          [id]
        );
        if (current.rowCount === 0) throw new NotFoundError('PurchaseOrder', id);
        throw new ConflictError(
          'PurchaseOrder',
          `expected status ${expectedStatus}, found ${current.rows[0].po_status}`
        );
      }
      return rowToPO(result.rows[0]);
    });
  }

  /**
   * Compatibility method for pre-BUILD-32 callers.
   * New governed runtime code must prefer transitionStatus() so the expected
   * current state is checked atomically.
   */
  async updateStatus(ctx: TenantContext, id: string, poStatus: string): Promise<PurchaseOrder> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.purchase_orders
         SET po_status = $2, version = version + 1
         WHERE id = $1
         RETURNING *`,
        [id, poStatus]
      );
      if (result.rows.length === 0) throw new NotFoundError('PurchaseOrder', id);
      return rowToPO(result.rows[0]);
    });
  }
}
