import { z } from 'zod';

export const posReadinessParamsSchema = z.object({ businessId: z.string().uuid() });

const verdictSchema = z.enum(['READY', 'NOT_READY', 'UNVERIFIED']);

/** The POS readiness contract (pos-readiness/1). Closed vocabularies: a code the contract does not list can never be sent. */
export const posReadinessResponseSchema = z.object({
  contract: z.literal('pos-readiness/1'),
  businessId: z.string().uuid(),
  configuration: verdictSchema,
  session: verdictSchema,
  checks: z.array(z.object({
    id: z.enum(['BUSINESS_ACTIVE', 'CURRENCY_DECLARED', 'CURRENCY_SUPPORTED', 'CATALOG_HAS_ACTIVE_PRODUCT', 'TAX_CONFIGURATION', 'INVENTORY_CONFIGURATION', 'BRANCH_CONFIGURATION', 'REGISTER_OPEN', 'REGISTER_CURRENCY_MATCHES']),
    scope: z.enum(['CONFIGURATION', 'SESSION']),
    requirement: z.enum(['REQUIRED', 'ADVISORY']),
    status: z.enum(['PASS', 'FAIL', 'UNVERIFIED', 'SKIPPED', 'NOT_APPLICABLE']),
    reasonCode: z.enum([
      'BUSINESS_NOT_ACTIVE', 'CURRENCY_NOT_DECLARED', 'CURRENCY_NOT_SUPPORTED', 'NO_ACTIVE_PRODUCTS', 'TAX_NOT_MODELLED', 'INVENTORY_NOT_LINKED_TO_SALES',
      'BRANCH_NOT_MODELLED', 'REGISTER_NOT_OPEN', 'REGISTER_CURRENCY_MISMATCH', 'DEPENDENCY_UNAVAILABLE', 'PREREQUISITE_NOT_MET',
    ]).nullable(),
  })),
  blockingReasons: z.array(z.string()),
});
