/**
 * Response shapes of the /v1 endpoints the lifecycle screens read (NA-05). They mirror apps/api/src/schemas/businesses.ts; the API's own tests pin the
 * server side, and the browser validates every response against these so a drifting server fails loudly instead of rendering wrong data.
 */
import { z } from 'zod';

export const businessSummarySchema = z.object({
  id: z.string().uuid(), legalName: z.string(), businessCode: z.string(), status: z.string(), industry: z.string().nullable(),
});

export const businessListSchema = z.object({
  items: z.array(businessSummarySchema), page: z.number(), pageSize: z.number(), total: z.number(),
});

export const workflowViewSchema = z.object({
  business: businessSummarySchema.extend({ tradingName: z.string().nullable(), legalStructure: z.string().nullable(), businessModel: z.string().nullable() }),
  biEvidence: z.array(z.object({ id: z.string().uuid(), packageCode: z.string(), status: z.string(), latestVersion: z.number() })),
  dtLatestSnapshot: z.object({ snapshotCode: z.string(), status: z.string(), effectiveAt: z.string() }).nullable(),
  simulationLatestResult: z.object({ resultCode: z.string(), status: z.string() }).nullable(),
  simulationRuns: z.array(z.object({ id: z.string().uuid(), runCode: z.string(), status: z.string(), sampleSize: z.number() })),
  adiLatestRecommendation: z.object({ recommendationCode: z.string(), status: z.string() }).nullable(),
  abaLatestDecision: z.object({ decisionCode: z.string(), status: z.string() }).nullable(),
  outcomes: z.array(z.object({ id: z.string().uuid(), observationCode: z.string(), status: z.string() })),
});

const historyRow = <K extends string>(codeKey: K) => z.object({ id: z.string().uuid(), status: z.string() }).extend({ [codeKey]: z.string() } as Record<K, z.ZodString>);

export const decisionHistorySchema = z.object({
  biEvidence: z.array(historyRow('packageCode')),
  simulationRuns: z.array(historyRow('runCode')),
  adiCases: z.array(historyRow('caseCode')),
  abaReviews: z.array(historyRow('reviewCode')),
  outcomes: z.array(historyRow('observationCode')),
});

export const decisionResultSchema = z.object({ id: z.string().uuid(), status: z.string(), decisionCode: z.string() });
export const outcomeResultSchema = z.object({ id: z.string().uuid(), status: z.string(), observationCode: z.string() });

/** GET /v1/businesses/:businessId/products (apps/api/src/schemas/products.ts). Inactive products are excluded by the server unless asked for. */
export const productSchema = z.object({
  id: z.string().uuid(), name: z.string(), price: z.number(), category: z.string(), icon: z.string().nullable(), active: z.boolean(), sortOrder: z.number(),
});
export const productListSchema = z.object({ products: z.array(productSchema) });

/** Orders (apps/api/src/schemas/orders.ts). Dates travel as ISO strings. `operationalStatus` mirrors the platform vocabulary; the counter only builds `planned` orders. */
export const orderLineItemSchema = z.object({
  id: z.string().uuid(), lineNumber: z.number(), itemType: z.string(), productId: z.string().uuid().nullable(), description: z.string(),
  quantity: z.number(), unitPrice: z.number(), lineTotal: z.number(),
});
export const orderSchema = z.object({
  id: z.string().uuid(), businessId: z.string().uuid(), customerId: z.string().uuid().nullable(), orderNumber: z.string(), orderDate: z.string(),
  totalAmount: z.number(), operationalStatus: z.enum(['planned', 'authorized', 'executed', 'completed', 'failed', 'reversed']),
  createdAt: z.string(), updatedAt: z.string(), lineItems: z.array(orderLineItemSchema),
});
export const orderListSchema = z.object({ orders: z.array(orderSchema) });

export type BusinessList = z.infer<typeof businessListSchema>;
export type WorkflowView = z.infer<typeof workflowViewSchema>;
export type DecisionHistory = z.infer<typeof decisionHistorySchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductList = z.infer<typeof productListSchema>;
export type OrderLineItem = z.infer<typeof orderLineItemSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderList = z.infer<typeof orderListSchema>;
