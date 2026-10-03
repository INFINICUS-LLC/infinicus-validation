import { randomUUID } from 'crypto';
import {
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
    private readonly policy: BusinessIntakePolicy = DEFAULT_BUSINESS_INTAKE_POLICY
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

  private async recordRejectedDelivery(
    ctx: TenantContext,
    publicationPackageId: string,
    error: unknown
  ): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      // Lock the source-owned package only to serialize receipt creation.
      // The package itself remains immutable from the target layer.
      const pkg = await client.query(
        `SELECT id
         FROM data_acquisition.publication_packages
         WHERE id = $1
         FOR UPDATE`,
        [publicationPackageId]
      );
      if (pkg.rowCount !== 1) return;

      const existing = await client.query<Record<string, unknown>>(
        `SELECT id, delivery_status
         FROM data_acquisition.publication_deliveries
         WHERE publication_package_id = $1
           AND destination_type = 'layer'
           AND destination_reference = 'business_operations'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [publicationPackageId]
      );

      // A successful custody transfer is terminal for this package version.
      if (existing.rowCount === 1 && existing.rows[0].delivery_status === 'delivered') return;

      const failureReason = controlledFailureReason(error);
      if (existing.rowCount === 1) {
        await client.query(
          `UPDATE data_acquisition.publication_deliveries
           SET delivery_status = 'failed',
               attempt_count = attempt_count + 1,
               last_attempt_at = now(),
               failure_reason = $2
           WHERE id = $1`,
          [existing.rows[0].id, failureReason]
        );
        return;
      }

      await client.query(
        `INSERT INTO data_acquisition.publication_deliveries
           (publication_package_id, destination_type, destination_reference,
            delivery_status, attempt_count, last_attempt_at, failure_reason)
         VALUES ($1,'layer','business_operations','failed',1,now(),$2)`,
        [publicationPackageId, failureReason]
      );
    });
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

      const existingDelivery = await client.query<Record<string, unknown>>(
        `SELECT *
         FROM data_acquisition.publication_deliveries
         WHERE publication_package_id = $1
           AND destination_type = 'layer'
           AND destination_reference = 'business_operations'
         ORDER BY created_at ASC
         LIMIT 1`,
        [payload.publicationPackageId]
      );

      if (existingDelivery.rowCount === 1 && existingDelivery.rows[0].delivery_status === 'delivered') {
        return {
          publicationPackageId: payload.publicationPackageId,
          deliveryId: existingDelivery.rows[0].id as string,
          idempotentReplay: true,
          acceptedRecordCount: payload.recordCount,
          commandCount: 0,
          results: [],
        };
      }

      let deliveryId: string;
      if (existingDelivery.rowCount === 1) {
        deliveryId = existingDelivery.rows[0].id as string;
        await client.query(
          `UPDATE data_acquisition.publication_deliveries
           SET delivery_status = 'in_progress',
               attempt_count = attempt_count + 1,
               last_attempt_at = now(),
               failure_reason = NULL
           WHERE id = $1`,
          [deliveryId]
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO data_acquisition.publication_deliveries
             (publication_package_id, destination_type, destination_reference,
              delivery_status, attempt_count, last_attempt_at)
           VALUES ($1,'layer','business_operations','in_progress',1,now())
           RETURNING id`,
          [payload.publicationPackageId]
        );
        deliveryId = inserted.rows[0].id;
      }

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

      await client.query(
        `UPDATE data_acquisition.publication_deliveries
         SET delivery_status = 'delivered', delivered_at = now(), failure_reason = NULL
         WHERE id = $1`,
        [deliveryId]
      );

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
