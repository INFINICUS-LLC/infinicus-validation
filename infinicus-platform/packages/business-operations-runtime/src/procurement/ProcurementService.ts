import {
  PurchaseOrderRepository,
  type CreatePurchaseOrderInput,
  type PurchaseOrder,
  type TenantContext,
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
    return this.purchaseOrders.updateStatus(ctx, purchaseOrderId, nextStatus);
  }
}
