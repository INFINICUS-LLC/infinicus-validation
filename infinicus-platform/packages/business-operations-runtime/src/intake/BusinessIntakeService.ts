import { randomUUID } from 'crypto';
import {
  PublicationDeliveryRepository,
  PublicationPackageRepository,
  withTenantTransaction,
  type PublicationPackage,
  type TenantContext,
} from '@infinicus/database';
import {
  DAL_TO_BO_CONTRACT_VERSION,
  validateDALToBOHandoff,
  type DALToBOHandoff,
} from '@infinicus/handoff-contracts';
import { BusinessIntakeRejectedError, OperationalMappingError } from '../errors.js';
import type { OperationalCommand } from '../types.js';
import { IntakeMapperRegistry } from './IntakeMapperRegistry.js';
import { registerDefaultMappers } from './defaultMappers.js';
import {
  OperationalCommandExecutor,
  type CommandExecutionResult,
} from '../OperationalCommandExecutor.js';

/** The destination layer name BO uses on Data Acquisition's delivery record. */
const DESTINATION_LAYER = 'business_operations';

export interface BusinessIntakeResult {
  publicationPackageId: string;
  deliveryId: string;
  idempotentReplay: boolean;
  acceptedRecordCount: number;
  commandCount: number;
  results: CommandExecutionResult[];
}

interface SubmissionRow {
  id: string;
  payload: unknown;
}

interface ProvenanceRow {
  id: string;
  record_reference: string;
}

function recordsFromPayload(payload: unknown): unknown[] {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Array.isArray((payload as { records?: unknown }).records)
  ) {
    return (payload as { records: unknown[] }).records;
  }
  throw new BusinessIntakeRejectedError('Manual submission payload does not contain records array.');
}

export interface BusinessIntakePolicy {
  minimumQualityScore: number;
  minimumReliabilityScore: number;
}

export const DEFAULT_BUSINESS_INTAKE_POLICY: BusinessIntakePolicy = Object.freeze({
  minimumQualityScore: 0.80,
  minimumReliabilityScore: 0.70,
});

function hasCriticalLimitation(limitations: readonly unknown[]): boolean {
  return limitations.some((value) => {
    if (typeof value === 'string') return /^critical\s*:/i.test(value.trim());
    if (value && typeof value === 'object') {
      const severity = (value as { severity?: unknown }).severity;
      return typeof severity === 'string' && severity.toLowerCase() === 'critical';
    }
    return false;
  });
}

function toContractDataReference(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      result[key] = item;
      continue;
    }
    throw new BusinessIntakeRejectedError(
      `Publication data reference contains unsupported value at ${key}.`
    );
  }
  return result;
}

function contractLimitations(values: readonly unknown[]): string[] {
  return values.map((value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const severity = (value as { severity?: unknown }).severity;
      const description = (value as { description?: unknown }).description;
      if (typeof severity === 'string' && severity.toLowerCase() === 'critical') {
        return `critical: ${typeof description === 'string' ? description : JSON.stringify(value)}`;
      }
      return JSON.stringify(value);
    }
    return String(value);
  });
}

function stringReferences(values: readonly unknown[], field: string): string[] {
  return values.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BusinessIntakeRejectedError(`${field}[${index}] must be a non-empty string.`);
    }
    return value;
  });
}

function controlledFailureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : 'BusinessIntakeFailure';
  const message = error instanceof Error ? error.message : 'Unknown Business Operations intake failure.';
  return `${name}: ${message}`.slice(0, 500);
}

export class BusinessIntakeService {
  private readonly registry: IntakeMapperRegistry;

  constructor(
    registry?: IntakeMapperRegistry,
    private readonly executor = new OperationalCommandExecutor(),
    private readonly publicationPackages = new PublicationPackageRepository(),
    private readonly policy: BusinessIntakePolicy = DEFAULT_BUSINESS_INTAKE_POLICY,
    // Data Acquisition owns data_acquisition.publication_deliveries (V-07 / SOT-09). BO only acknowledges or rejects through DAL's repository.
    private readonly deliveries = new PublicationDeliveryRepository()
  ) {
    this.registry = registry ?? registerDefaultMappers(new IntakeMapperRegistry());
  }

  async processPublishedPackage(
    ctx: TenantContext,
    businessId: string,
    publicationPackageId: string
  ): Promise<BusinessIntakeResult> {
    const pkg = await this.publicationPackages.findById(ctx, publicationPackageId);
    if (pkg.businessId !== businessId) {
      throw new BusinessIntakeRejectedError('Published Data Acquisition package not found in business scope.');
    }
    return this.processHandoff(ctx, this.handoffFromPublication(ctx, pkg));
  }

  private handoffFromPublication(ctx: TenantContext, pkg: PublicationPackage): DALToBOHandoff {
    if (pkg.status !== 'published' || pkg.publishedAt === null) {
      throw new BusinessIntakeRejectedError('Publication package is not published.');
    }
    if (pkg.targetLayer !== 'business_operations') {
      throw new BusinessIntakeRejectedError('Publication package does not target Business Operations.');
    }
    if (pkg.businessId === null) {
      throw new BusinessIntakeRejectedError('Business Operations intake requires a business-scoped publication.');
    }

    return {
      handoffId: randomUUID(),
      sourceLayer: 'DAL',
      sourceBlock: 'DA-24',
      targetLayer: 'BO',
      targetBlock: pkg.targetBlock,
      correlationId: pkg.correlationId,
      lineage: [],
      status: 'ready',
      createdAt: new Date().toISOString(),
      payload: {
        contractVersion: DAL_TO_BO_CONTRACT_VERSION,
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        businessId: pkg.businessId,
        publicationPackageId: pkg.id,
        packageType: pkg.packageType,
        packageVersion: pkg.packageVersion,
        targetLayer: 'business_operations',
        targetBlock: pkg.targetBlock,
        status: 'published',
        publishedAt: pkg.publishedAt.toISOString(),
        recordCount: pkg.recordCount,
        source: {
          sourceSystem: 'INFINICUS_DA',
          dataReference: toContractDataReference(pkg.dataReference),
        },
        schemaReferenceId: pkg.schemaReferenceId,
        quality: {
          qualityScore: pkg.qualityScore,
          reliabilityScore: pkg.reliabilityScore,
        },
        provenanceReferenceIds: stringReferences(pkg.provenanceReferenceIds, 'provenanceReferenceIds'),
        consentReferenceIds: [],
        limitations: contractLimitations(pkg.limitations),
        warnings: [],
        idempotencyKey: `dal-to-bo:${pkg.id}:${pkg.packageVersion}`,
      },
    };
  }

  /**
   * The handoff was rejected or failed: tell Data Acquisition so it records the failed attempt on ITS delivery. BO writes no Data Acquisition table.
   * Runs in its own transaction (inside the repository) because the intake transaction has rolled back.
   */
  private async recordRejectedDelivery(
    ctx: TenantContext,
    publicationPackageId: string,
    error: unknown
  ): Promise<void> {
    await this.deliveries.recordLayerFailure(ctx, publicationPackageId, DESTINATION_LAYER, controlledFailureReason(error));
  }

  async processHandoff(ctx: TenantContext, handoff: DALToBOHandoff): Promise<BusinessIntakeResult> {
    const validation = validateDALToBOHandoff(handoff);
    if (!validation.valid) {
      throw new BusinessIntakeRejectedError('DAL to BO handoff validation failed.', validation.reasons);
    }

    const payload = handoff.payload;
    if (payload.businessId === null) {
      throw new BusinessIntakeRejectedError('Business Operations intake requires a business-scoped publication.');
    }
    const businessId = payload.businessId;
    if (payload.tenantId !== ctx.tenantId || payload.workspaceId !== ctx.workspaceId) {
      throw new BusinessIntakeRejectedError('Handoff tenant/workspace does not match active context.');
    }
    try {
    if (
      payload.quality.qualityScore === null ||
      payload.quality.qualityScore < this.policy.minimumQualityScore
    ) {
      throw new BusinessIntakeRejectedError(
        `Publication quality is below the Business Operations threshold (${this.policy.minimumQualityScore}).`
      );
    }
    if (
      payload.quality.reliabilityScore !== null &&
      payload.quality.reliabilityScore < this.policy.minimumReliabilityScore
    ) {
      throw new BusinessIntakeRejectedError(
        `Publication reliability is below the Business Operations threshold (${this.policy.minimumReliabilityScore}).`
      );
    }
    if (payload.recordCount > 0 && payload.provenanceReferenceIds.length === 0) {
      throw new BusinessIntakeRejectedError('Published records require provenance references.');
    }
    if (hasCriticalLimitation(payload.limitations)) {
      throw new BusinessIntakeRejectedError('Publication contains an unresolved critical limitation.');
    }

    return withTenantTransaction(ctx, async (client) => {
      const pkgResult = await client.query<Record<string, unknown>>(
        `SELECT *
         FROM data_acquisition.publication_packages
         WHERE id = $1
         FOR UPDATE`,
        [payload.publicationPackageId]
      );
      if (pkgResult.rowCount !== 1) {
        throw new BusinessIntakeRejectedError('Published Data Acquisition package not found.');
      }

      const pkg = pkgResult.rows[0];
      if (pkg.tenant_id !== ctx.tenantId || pkg.workspace_id !== ctx.workspaceId) {
        throw new BusinessIntakeRejectedError('Publication package scope mismatch.');
      }
      if (pkg.business_id !== businessId) {
        throw new BusinessIntakeRejectedError('Publication package business scope mismatch.');
      }
      if (pkg.status !== 'published' || pkg.target_layer !== 'business_operations') {
        throw new BusinessIntakeRejectedError('Publication package is not published for Business Operations.');
      }
      if (payload.recordCount !== Number(pkg.record_count)) {
        throw new BusinessIntakeRejectedError('Handoff record count does not match persisted publication package.');
      }

      // Begin (or restart) the delivery attempt through Data Acquisition's repository. A package already delivered to BO is an idempotent replay.
      const attempt = await this.deliveries.beginLayerAttemptOn(client, payload.publicationPackageId, DESTINATION_LAYER);
      if (attempt.alreadyDelivered) {
        return {
          publicationPackageId: payload.publicationPackageId,
          deliveryId: attempt.deliveryId,
          idempotentReplay: true,
          acceptedRecordCount: payload.recordCount,
          commandCount: 0,
          results: [],
        };
      }
      const deliveryId = attempt.deliveryId;

      const dataReference = pkg.data_reference as { collectionRunId?: unknown };
      if (typeof dataReference?.collectionRunId !== 'string' || dataReference.collectionRunId.length === 0) {
        throw new BusinessIntakeRejectedError('Publication package has no collectionRunId reference.');
      }

      const submissions = await client.query<SubmissionRow>(
        `SELECT id, payload
         FROM data_acquisition.manual_submissions
         WHERE collection_run_id = $1
         ORDER BY created_at ASC`,
        [dataReference.collectionRunId]
      );
      if (submissions.rowCount === 0) {
        throw new BusinessIntakeRejectedError('No manual submission found for published collection run.');
      }

      const provenance = await client.query<ProvenanceRow>(
        `SELECT id, record_reference
         FROM data_acquisition.provenance_records
         WHERE collection_run_id = $1`,
        [dataReference.collectionRunId]
      );
      const provenanceByReference = new Map(
        provenance.rows.map((row) => [row.record_reference, row.id])
      );

      const commands: OperationalCommand[] = [];
      let acceptedRecordCount = 0;

      for (const submission of submissions.rows) {
        const records = recordsFromPayload(submission.payload);
        for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
          const reference = `${submission.id}#${recordIndex}`;
          const provenanceId = provenanceByReference.get(reference);
          if (!provenanceId) continue; // rejected DA record: no provenance by BUILD-31 design

          acceptedRecordCount++;
          const mapped = this.registry.mapRecord(records[recordIndex], {
            tenantId: ctx.tenantId,
            workspaceId: ctx.workspaceId,
            businessId,
            correlationId: handoff.correlationId,
            sourceReference: reference,
            provenanceReference: provenanceId,
            idempotencyKey: `${payload.idempotencyKey}:${reference}`,
            actorId: ctx.userId,
            occurredAt: handoff.createdAt,
            recordIndex,
          });
          commands.push(...mapped);
        }
      }

      if (acceptedRecordCount !== payload.recordCount) {
        throw new BusinessIntakeRejectedError(
          `Accepted-record count mismatch: handoff=${payload.recordCount}, resolved=${acceptedRecordCount}.`
        );
      }

      const results: CommandExecutionResult[] = [];
      for (const command of commands) {
        try {
          results.push(await this.executor.executeOn(client, ctx, command));
        } catch (error) {
          if (error instanceof BusinessIntakeRejectedError || error instanceof OperationalMappingError) throw error;
          throw new OperationalMappingError(
            error instanceof Error ? error.message : 'Unknown operational command execution failure.'
          );
        }
      }

      await this.deliveries.markLayerDeliveredOn(client, deliveryId);

      return {
        publicationPackageId: payload.publicationPackageId,
        deliveryId,
        idempotentReplay: false,
        acceptedRecordCount,
        commandCount: commands.length,
        results,
      };
    });
    } catch (error) {
      await this.recordRejectedDelivery(ctx, payload.publicationPackageId, error);
      throw error;
    }
  }
}
