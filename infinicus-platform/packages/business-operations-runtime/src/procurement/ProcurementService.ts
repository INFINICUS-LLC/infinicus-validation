import {
  PurchaseOrderRepository,
  type CreatePurchaseOrderInput,
  type PurchaseOrder,
  type TenantContext,
  withTenantTransaction,
} from '@infinicus/database';
import { OperationalStateTransitionError } from '../errors.js';

const TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'cancelled'],
  approved: ['partially_received', 'received', 'cancelled'],
  partially_received: ['received', 'cancelled'],
  received: [],
  cancelled: [],
});

export interface PurchaseOrderView {
  id: string;
  supplierId: string;
  supplierName: string;
  poNumber: string;
  orderDate: Date;
  expectedDate: Date | null;
  currencyCode: string;
  totalAmount: number;
  poStatus: string;
  approvedAt: Date | null;
}

export class ProcurementService {
  constructor(private readonly purchaseOrders = new PurchaseOrderRepository()) {}

  async createPurchaseOrder(ctx: TenantContext, input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.purchaseOrders.create(ctx, input);
  }

  async getPurchaseOrder(
    ctx: TenantContext,
    businessId: string,
    purchaseOrderId: string
  ): Promise<PurchaseOrder> {
    const po = await this.purchaseOrders.findById(ctx, purchaseOrderId);
    if (po.businessId !== businessId) {
      // Fail closed without exposing cross-business existence.
      throw new Error('PurchaseOrder not found');
    }
    return po;
  }

  async listPurchaseOrders(
    ctx: TenantContext,
    businessId: string,
    opts: { status?: string; limit?: number } = {}
  ): Promise<PurchaseOrderView[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 50)));
    const params: unknown[] = [businessId];
    let statusClause = '';
    if (opts.status) {
      params.push(opts.status);
      statusClause = ` AND po.po_status = $${params.length}`;
    }
    params.push(bounded);

    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT po.id, po.supplier_id, s.name AS supplier_name,
                po.po_number, po.order_date, po.expected_date,
                po.currency_code, po.total_amount, po.po_status, po.approved_at
         FROM business_operations.purchase_orders po
         JOIN platform.suppliers s ON s.id = po.supplier_id
         WHERE po.business_id = $1${statusClause}
         ORDER BY po.order_date DESC, po.created_at DESC
         LIMIT $${params.length}`,
        params
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        supplierId: row.supplier_id as string,
        supplierName: row.supplier_name as string,
        poNumber: row.po_number as string,
        orderDate: new Date(String(row.order_date)),
        expectedDate: row.expected_date === null ? null : new Date(String(row.expected_date)),
        currencyCode: row.currency_code as string,
        totalAmount: Number(row.total_amount),
        poStatus: row.po_status as string,
        approvedAt: row.approved_at as Date | null,
      }));
    });
  }

  async transitionPurchaseOrder(
    ctx: TenantContext,
    businessId: string,
    purchaseOrderId: string,
    nextStatus: string,
    approvedBy?: string
  ): Promise<PurchaseOrder> {
    const po = await this.getPurchaseOrder(ctx, businessId, purchaseOrderId);
    const allowed = TRANSITIONS[po.poStatus] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new OperationalStateTransitionError('PurchaseOrder', po.poStatus, nextStatus);
    }

    if (nextStatus === 'approved') {
      if (!approvedBy) throw new Error('approvedBy is required when approving a purchase order');
      return this.purchaseOrders.approve(ctx, purchaseOrderId, approvedBy);
    }
    return this.purchaseOrders.transitionStatus(ctx, purchaseOrderId, po.poStatus, nextStatus);
  }
}
