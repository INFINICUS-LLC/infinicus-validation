import { z } from 'zod';

/**
 * Request/response contracts for the ABA authoring and administration surface (P0-5).
 *
 * Every request schema is STRICT: an unknown key (final parameters, risk, authority, digest, lifecycle, status, tenant or user identity,
 * a package payload...) is a 400, never silently ignored. Identity, authority, approver, risk and package facts are server-derived and
 * have no field here.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema).max(100), z.record(z.string(), jsonValueSchema)]));

const code = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/);
const schemaVersion = z.string().min(1).max(50).regex(/^[0-9][0-9.]*$/);
const reasonText = z.string().trim().min(1).max(1000);
const isoInstant = z.string().datetime({ offset: false });

const governed = <T extends z.ZodTypeAny>(value: T) => z.union([
  z.object({ state: z.literal('VALUE'), value }).strict(),
  z.object({ state: z.literal('NOT_APPLICABLE'), reason: z.object({ code: z.string().min(1).max(100), statement: z.string().min(1).max(500) }).strict() }).strict(),
]);

// ── params ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const actionTypeParamsSchema = z.object({ code, schemaVersion });
export const policyParamsSchema = z.object({ policyCode: code });
export const policyVersionParamsSchema = z.object({ policyCode: code, versionNumber: z.coerce.number().int().min(1) });
export const authorizedActionParamsSchema = z.object({ businessId: z.string().uuid(), actionId: z.string().uuid() });

// ── A. action types ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The caller names the canonical type; the definition itself is always derived from the shared contract. */
export const defineActionTypeBodySchema = z.object({ code, schemaVersion }).strict();
export const retireActionTypeBodySchema = z.object({ reason: reasonText }).strict();
export const actionTypeViewSchema = z.object({
  id: z.string().uuid(), code: z.string(), schemaVersion: z.string(), status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']),
  targetKinds: z.array(z.string()), created: z.boolean().optional(),
});
export const actionTypeListResponseSchema = z.object({ items: z.array(actionTypeViewSchema) });

// ── B. policies ─────────────────────────────────────────────────────────────────────────────────────────────────────
const policyActionTypesSchema = z.array(z.object({ code, schemaVersion }).strict()).min(1).max(50);
export const createPolicyBodySchema = z.object({
  policyCode: code, automationLevel: z.number().int().min(0).max(9), description: z.string().trim().min(1).max(2000), actionTypes: policyActionTypesSchema,
}).strict();
export const addPolicyVersionBodySchema = z.object({ description: z.string().trim().min(1).max(2000), actionTypes: policyActionTypesSchema }).strict();
export const policyEnablementBodySchema = z.object({ reason: reasonText }).strict();
export const policyViewSchema = z.object({
  policyId: z.string().uuid(), policyCode: z.string(), automationLevel: z.number(), created: z.boolean().optional(),
  versions: z.array(z.object({
    versionNumber: z.number(), policyVersionId: z.string().uuid(), description: z.string(), enabled: z.boolean(),
    actionTypes: z.array(z.object({ code: z.string(), schemaVersion: z.string() })),
  })),
});
export const enablementViewSchema = z.object({
  automationLevels: z.array(z.number()),
  effective: z.array(z.object({ policyCode: z.string(), automationLevel: z.number(), versionNumber: z.number(), policyVersionId: z.string().uuid() })),
});

// ── C. capture ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const captureBodySchema = z.object({
  actionType: z.object({ code, schemaVersion }).strict(),
  target: z.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(200) }).strict(),
  proposedParameters: z.record(z.string(), jsonValueSchema),
  modification: z.object({
    reason: reasonText,
    changes: z.array(z.object({
      parameter: z.string().min(1).max(100), operation: z.enum(['SET', 'ADD', 'REMOVE']), before: jsonValueSchema.optional(), after: jsonValueSchema.optional(),
    }).strict()).min(1).max(50),
  }).strict().optional(),
  evaluationEvidence: z.array(z.object({
    dimension: z.enum(['SIMULATION', 'RISK', 'CONSTRAINTS', 'VALIDITY', 'RESOURCE_REQUIREMENTS', 'COST', 'REVERSIBILITY', 'EXPECTED_OUTCOME']),
    evidenceRef: z.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(200) }).strict(),
  }).strict()).max(8).optional(),
}).strict();
export const captureViewSchema = z.object({
  captureId: z.string().uuid(), actionId: z.string().uuid(), decisionStatus: z.string(),
  actionType: z.object({ code: z.string(), schemaVersion: z.string() }), finalParameters: z.record(z.string(), z.unknown()), capturedAt: z.string(), created: z.boolean(),
});

// ── D. owner ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ownerBodySchema = z.object({
  ownerUserId: z.string().uuid(), membershipId: z.string().uuid(), roleCode: z.string().trim().min(1).max(100),
  dueAt: governed(isoInstant), escalationPolicy: governed(z.object({ ref: z.string().min(1).max(200) }).strict()),
}).strict();
export const ownerViewSchema = z.object({
  assignmentId: z.string().uuid(), assignmentVersion: z.number(), ownerUserId: z.string().uuid(), membershipId: z.string().uuid(),
  roleCode: z.string(), assignedAt: z.string(), created: z.boolean(),
});

// ── E. boundaries ───────────────────────────────────────────────────────────────────────────────────────────────────
export const boundariesBodySchema = z.object({
  executionWindow: governed(z.object({ startsAt: isoInstant, endsAt: isoInstant.nullable() }).strict()),
  preconditions: governed(z.array(z.object({
    code: z.string().min(1).max(100), operator: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'contains']), operand: jsonValueSchema,
  }).strict()).max(50)),
  budget: governed(z.object({ amount: z.string().regex(/^[0-9.]{1,40}$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict()),
  rollback: governed(z.object({ instructions: z.string().min(1).max(2000) }).strict()),
  monitoring: governed(z.object({
    metrics: z.array(z.object({ metricCode: z.string().min(1).max(100), target: jsonValueSchema.nullable(), unit: z.string().max(50).nullable() }).strict()).min(1).max(50),
  }).strict()),
  simulationRun: governed(z.string().uuid()),
}).strict();
export const boundariesViewSchema = z.object({ boundariesId: z.string().uuid(), boundaryVersion: z.number(), authoredAt: z.string(), created: z.boolean() });

// ── F. issuance: NO body (identifiers only) ─────────────────────────────────────────────────────────────────────────
export const issueBodySchema = z.object({}).strict().nullish();
export const issuedPackageViewSchema = z.object({
  outcome: z.enum(['ISSUED', 'REPLAYED']), packageId: z.string().uuid(), packageVersion: z.number(), status: z.literal('ISSUED'), digest: z.string(),
  issuedAt: z.string(), expiresAt: z.string().nullable(), automationLevel: z.number(),
  actionType: z.object({ code: z.string(), schemaVersion: z.string() }),
  supersedes: z.object({ packageId: z.string().uuid(), packageVersion: z.number() }).nullable(),
});

// ── G. status ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const authoringStatusViewSchema = z.object({
  actionId: z.string().uuid(), decision: z.object({ id: z.string().uuid(), status: z.string() }),
  actionType: z.object({ code: z.string(), schemaVersion: z.string(), status: z.string() }).nullable(),
  capture: z.object({ recorded: z.boolean(), capturedAt: z.string().nullable() }),
  owner: z.object({ assigned: z.boolean(), assignmentVersion: z.number().nullable() }),
  boundaries: z.object({ authored: z.boolean(), boundaryVersion: z.number().nullable() }),
  level2Policy: z.object({ enabled: z.boolean(), policyCode: z.string().nullable(), versionNumber: z.number().nullable() }),
  latestPackage: z.object({ packageId: z.string().uuid(), packageVersion: z.number(), lifecycle: z.string(), digest: z.string(), expiresAt: z.string().nullable() }).nullable(),
  missing: z.array(z.string()),
});
