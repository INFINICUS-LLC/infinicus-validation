import {
  withTenantTransaction,
  type TenantContext,
} from '@infinicus/database';
import {
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

export class BusinessIntakeService {
  private readonly registry: IntakeMapperRegistry;

  constructor(
    registry?: IntakeMapperRegistry,
    private readonly executor = new OperationalCommandExecutor()
  ) {
    this.registry = registry ?? registerDefaultMappers(new IntakeMapperRegistry());
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
    if (payload.tenantId !== ctx.tenantId || payload.workspaceId !== ctx.workspaceId) {
      throw new BusinessIntakeRejectedError('Handoff tenant/workspace does not match active context.');
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
      if (pkg.business_id !== payload.businessId) {
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
            businessId: payload.businessId,
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
  }
}
