import { z } from 'zod';

export const businessIdParamsSchema = z.object({ businessId: z.string().uuid() });
export const printerIdParamsSchema = z.object({ businessId: z.string().uuid(), printerId: z.string().uuid() });

export const createPrinterBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['receipt', 'kitchen']),
  connection: z.enum(['browser', 'network', 'bluetooth', 'usb']),
  paperMm: z.union([z.literal(58), z.literal(80)]),
  isDefault: z.boolean().optional(),
}).strict();

const printerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['receipt', 'kitchen']),
  connection: z.enum(['browser', 'network', 'bluetooth', 'usb']),
  paperMm: z.union([z.literal(58), z.literal(80)]),
  isDefault: z.boolean(),
  status: z.enum(['active', 'retired']),
  retiredAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const printerResponseSchema = printerSchema;
export const listPrintersResponseSchema = z.object({ printers: z.array(printerSchema) });
