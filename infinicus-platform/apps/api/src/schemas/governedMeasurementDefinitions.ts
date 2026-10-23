import { z } from 'zod';

export const governedDefinitionParamsSchema = z.object({ businessId: z.string().uuid() });
export const governedDefinitionResponseSchema = z.object({
  businessId: z.string().uuid(),
  definitions: z.array(z.object({
    id: z.string().uuid(), businessId: z.string().uuid(), actionTypeCode: z.string(),
    actionTypeSchemaVersion: z.string(), metricCode: z.string(), definitionVersion: z.number().int(),
    windowSeconds: z.number().int(), baselineSeconds: z.number().int(), minimumObservations: z.number().int(),
    attributionRuleCode: z.string(), successDirection: z.enum(['increase', 'decrease']),
    successThreshold: z.string(), authorId: z.string().uuid(), approverId: z.string().uuid(), approvedAt: z.string(),
  })),
  truncated: z.boolean(),
});
