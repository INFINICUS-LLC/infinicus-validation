import { z } from 'zod';

export const businessIdParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const orderIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const lineItemIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  orderId: z.string().uuid(),
  lineItemId: z.string().uuid(),
});

const orderLineItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number(),
  itemType: z.string(),
  productId: z.string().uuid().nullable(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  lineTotal: z.number(),
});

const orderPaymentSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  method: z.enum(['cash', 'card', 'other']),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  amountTendered: z.number(),
  amountApplied: z.number(),
  changeGiven: z.number(),
  reference: z.string().nullable(),
  createdAt: z.coerce.date(),
});

const orderSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  orderNumber: z.string(),
  orderDate: z.coerce.date(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  registerSessionId: z.string().uuid().nullable(),
  totalAmount: z.number(),
  operationalStatus: z.enum(['planned', 'authorized', 'executed', 'completed', 'failed', 'reversed']),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lineItems: z.array(orderLineItemSchema),
  payments: z.array(orderPaymentSchema),
  changeDue: z.number(),
});

export const createOrderBodySchema = z.object({
  customerId: z.string().uuid().optional(),
});

export const addLineItemBodySchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
  productId: z.string().uuid().optional(),
  itemType: z.enum(['product', 'service', 'fee', 'discount', 'other']).optional(),
});

/** Tender for completing an order. Unknown keys are refused (strict): the body carries no currency, no applied amount and no change; the server computes those. */
export const completeOrderBodySchema = z.object({
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'other']),
    amountTendered: z.number().positive(),
    reference: z.string().max(64).nullable().optional(),
  }).strict()).max(10).optional().default([]),
}).strict();

export const voidOrderBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const orderResponseSchema = orderSchema;

export const listOrdersQuerySchema = z.object({
  status: z.enum(['planned', 'authorized', 'executed', 'completed', 'failed', 'reversed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const listOrdersResponseSchema = z.object({
  orders: z.array(orderSchema),
});
