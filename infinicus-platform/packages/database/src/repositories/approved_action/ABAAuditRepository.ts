import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

export interface ApprovalAttestation {
  id: string;
  decisionVersionId: string;
  attestationCode: string;
  statement: string;
  attestedBy: string | null;
}

export interface ApprovalSignature {
  id: string;
  attestationId: string;
  signatureReference: string;
}

function rowToAttestation(row: Record<string, unknown>): ApprovalAttestation {
  return {
    id: row.id as string,
    decisionVersionId: row.decision_version_id as string,
    attestationCode: row.attestation_code as string,
    statement: row.statement as string,
    attestedBy: row.attested_by as string | null,
  };
}

function rowToSignature(row: Record<string, unknown>): ApprovalSignature {
  return {
    id: row.id as string,
    attestationId: row.attestation_id as string,
    signatureReference: row.signature_reference as string,
  };
}

/** Event type recorded when an elapsed valid_until is detected (P0-4 Block 2). */
export const APPROVAL_EXPIRED_EVENT = 'approval.expired';

export interface ExpiryDetectionContext {
  /** Where the expiry was observed. */
  path: 'approval_attempt' | 'status_read';
  /** The authenticated principal whose request detected the expiry, when detection happens in a user request. */
  actorUserId: string | null;
  correlationId: string | null;
}

export interface ExpiryDetectionResult {
  /** valid_until is present and <= database now() for the review version. */
  expired: boolean;
  /** A new audit event was written by THIS call (false when already recorded, or not expired). */
  recorded: boolean;
}

export class ABAAuditRepository {
  async recordAttestation(ctx: TenantContext, businessId: string, decisionVersionId: string, attestationCode: string, statement: string, attestedBy?: string): Promise<ApprovalAttestation> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approval_attestations (tenant_id, workspace_id, business_id, decision_version_id, attestation_code, statement, attested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, decisionVersionId, attestationCode, statement, attestedBy ?? null]
      );
      return rowToAttestation(result.rows[0]);
    });
  }

  /** Records a reference to a signature artifact — never raw signature bytes. */
  async recordSignature(ctx: TenantContext, businessId: string, attestationId: string, signatureReference: string): Promise<ApprovalSignature> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.approval_signatures (tenant_id, workspace_id, business_id, attestation_id, signature_reference)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, attestationId, signatureReference]
      );
      return rowToSignature(result.rows[0]);
    });
  }

  async recordAuditEvent(ctx: TenantContext, businessId: string, eventType: string, detail: Record<string, unknown> = {}, decisionId?: string): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.approval_audit_events (tenant_id, workspace_id, business_id, decision_id, event_type, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.tenantId, ctx.workspaceId, businessId, decisionId ?? null, eventType, JSON.stringify(detail)]
      );
    });
  }

  /**
   * Records `approval.expired` for a review version whose persisted valid_until has elapsed, at most once per
   * review version (P0-4 Block 2). Expiry is a DERIVED state: nothing here changes the review, its package status or
   * any decision. Every fact in the event is read from the persisted version and the database clock inside this
   * transaction — the caller supplies only the version id and request context, so valid_until and detected_at cannot
   * be fabricated. Idempotent: a transaction-scoped advisory lock keyed on the version serialises concurrent detectors,
   * and an existing event for that version short-circuits (no scheduler, no unique-index migration required).
   */
  async recordExpiryDetected(ctx: TenantContext, businessId: string, reviewVersionId: string, detection: ExpiryDetectionContext): Promise<ExpiryDetectionResult> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${APPROVAL_EXPIRED_EVENT}:${reviewVersionId}`]);
      const found = await client.query<Record<string, unknown>>(
        `SELECT v.id, v.review_package_id, v.version_number, v.source_recommendation_version_id, v.valid_until,
                p.status AS package_status, now() AS db_now
           FROM approved_business_action.action_review_package_versions v
           JOIN approved_business_action.action_review_packages p ON p.id = v.review_package_id
          WHERE v.id = $1 AND p.business_id = $2`,
        [reviewVersionId, businessId]
      );
      if (found.rows.length === 0) return { expired: false, recorded: false };
      const row = found.rows[0];
      const validUntil = row.valid_until as Date | null;
      const now = row.db_now as Date;
      if (validUntil === null || validUntil.getTime() > now.getTime()) return { expired: false, recorded: false };

      const existing = await client.query(
        `SELECT 1 FROM approved_business_action.approval_audit_events
          WHERE business_id = $1 AND event_type = $2 AND detail->>'reviewVersionId' = $3 LIMIT 1`,
        [businessId, APPROVAL_EXPIRED_EVENT, reviewVersionId]
      );
      if (existing.rows.length > 0) return { expired: true, recorded: false };

      const detail = {
        schema: 'approval-audit/1',
        eventType: APPROVAL_EXPIRED_EVENT,
        sourceLayer: 'ABA',
        reasonCode: 'valid_until_elapsed',
        businessId,
        reviewPackageId: row.review_package_id as string,
        reviewVersionId,
        reviewVersionNumber: row.version_number as number,
        sourceRecommendationVersionId: (row.source_recommendation_version_id as string | null) ?? null,
        validUntil: validUntil.toISOString(),
        detectedAt: now.toISOString(),
        reviewStatus: row.package_status as string,
        detectionPath: detection.path,
        actorUserId: detection.actorUserId,
        correlationId: detection.correlationId,
      };
      await client.query(
        `INSERT INTO approved_business_action.approval_audit_events (tenant_id, workspace_id, business_id, decision_id, event_type, detail)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [ctx.tenantId, ctx.workspaceId, businessId, APPROVAL_EXPIRED_EVENT, JSON.stringify(detail)]
      );
      return { expired: true, recorded: true };
    });
  }

  async listAttestationsForDecisionVersion(ctx: TenantContext, decisionVersionId: string): Promise<ApprovalAttestation[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM approved_business_action.approval_attestations WHERE decision_version_id = $1 ORDER BY created_at',
        [decisionVersionId]
      );
      return result.rows.map(rowToAttestation);
    });
  }
}
