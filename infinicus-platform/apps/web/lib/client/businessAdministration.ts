/**
 * The business screen's pure logic (ADMIN-WEB-1): the response contracts (copies of the existing, read-only declared-currency reads, `bo:read`),
 * validated on every read, the request paths and display helpers. No React, no network. The declared currency is shown exactly as the service
 * returned it: there is never a default, nothing is converted and nothing is guessed when a business has not declared one.
 */
import { z } from 'zod';

export const declarationSchema = z.object({
  declarationId: z.string().uuid(),
  version: z.number().int(),
  currency: z.string(),
  priorCurrency: z.string().nullable(),
  supersedesVersion: z.number().int().nullable(),
  provenance: z.literal('EXPLICIT_DECLARATION'),
  declaredByUserId: z.string().uuid(),
  permissionUsed: z.string(),
  reason: z.string().nullable(),
  correlationId: z.string().uuid(),
  declaredAt: z.string(),
});
export const declaredCurrencySchema = z.object({
  status: z.enum(['UNDECLARED', 'DECLARED']),
  businessId: z.string().uuid(),
  declaration: declarationSchema.nullable(),
}).refine((v) => (v.status === 'DECLARED') === (v.declaration !== null), { message: 'status and declaration disagree' });
export const declaredCurrencyHistorySchema = z.object({
  businessId: z.string().uuid(),
  items: z.array(declarationSchema),
});
export type DeclaredCurrencyResponse = z.infer<typeof declaredCurrencySchema>;
export type DeclaredCurrencyHistoryResponse = z.infer<typeof declaredCurrencyHistorySchema>;
export type Declaration = z.infer<typeof declarationSchema>;

const base = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}/declared-currency`;
export const declaredCurrencyPath = (businessId: string): string => base(businessId);
export const declaredCurrencyHistoryPath = (businessId: string): string => `${base(businessId)}/history`;

/** A timestamp as an unambiguous UTC date and time, or "unavailable" when it cannot be read. */
export function utcDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unavailable' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What a declaration changed: the first declaration, or the change from the prior currency. */
export const changeLabel = (d: Pick<Declaration, 'currency' | 'priorCurrency'>): string =>
  d.priorCurrency === null ? 'First declaration' : `Changed from ${d.priorCurrency} to ${d.currency}`;
