/**
 * BI-1 (BI-03 data-ingestion coordination): the single-transaction intake of a Business Operations publication package.
 *
 * Business Intelligence consumes only what BO has published. Everything the handoff claims is therefore checked here against BO's own records, which this
 * repository only ever READS (business_operations.bo_publication_packages and bo_handoff_records); it never writes anything operational. In one transaction it
 * either persists the intake (package, status history, version, source reference with the BO dispatch record, domain input) or records a rejection with its
 * reason, so no half-ingested package can exist. Replays are idempotent.
 */
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { ConflictError } from './errors.js';

export interface BoToBiIntakeInput {
  businessId: string;
  boPublicationPackageId: string;
  /** The id of the BO dispatch record the handoff claims to come from (bo_handoff_records.id). */
  boHandoffRecordId: string;
  intakeCode: string;
  domain: string;
  idempotencyKey: string;
  schemaVersion: string;
  /** What the handoff claims about the package; every value is verified against the BO record. */
  claimed: {
    packageCode: string;
    targetBlock: string;
    periodStart: string;
    periodEnd: string;
    recordCount: number;
    payloadReference: Record<string, unknown>;
    packageStatus: string;
  };
  correlationId: string;
  handoffId: string;
  contractVersion: string;
  createdBy?: string;
}

export type BoToBiIntakeOutcome =
  | { outcome: 'VALIDATED'; intakePackageId: string; versionNumber: number; idempotentReplay: boolean }
  | { outcome: 'REJECTED'; intakePackageId: string; reasons: readonly string[]; idempotentReplay: boolean }
  /** The BO record does not exist in this tenant, workspace and business: nothing is persisted (there is nothing to reference). */
  | { outcome: 'UNKNOWN_PACKAGE'; reasons: readonly string[] };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export class BoToBiIntakeRepository {
  async ingest(ctx: TenantContext, input: BoToBiIntakeInput): Promise<BoToBiIntakeOutcome> {
    return withTenantTransaction(ctx, async (client) => {
      // BO's own record is the authority. Read-only; row-level security and the explicit predicates both pin it to the caller's scope.
      const bo = await client.query<Record<string, unknown>>(
        `SELECT id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status
           FROM business_operations.bo_publication_packages
          WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4`,
        [input.boPublicationPackageId, input.businessId, ctx.tenantId, ctx.workspaceId]
      );
      if (bo.rowCount !== 1) return { outcome: 'UNKNOWN_PACKAGE', reasons: ['bo_publication_package_not_found_in_scope'] };
      const pkg = bo.rows[0];

      // Serialize concurrent deliveries of the same package, then decide: replay, conflict or first intake.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bi_intake:${input.businessId}:${input.boPublicationPackageId}`]);
      const existing = await client.query<Record<string, unknown>>(
        `SELECT id, status, rejection_reason, bo_publication_package_id, idempotency_key
           FROM business_intelligence.intelligence_intake_packages
          WHERE business_id = $1 AND (bo_publication_package_id = $2 OR idempotency_key = $3)`,
        [input.businessId, input.boPublicationPackageId, input.idempotencyKey]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.bo_publication_package_id !== input.boPublicationPackageId || row.idempotency_key !== input.idempotencyKey) {
          throw new ConflictError('IntelligenceIntakePackage', 'the idempotency key or the BO package is already bound to a different intake');
        }
        if (row.status === 'rejected') {
          return { outcome: 'REJECTED', intakePackageId: row.id as string, reasons: [row.rejection_reason as string], idempotentReplay: true };
        }
        const version = await client.query<{ version_number: number }>(
          `SELECT max(version_number) AS version_number FROM business_intelligence.intelligence_intake_package_versions WHERE intake_package_id = $1`, [row.id]);
        return { outcome: 'VALIDATED', intakePackageId: row.id as string, versionNumber: Number(version.rows[0].version_number), idempotentReplay: true };
      }

      // The handoff must be a real BO dispatch of THIS package (an authentic, approved publication - not a hand-written message).
      const dispatch = await client.query<{ id: string }>(
        `SELECT id FROM business_operations.bo_handoff_records
          WHERE id = $1 AND publication_id = $2 AND business_id = $3 AND tenant_id = $4 AND workspace_id = $5
            AND handoff_type = 'dispatch' AND target_layer = 'business_intelligence'`,
        [input.boHandoffRecordId, input.boPublicationPackageId, input.businessId, ctx.tenantId, ctx.workspaceId]
      );

      const reasons: string[] = [];
      if (dispatch.rowCount !== 1) reasons.push('bo_dispatch_record_not_found');
      if (pkg.target_layer !== 'business_intelligence') reasons.push('bo_package_not_addressed_to_business_intelligence');
      if (pkg.package_status !== 'ready' && pkg.package_status !== 'dispatched') reasons.push('bo_package_status_not_intakable');
      if (pkg.package_code !== input.claimed.packageCode) reasons.push('claimed_package_code_differs_from_bo');
      if (pkg.target_block !== input.claimed.targetBlock) reasons.push('claimed_target_block_differs_from_bo');
      if (new Date(pkg.period_start as string | Date).getTime() !== Date.parse(input.claimed.periodStart)) reasons.push('claimed_period_start_differs_from_bo');
      if (new Date(pkg.period_end as string | Date).getTime() !== Date.parse(input.claimed.periodEnd)) reasons.push('claimed_period_end_differs_from_bo');
      if (Number(pkg.record_count) !== input.claimed.recordCount) reasons.push('claimed_record_count_differs_from_bo');
      if (canonical(pkg.payload_reference) !== canonical(input.claimed.payloadReference)) reasons.push('claimed_payload_reference_differs_from_bo');

      const created = await client.query<{ id: string }>(
        `INSERT INTO business_intelligence.intelligence_intake_packages
           (tenant_id, workspace_id, business_id, bo_publication_package_id, intake_code, domain, status, rejection_reason, schema_version,
            idempotency_key, correlation_id, causation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'received',NULL,$7,$8,$9,$10,$11)
         RETURNING id`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.boPublicationPackageId, input.intakeCode, input.domain, input.schemaVersion,
          input.idempotencyKey, input.correlationId, input.handoffId, input.createdBy ?? ctx.userId]
      );
      const intakeId = created.rows[0].id;
      const history = async (from: string | null, to: string, reason: string | null): Promise<void> => {
        await client.query(
          `INSERT INTO business_intelligence.intelligence_processing_status_history
             (intake_package_id, tenant_id, workspace_id, business_id, from_status, to_status, reason, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [intakeId, ctx.tenantId, ctx.workspaceId, input.businessId, from, to, reason, input.correlationId]
        );
      };
      await history(null, 'received', null);
      await client.query('UPDATE business_intelligence.intelligence_intake_packages SET status = $2 WHERE id = $1', [intakeId, 'validating']);
      await history('received', 'validating', null);

      if (reasons.length > 0) {
        const reason = reasons.join(',');
        await client.query('UPDATE business_intelligence.intelligence_intake_packages SET status = $2, rejection_reason = $3 WHERE id = $1', [intakeId, 'rejected', reason]);
        await history('validating', 'rejected', reason);
        return { outcome: 'REJECTED', intakePackageId: intakeId, reasons, idempotentReplay: false };
      }

      await client.query(
        `INSERT INTO business_intelligence.intelligence_source_references
           (intake_package_id, tenant_id, workspace_id, business_id, source_system, source_reference, bo_handoff_record_id)
         VALUES ($1,$2,$3,$4,'business_operations',$5,$6)`,
        [intakeId, ctx.tenantId, ctx.workspaceId, input.businessId,
          JSON.stringify({ boPublicationPackageId: input.boPublicationPackageId, packageCode: input.claimed.packageCode, handoffId: input.handoffId,
            contractVersion: input.contractVersion, schemaVersion: input.schemaVersion }),
          input.boHandoffRecordId]
      );
      await client.query(
        `INSERT INTO business_intelligence.intelligence_intake_package_versions
           (intake_package_id, tenant_id, workspace_id, business_id, version_number, payload_reference, record_count, correlation_id)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
        [intakeId, ctx.tenantId, ctx.workspaceId, input.businessId, JSON.stringify(input.claimed.payloadReference), input.claimed.recordCount, input.correlationId]
      );
      await client.query(
        `INSERT INTO business_intelligence.intelligence_domain_inputs
           (intake_package_id, tenant_id, workspace_id, business_id, domain, input_reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [intakeId, ctx.tenantId, ctx.workspaceId, input.businessId, input.domain,
          JSON.stringify({ boPublicationPackageId: input.boPublicationPackageId, targetBlock: input.claimed.targetBlock, recordCount: input.claimed.recordCount })]
      );
      await client.query('UPDATE business_intelligence.intelligence_intake_packages SET status = $2 WHERE id = $1', [intakeId, 'validated']);
      await history('validating', 'validated', null);
      return { outcome: 'VALIDATED', intakePackageId: intakeId, versionNumber: 1, idempotentReplay: false };
    });
  }
}
