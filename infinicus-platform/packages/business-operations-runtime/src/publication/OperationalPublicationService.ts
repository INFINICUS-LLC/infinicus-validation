import { randomUUID } from 'crypto';
import {
  type TenantContext,
  withTenantTransaction,
} from '@infinicus/database';
import {
  BO_TO_BI_CONTRACT_VERSION,
  type BOToBIHandoff,
  validateBOToBIHandoff,
} from '@infinicus/handoff-contracts';
import { OperationalMappingError, OperationalStateTransitionError } from '../errors.js';

export interface PrepareOperationalPublicationInput {
  businessId: string;
  packageCode: string;
  targetBlock: string;
  periodStart: Date;
  periodEnd: Date;
  recordCount: number;
  payloadReference: Record<string, string | number | boolean | null>;
  schemaVersion?: string;
  correlationId?: string;
  createdBy?: string;
}

export interface OperationalPublicationPackage {
  id: string;
  businessId: string;
  packageCode: string;
  targetLayer: string;
  targetBlock: string;
  periodStart: Date;
  periodEnd: Date;
  recordCount: number;
  payloadReference: Record<string, string | number | boolean | null>;
  packageStatus: string;
  version: number;
  correlationId: string;
  dispatchedAt: Date | null;
  acknowledgedAt: Date | null;
}

function rowToPackage(row: Record<string, unknown>): OperationalPublicationPackage {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    packageCode: row.package_code as string,
    targetLayer: row.target_layer as string,
    targetBlock: row.target_block as string,
    periodStart: row.period_start as Date,
    periodEnd: row.period_end as Date,
    recordCount: Number(row.record_count),
    payloadReference: row.payload_reference as Record<string, string | number | boolean | null>,
    packageStatus: row.package_status as string,
    version: Number(row.version),
    correlationId: row.correlation_id as string,
    dispatchedAt: row.dispatched_at as Date | null,
    acknowledgedAt: row.acknowledged_at as Date | null,
  };
}

function stablePayloadReference(
  value: Record<string, string | number | boolean | null>
): string {
  return JSON.stringify(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, string | number | boolean | null>>((acc, [key, item]) => {
        acc[key] = item;
        return acc;
      }, {})
  );
}

function samePreparation(
  existing: OperationalPublicationPackage,
  input: PrepareOperationalPublicationInput
): boolean {
  return (
    existing.businessId === input.businessId &&
    existing.targetLayer === 'business_intelligence' &&
    existing.targetBlock === input.targetBlock &&
    existing.periodStart.getTime() === input.periodStart.getTime() &&
    existing.periodEnd.getTime() === input.periodEnd.getTime() &&
    existing.recordCount === input.recordCount &&
    stablePayloadReference(existing.payloadReference) === stablePayloadReference(input.payloadReference)
  );
}

function validatePreparation(input: PrepareOperationalPublicationInput): void {
  if (!input.businessId) throw new OperationalMappingError('businessId is required.');
  if (!input.packageCode.trim()) throw new OperationalMappingError('packageCode is required.');
  if (!input.targetBlock.trim()) throw new OperationalMappingError('targetBlock is required.');
  if (!(input.periodStart instanceof Date) || Number.isNaN(input.periodStart.getTime())) {
    throw new OperationalMappingError('periodStart must be a valid Date.');
  }
  if (!(input.periodEnd instanceof Date) || Number.isNaN(input.periodEnd.getTime())) {
    throw new OperationalMappingError('periodEnd must be a valid Date.');
  }
  if (input.periodEnd <= input.periodStart) {
    throw new OperationalMappingError('periodEnd must be after periodStart.');
  }
  if (!Number.isInteger(input.recordCount) || input.recordCount < 0) {
    throw new OperationalMappingError('recordCount must be a non-negative integer.');
  }
  for (const [key, value] of Object.entries(input.payloadReference)) {
    if (!key.trim()) throw new OperationalMappingError('payloadReference keys must be non-empty.');
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new OperationalMappingError(`payloadReference.${key} is not serializable by the BO to BI contract.`);
    }
  }
}

export class OperationalPublicationService {
  async prepare(
    ctx: TenantContext,
    input: PrepareOperationalPublicationInput
  ): Promise<OperationalPublicationPackage> {
    validatePreparation(input);

    return withTenantTransaction(ctx, async (client) => {
      const business = await client.query(
        `SELECT id FROM platform.businesses WHERE id = $1 AND deleted_at IS NULL`,
        [input.businessId]
      );
      if (business.rowCount !== 1) throw new OperationalMappingError('Business not found in active scope.');

      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.bo_publication_packages
         WHERE business_id = $1 AND package_code = $2`,
        [input.businessId, input.packageCode]
      );
      if (existing.rowCount === 1) {
        const existingPackage = rowToPackage(existing.rows[0]);
        if (!samePreparation(existingPackage, input)) {
          throw new OperationalMappingError(
            'packageCode is already associated with a materially different BO publication package.'
          );
        }
        return existingPackage;
      }

      const correlationId = input.correlationId ?? randomUUID();
      const created = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.bo_publication_packages
           (tenant_id, workspace_id, business_id, package_code, target_layer,
            target_block, period_start, period_end, record_count, payload_reference,
            package_status, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,'business_intelligence',$5,$6,$7,$8,$9,'draft',$10,$11)
         RETURNING *`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          input.businessId,
          input.packageCode,
          input.targetBlock,
          input.periodStart,
          input.periodEnd,
          input.recordCount,
          JSON.stringify(input.payloadReference),
          correlationId,
          input.createdBy ?? ctx.userId,
        ]
      );

      const ready = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.bo_publication_packages
         SET package_status = 'ready', version = version + 1
         WHERE id = $1 AND package_status = 'draft'
         RETURNING *`,
        [created.rows[0].id]
      );
      if (ready.rowCount !== 1) {
        throw new OperationalStateTransitionError('BOPublicationPackage', 'draft', 'ready');
      }
      return rowToPackage(ready.rows[0]);
    });
  }

  async get(
    ctx: TenantContext,
    businessId: string,
    packageId: string
  ): Promise<OperationalPublicationPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.bo_publication_packages
         WHERE id = $1 AND business_id = $2`,
        [packageId, businessId]
      );
      if (result.rowCount !== 1) throw new OperationalMappingError('BO publication package not found.');
      return rowToPackage(result.rows[0]);
    });
  }

  async dispatchToBusinessIntelligence(
    ctx: TenantContext,
    businessId: string,
    packageId: string,
    schemaVersion = '1.0'
  ): Promise<BOToBIHandoff> {
    return withTenantTransaction(ctx, async (client) => {
      const locked = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.bo_publication_packages
         WHERE id = $1 AND business_id = $2
         FOR UPDATE`,
        [packageId, businessId]
      );
      if (locked.rowCount !== 1) throw new OperationalMappingError('BO publication package not found.');

      let pkg = rowToPackage(locked.rows[0]);

      const previousDispatch = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.bo_handoff_records
         WHERE publication_id = $1 AND handoff_type = 'dispatch'
         ORDER BY occurred_at ASC
         LIMIT 1`,
        [packageId]
      );

      if (pkg.packageStatus === 'dispatched' && previousDispatch.rowCount === 1) {
        return this.makeHandoff(
          ctx,
          pkg,
          previousDispatch.rows[0].id as string,
          schemaVersion,
          previousDispatch.rows[0].occurred_at as Date
        );
      }

      if (pkg.packageStatus !== 'ready') {
        throw new OperationalStateTransitionError(
          'BOPublicationPackage',
          pkg.packageStatus,
          'dispatched'
        );
      }

      const handoffId = randomUUID();
      const occurredAt = new Date();
      await client.query(
        `INSERT INTO business_operations.bo_handoff_records
           (id, tenant_id, workspace_id, business_id, publication_id, handoff_type,
            source_layer, target_layer, target_block, record_count, payload,
            occurred_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'dispatch','business_operations',
                 'business_intelligence',$6,$7,$8,$9,$10)`,
        [
          handoffId,
          ctx.tenantId,
          ctx.workspaceId,
          businessId,
          packageId,
          pkg.targetBlock,
          pkg.recordCount,
          JSON.stringify({
            packageCode: pkg.packageCode,
            payloadReference: pkg.payloadReference,
            schemaVersion,
          }),
          occurredAt,
          pkg.correlationId,
        ]
      );

      const dispatched = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.bo_publication_packages
         SET package_status = 'dispatched', dispatched_at = $2, version = version + 1
         WHERE id = $1 AND package_status = 'ready'
         RETURNING *`,
        [packageId, occurredAt]
      );
      if (dispatched.rowCount !== 1) {
        throw new OperationalStateTransitionError('BOPublicationPackage', 'ready', 'dispatched');
      }
      pkg = rowToPackage(dispatched.rows[0]);

      await client.query(
        `SELECT business_operations.emit_bo_data_published(
           $1,$2,$3,'business_intelligence',$4,$5,$6,$7
         )`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          packageId,
          pkg.targetBlock,
          pkg.recordCount,
          pkg.correlationId,
          handoffId,
        ]
      );

      return this.makeHandoff(ctx, pkg, handoffId, schemaVersion, occurredAt);
    });
  }

  async acknowledge(
    ctx: TenantContext,
    businessId: string,
    packageId: string,
    notes?: string
  ): Promise<OperationalPublicationPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const locked = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.bo_publication_packages
         WHERE id = $1 AND business_id = $2
         FOR UPDATE`,
        [packageId, businessId]
      );
      if (locked.rowCount !== 1) throw new OperationalMappingError('BO publication package not found.');
      const current = rowToPackage(locked.rows[0]);

      if (current.packageStatus === 'received') return current;
      if (current.packageStatus !== 'dispatched') {
        throw new OperationalStateTransitionError(
          'BOPublicationPackage',
          current.packageStatus,
          'received'
        );
      }

      await client.query(
        `INSERT INTO business_operations.bo_handoff_records
           (tenant_id, workspace_id, business_id, publication_id, handoff_type,
            source_layer, target_layer, target_block, record_count, notes,
            payload, correlation_id)
         VALUES ($1,$2,$3,$4,'acknowledgement','business_operations',
                 'business_intelligence',$5,$6,$7,'{}',$8)`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          businessId,
          packageId,
          current.targetBlock,
          current.recordCount,
          notes ?? null,
          current.correlationId,
        ]
      );

      const updated = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.bo_publication_packages
         SET package_status = 'received', acknowledged_at = now(), version = version + 1
         WHERE id = $1 AND package_status = 'dispatched'
         RETURNING *`,
        [packageId]
      );
      if (updated.rowCount !== 1) {
        throw new OperationalStateTransitionError('BOPublicationPackage', 'dispatched', 'received');
      }
      return rowToPackage(updated.rows[0]);
    });
  }

  private makeHandoff(
    ctx: TenantContext,
    pkg: OperationalPublicationPackage,
    handoffId: string,
    schemaVersion: string,
    occurredAt: Date
  ): BOToBIHandoff {
    const handoff: BOToBIHandoff = {
      handoffId,
      sourceLayer: 'BO',
      sourceBlock: 'BO-RUNTIME',
      targetLayer: 'BI',
      targetBlock: pkg.targetBlock,
      correlationId: pkg.correlationId,
      lineage: [],
      status: 'ready',
      createdAt: occurredAt.toISOString(),
      payload: {
        contractVersion: BO_TO_BI_CONTRACT_VERSION,
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        businessId: pkg.businessId,
        boPublicationPackageId: pkg.id,
        packageStatus: pkg.packageStatus === 'ready' ? 'ready' : 'dispatched',
        targetBlock: pkg.targetBlock,
        periodStart: pkg.periodStart.toISOString(),
        periodEnd: pkg.periodEnd.toISOString(),
        recordCount: pkg.recordCount,
        source: {
          packageCode: pkg.packageCode,
          payloadReference: pkg.payloadReference,
        },
        schemaVersion,
        idempotencyKey: `bo-to-bi:${pkg.id}:${pkg.version}`,
      },
    };

    const validation = validateBOToBIHandoff(handoff);
    if (!validation.valid) {
      throw new OperationalMappingError(
        `Generated BO to BI handoff is invalid: ${validation.reasons.join(', ')}`
      );
    }
    return handoff;
  }
}
