import { BusinessRepository, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { AuthorizationService } from '@infinicus/authorization';

export interface OfflineReviewEvidence {
  eventId: string;
  resolutionId: string;
  version: number;
  previousEventId: string | null;
  previousEventDigest: string | null;
  supersedesEventId: string | null;
  eventType: 'EVIDENCE_NOTE_RECORDED' | 'EVIDENCE_NOTE_SUPERSEDED';
  reasonCode: string;
  sourceReference: string;
  /** Claimed provenance only; this disabled relation does not authenticate the actor. */
  actorId: string | null;
  /** Claimed provenance only; no service writer is approved. */
  serviceReference: string | null;
  requestDigest: string;
  digestVersion: 'V1_SESSION_TZ' | 'V2_UTC';
  recordedAt: Date;
  eventDigest: string;
}

export interface OfflineReviewEvidenceView {
  intakeId: string;
  clientSaleId: string;
  originalRequestDigest: string;
  originalProvisionalTotalMinor: string;
  /** Evidence presence does not authorize consent, a quote, settlement or completion. */
  authority: 'NONAUTHORITATIVE_UNRESOLVED';
  events: OfflineReviewEvidence[];
}

/** Internal read boundary: canonical current bo:read and workspace visibility precede each query. No public route. */
export class OfflineReviewEvidenceReader {
  private readonly authorization = new AuthorizationService();
  private readonly businesses = new BusinessRepository();

  async get(ctx: TenantContext, businessId: string, intakeId: string): Promise<OfflineReviewEvidenceView | null> {
    await this.authorization.authorize(ctx, 'bo:read');
    await this.businesses.getForWorkspace(ctx, businessId);
    return withTenantTransaction(ctx, async (client) => {
      const intake = await client.query<Record<string, unknown>>(
        `SELECT id, client_sale_id, request_digest, device_total_minor::text AS device_total_minor
           FROM business_operations.offline_sales
          WHERE id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4 AND outcome = 'needs_review'`,
        [intakeId, businessId, ctx.tenantId, ctx.workspaceId],
      );
      if (!intake.rows[0]) return null;
      const events = await client.query<Record<string, unknown>>(
        `SELECT event_id, resolution_id, event_version, previous_event_id,
                previous_event_digest, supersedes_event_id, event_type,
                reason_code, source_reference, actor_id, service_reference,
                request_digest, digest_version, recorded_at, event_digest
           FROM business_operations.offline_review_evidence
          WHERE offline_sale_id = $1 AND business_id = $2 AND tenant_id = $3 AND workspace_id = $4
          ORDER BY resolution_id, event_version, event_id`,
        [intakeId, businessId, ctx.tenantId, ctx.workspaceId],
      );
      const row = intake.rows[0];
      return {
        intakeId: String(row.id),
        clientSaleId: String(row.client_sale_id),
        originalRequestDigest: String(row.request_digest),
        originalProvisionalTotalMinor: String(row.device_total_minor),
        authority: 'NONAUTHORITATIVE_UNRESOLVED',
        events: events.rows.map((event) => ({
          eventId: String(event.event_id), resolutionId: String(event.resolution_id),
          version: Number(event.event_version),
          previousEventId: event.previous_event_id === null ? null : String(event.previous_event_id),
          previousEventDigest: event.previous_event_digest === null ? null : String(event.previous_event_digest),
          supersedesEventId: event.supersedes_event_id === null ? null : String(event.supersedes_event_id),
          eventType: event.event_type as OfflineReviewEvidence['eventType'],
          reasonCode: String(event.reason_code), sourceReference: String(event.source_reference),
          actorId: event.actor_id === null ? null : String(event.actor_id),
          serviceReference: event.service_reference === null ? null : String(event.service_reference),
          requestDigest: String(event.request_digest),
          digestVersion: event.digest_version as OfflineReviewEvidence['digestVersion'],
          recordedAt: event.recorded_at as Date, eventDigest: String(event.event_digest),
        })),
      };
    });
  }
}
