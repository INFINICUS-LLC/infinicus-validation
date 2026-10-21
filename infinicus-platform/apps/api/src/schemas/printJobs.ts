import { z } from 'zod';
import { printerResponseSchema } from './printers.js';

export const orderParamsSchema = z.object({ businessId: z.string().uuid(), orderId: z.string().uuid() });
export const businessParamsSchema = z.object({ businessId: z.string().uuid() });
export const listPrintJobsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export const recordPrintJobBodySchema = z.object({
  kind: z.enum(['receipt', 'kitchen']),
  trigger: z.enum(['automatic', 'reprint', 'manual']),
  outcome: z.enum(['succeeded', 'failed']),
  failureCode: z.enum(['printer_error', 'timeout', 'unsupported', 'other']).optional(),
  printedVia: z.enum(['browser', 'device']),
  printerId: z.string().uuid().optional(),
}).strict().refine((b) => b.outcome === 'failed' || b.failureCode === undefined, { message: 'failureCode is only for a failed print', path: ['failureCode'] });

const printJobSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  printerId: z.string().uuid().nullable(),
  kind: z.enum(['receipt', 'kitchen']),
  trigger: z.enum(['automatic', 'reprint', 'manual']),
  outcome: z.enum(['succeeded', 'failed']),
  failureCode: z.enum(['printer_error', 'timeout', 'unsupported', 'other']).nullable(),
  printedVia: z.enum(['browser', 'device']),
  createdAt: z.coerce.date(),
});
export const printJobResponseSchema = printJobSchema;
export const listPrintJobsResponseSchema = z.object({ printJobs: z.array(printJobSchema) });
export const printRoutesResponseSchema = z.object({ receipt: printerResponseSchema.nullable(), kitchen: printerResponseSchema.nullable() });
