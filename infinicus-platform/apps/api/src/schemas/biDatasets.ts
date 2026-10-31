import { z } from 'zod';
import { BI_INTAKE_DOMAINS } from '@infinicus/workflow';

/**
 * BI-1 read API (BI-1-DEV-03): what Business Intelligence has taken in from Business Operations and the versioned analytical datasets built from it.
 * Read-only. Identifiers are UUIDs (a malformed one is a 400 before any query); unknown query parameters are refused. Scores are nullable by design: null means
 * "not assessed", never zero.
 */
const INTAKE_STATUSES = ['received', 'validating', 'validated', 'rejected', 'processed', 'superseded'] as const;
const domain = z.enum(BI_INTAKE_DOMAINS);
const page = { limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100_000).default(0) };

export const biBusinessParamsSchema = z.object({ businessId: z.string().uuid() });
export const biIntakeParamsSchema = z.object({ businessId: z.string().uuid(), intakePackageId: z.string().uuid() });
export const biDatasetParamsSchema = z.object({ businessId: z.string().uuid(), datasetId: z.string().uuid() });
export const biIntakeListQuerySchema = z.object({ status: z.enum(INTAKE_STATUSES).optional(), domain: domain.optional(), ...page }).strict();
export const biDatasetListQuerySchema = z.object({ domain: domain.optional(), ...page }).strict();
export const biDatasetQuerySchema = z.object({ versionLimit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

const score = z.number().min(0).max(1).nullable();
const flatReference = z.record(z.string(), z.unknown());

const intakeSummary = z.object({
  id: z.string().uuid(), businessId: z.string().uuid(), boPublicationPackageId: z.string().uuid(), intakeCode: z.string(), domain: z.string(), status: z.string(),
  rejectionReason: z.string().nullable(), schemaVersion: z.string(), correlationId: z.string().uuid(), createdAt: z.string(), updatedAt: z.string(),
});
export const biIntakeListResponseSchema = z.object({ intakePackages: z.array(intakeSummary), limit: z.number().int(), offset: z.number().int() });
export const biIntakeDetailResponseSchema = intakeSummary.extend({
  statusHistory: z.array(z.object({ fromStatus: z.string().nullable(), toStatus: z.string(), reason: z.string().nullable(), occurredAt: z.string() })),
  versions: z.array(z.object({ versionNumber: z.number().int(), recordCount: z.number().int(), payloadReference: flatReference, qualityScore: score, completenessScore: score, recordedAt: z.string() })),
  sourceReferences: z.array(z.object({
    id: z.string().uuid(), sourceSystem: z.string(), boHandoffRecordId: z.string().uuid().nullable(), packageCode: z.string().nullable(), handoffId: z.string().nullable(),
    contractVersion: z.string().nullable(), recordedAt: z.string(),
  })),
  domainInputs: z.array(z.object({ domain: z.string(), status: z.string() })),
  datasetVersions: z.array(z.object({ datasetId: z.string().uuid(), datasetCode: z.string(), datasetVersionId: z.string().uuid(), versionNumber: z.number().int() })),
});

const datasetSummary = z.object({
  id: z.string().uuid(), businessId: z.string().uuid(), datasetCode: z.string(), domain: z.string(), name: z.string(), description: z.string().nullable(), status: z.string(),
  latestVersion: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
});
export const biDatasetListResponseSchema = z.object({ datasets: z.array(datasetSummary), limit: z.number().int(), offset: z.number().int() });
export const biDatasetDetailResponseSchema = datasetSummary.extend({
  versions: z.array(z.object({
    id: z.string().uuid(), versionNumber: z.number().int(), effectiveStart: z.string(), effectiveEnd: z.string().nullable(), publicationStatus: z.string(),
    qualityScore: score, completenessScore: score, intakePackageId: z.string().uuid().nullable(), schemaReference: flatReference, correlationId: z.string().uuid(), createdAt: z.string(),
    dataReferences: z.array(z.object({ referenceType: z.string(), recordCount: z.number().int(), reference: flatReference })),
    lineage: z.array(z.object({ lineageType: z.string(), sourceReferenceId: z.string().uuid().nullable(), parentDatasetVersionId: z.string().uuid().nullable() })),
  })),
});
