import { z } from 'zod';
import { eventsSummaryResponseSchema } from './bizops.js';

export const operationsBusinessParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const operationsIntakeParamsSchema = z.object({
  businessId: z.string().uuid(),
  publicationPackageId: z.string().uuid(),
});

export const operationsIntakeResponseSchema = z.object({
  publicationPackageId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  idempotentReplay: z.boolean(),
  acceptedRecordCount: z.number().int().min(0),
  commandCount: z.number().int().min(0),
  results: z.array(z.object({
    commandType: z.enum([
      'record_inventory_movement',
      'create_purchase_order',
      'record_supplier_performance',
      'record_workforce_event',
      'record_asset_inspection',
      'record_operational_fact',
    ]),
    recordId: z.string().uuid(),
  })),
});

export const operationsPeriodQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
}).refine((value) => value.to > value.from, {
  message: 'to must be after from',
  path: ['to'],
});

export { eventsSummaryResponseSchema as operationsSummaryResponseSchema };

export const operationsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const procurementListQuerySchema = operationsListQuerySchema.extend({
  status: z.enum([
    'draft',
    'submitted',
    'approved',
    'partially_received',
    'received',
    'cancelled',
  ]).optional(),
});

export const inventoryResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    inventoryItemId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    itemName: z.string(),
    sku: z.string(),
    warehouseName: z.string(),
    quantityOnHand: z.number(),
    quantityReserved: z.number(),
    quantityAvailable: z.number(),
    reorderPoint: z.number(),
    reorderQuantity: z.number(),
    lastMovementAt: z.string().nullable(),
  })),
});

export const procurementResponseSchema = z.object({
  purchaseOrders: z.array(z.object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    supplierName: z.string(),
    poNumber: z.string(),
    orderDate: z.string(),
    expectedDate: z.string().nullable(),
    currencyCode: z.string(),
    totalAmount: z.number(),
    poStatus: z.string(),
    approvedAt: z.string().nullable(),
  })),
});

export const suppliersResponseSchema = z.object({
  suppliers: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    supplierCode: z.string(),
    riskStatus: z.string(),
    status: z.string(),
    latestPerformanceScore: z.number().nullable(),
    latestPerformanceAt: z.string().nullable(),
  })),
});

export const workforceResponseSchema = z.object({
  assignments: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    employeeCode: z.string(),
    assignmentCode: z.string(),
    assignmentType: z.string(),
    title: z.string(),
    allocationPct: z.number(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
    status: z.string(),
  })),
});

export const assetsResponseSchema = z.object({
  assets: z.array(z.object({
    id: z.string().uuid(),
    assetCode: z.string(),
    name: z.string(),
    assetType: z.string(),
    conditionStatus: z.string(),
    status: z.string(),
    latestInspectionRating: z.string().nullable(),
    latestInspectionPass: z.boolean().nullable(),
    latestInspectedAt: z.string().nullable(),
  })),
});
