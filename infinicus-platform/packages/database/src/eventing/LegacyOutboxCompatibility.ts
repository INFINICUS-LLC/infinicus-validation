import type {
  BusinessDomain,
  BusinessEventEnvelope,
  BusinessEventSensitivity,
  EvidenceClass,
} from '@infinicus/event-contracts';

export interface LegacyOutboxRecord {
  id: string;
  event_type: string;
  event_version: string;
  tenant_id: string;
  workspace_id: string | null;
  business_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: unknown;
  headers: Record<string, unknown>;
  occurred_at: Date | string;
}

export interface LegacyOutboxCompatibilityProfile {
  legacyEventType: string;
  canonicalEventType: string;
  sourceDomain: BusinessDomain;
  sourceService: string;
  schemaName: string;
  schemaVersion: string;
  evidenceClass: EvidenceClass;
  sensitivity: BusinessEventSensitivity;
  transformPayload?: (payload: unknown) => unknown;
}

export class LegacyOutboxCompatibilityRegistry {
  private readonly profiles = new Map<string, LegacyOutboxCompatibilityProfile>();

  register(profile: LegacyOutboxCompatibilityProfile): void {
    if (this.profiles.has(profile.legacyEventType)) {
      throw new Error(`duplicate_legacy_event_profile:${profile.legacyEventType}`);
    }
    this.profiles.set(profile.legacyEventType, Object.freeze({ ...profile }));
  }

  get(eventType: string): LegacyOutboxCompatibilityProfile | undefined {
    return this.profiles.get(eventType);
  }
}

type CanonicalHeader = {
  sourceDomain?: BusinessDomain;
  sourceService?: string;
  metadata?: Record<string, unknown>;
  provenance?: BusinessEventEnvelope['provenance'];
  schemaName?: string;
  schemaVersion?: string;
  sensitivity?: BusinessEventSensitivity;
  actor?: BusinessEventEnvelope['actor'];
  idempotencyKey?: string | null;
};

function canonicalHeader(row: LegacyOutboxRecord): CanonicalHeader | null {
  const raw = row.headers?.businessEvent;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as CanonicalHeader;
}

export function outboxRecordToCanonicalEvent(
  row: LegacyOutboxRecord,
  profiles: LegacyOutboxCompatibilityRegistry,
): BusinessEventEnvelope {
  if (!row.workspace_id) throw new Error('canonical_event_workspace_required');

  const direct = canonicalHeader(row);
  if (direct) {
    if (!direct.sourceDomain || !direct.sourceService || !direct.provenance
      || !direct.schemaName || !direct.schemaVersion || !direct.sensitivity) {
      throw new Error('canonical_event_headers_incomplete');
    }
    return {
      eventId: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      businessId: row.business_id,
      sourceDomain: direct.sourceDomain,
      sourceService: direct.sourceService,
      aggregateType: row.aggregate_type ?? 'unknown',
      aggregateId: row.aggregate_id ?? row.id,
      correlationId: row.correlation_id ?? row.id,
      causationId: row.causation_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      recordedAt: new Date().toISOString(),
      actor: direct.actor ?? null,
      idempotencyKey: direct.idempotencyKey ?? row.id,
      payload: row.payload,
      metadata: direct.metadata ?? {},
      provenance: direct.provenance,
      schemaName: direct.schemaName,
      schemaVersion: direct.schemaVersion,
      sensitivity: direct.sensitivity,
    };
  }

  const profile = profiles.get(row.event_type);
  if (!profile) throw new Error(`legacy_event_profile_required:${row.event_type}`);

  return {
    eventId: row.id,
    eventType: profile.canonicalEventType,
    eventVersion: row.event_version,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    businessId: row.business_id,
    sourceDomain: profile.sourceDomain,
    sourceService: profile.sourceService,
    aggregateType: row.aggregate_type ?? 'legacy_event',
    aggregateId: row.aggregate_id ?? row.id,
    correlationId: row.correlation_id ?? row.id,
    causationId: row.causation_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date().toISOString(),
    actor: null,
    idempotencyKey: row.id,
    payload: profile.transformPayload ? profile.transformPayload(row.payload) : row.payload,
    metadata: { legacyEventType: row.event_type },
    provenance: {
      evidenceClass: profile.evidenceClass,
      sourceSystem: profile.sourceService,
      sourceRecordId: row.id,
    },
    schemaName: profile.schemaName,
    schemaVersion: profile.schemaVersion,
    sensitivity: profile.sensitivity,
  };
}
