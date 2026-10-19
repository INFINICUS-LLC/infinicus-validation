import { z } from 'zod';

export const businessIdParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const sessionIdParamsSchema = z.object({
  businessId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

const registerSessionSchema = z.object({
  id: z.string().uuid(),
  registerName: z.string(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).nullable(),
  status: z.enum(['open', 'closed']),
  openedBy: z.string().nullable(),
  closedBy: z.string().nullable(),
  openingCash: z.number(),
  closingCash: z.number().nullable(),
  expectedCash: z.number().nullable(),
  variance: z.number().nullable(),
  notes: z.string().nullable(),
  openedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
});

export const openRegisterSessionBodySchema = z.object({
  openingCash: z.number().min(0),
  registerName: z.string().max(255).optional(),
  openedBy: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export const closeRegisterSessionBodySchema = z.object({
  closingCash: z.number().min(0),
  closedBy: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export const registerSessionResponseSchema = registerSessionSchema;

export const listRegisterSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const listRegisterSessionsResponseSchema = z.object({
  sessions: z.array(registerSessionSchema),
});

export const openRegisterSessionResponseSchema = z.object({
  session: registerSessionSchema.nullable(),
});

export const registerSessionSummaryResponseSchema = z.object({
  session: registerSessionSchema,
  ordersPlanned: z.number().int(),
  ordersCompleted: z.number().int(),
  ordersVoided: z.number().int(),
  completedSalesTotal: z.number(),
  tenders: z.object({ cash: z.number(), card: z.number(), other: z.number() }),
  expectedCash: z.number(),
});
