export type BusinessDomain =
  | 'experience'
  | 'business_administration'
  | 'commerce'
  | 'operations'
  | 'finance'
  | 'data'
  | 'intelligence'
  | 'control_loop';

export type BusinessEventSensitivity =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'highly_restricted';

export type BusinessEventActorType = 'user' | 'service' | 'system' | 'external';

export type EvidenceClass =
  | 'ACTUAL'
  | 'ASSUMPTION_BASED'
  | 'BENCHMARK_BASED'
  | 'ESTIMATED'
  | 'FORECAST'
  | 'SIMULATION';

export interface BusinessEventActor {
  actorType: BusinessEventActorType;
  actorId: string | null;
}

export interface BusinessEventProvenance {
  evidenceClass: EvidenceClass;
  sourceSystem?: string;
  sourceRecordId?: string | null;
  sourceReference?: string | null;
  publicationPackageId?: string | null;
}

export interface BusinessEventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: string;
  eventVersion: string;
  tenantId: string;
  workspaceId: string;
  businessId: string | null;
  sourceDomain: BusinessDomain;
  sourceService: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  recordedAt: string;
  actor: BusinessEventActor | null;
  idempotencyKey: string | null;
  payload: TPayload;
  metadata: Record<string, unknown>;
  provenance: BusinessEventProvenance;
  schemaName: string;
  schemaVersion: string;
  sensitivity: BusinessEventSensitivity;
}

export interface BusinessEventValidationResult {
  valid: boolean;
  reasons: readonly string[];
}

const DOMAINS = new Set<BusinessDomain>([
  'experience',
  'business_administration',
  'commerce',
  'operations',
  'finance',
  'data',
  'intelligence',
  'control_loop',
]);

const SENSITIVITY = new Set<BusinessEventSensitivity>([
  'public',
  'internal',
  'confidential',
  'restricted',
  'highly_restricted',
]);

const EVIDENCE_CLASSES = new Set<EvidenceClass>([
  'ACTUAL',
  'ASSUMPTION_BASED',
  'BENCHMARK_BASED',
  'ESTIMATED',
  'FORECAST',
  'SIMULATION',
]);

const EVENT_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const CREDENTIAL_KEY = /(^|[_-])(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?secret)($|[_-])/i;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDate(value: unknown): value is string {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function findSensitiveKey(value: unknown, path = 'payload'): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = `${path}.${key}`;
    if (CREDENTIAL_KEY.test(key)) return next;
    const nested = findSensitiveKey(child, next);
    if (nested) return nested;
  }
  return null;
}

export function validateBusinessEventEnvelope(value: unknown): BusinessEventValidationResult {
  const reasons: string[] = [];
  if (!value || typeof value !== 'object') return { valid: false, reasons: ['event_required'] };

  const e = value as Partial<BusinessEventEnvelope>;
  for (const field of [
    'eventId','eventType','eventVersion','tenantId','workspaceId','sourceService',
    'aggregateType','aggregateId','correlationId','schemaName','schemaVersion'
  ] as const) {
    if (!nonEmpty(e[field])) reasons.push(`${field}_required`);
  }

  if (nonEmpty(e.eventType) && !EVENT_NAME.test(e.eventType)) reasons.push('event_type_invalid');
  if (!DOMAINS.has(e.sourceDomain as BusinessDomain)) reasons.push('source_domain_invalid');
  if (!SENSITIVITY.has(e.sensitivity as BusinessEventSensitivity)) reasons.push('sensitivity_invalid');
  if (!validDate(e.occurredAt)) reasons.push('occurred_at_invalid');
  if (!validDate(e.recordedAt)) reasons.push('recorded_at_invalid');
  if (e.businessId !== null && !nonEmpty(e.businessId)) reasons.push('business_id_invalid');
  if (e.causationId !== null && !nonEmpty(e.causationId)) reasons.push('causation_id_invalid');
  if (e.idempotencyKey !== null && !nonEmpty(e.idempotencyKey)) reasons.push('idempotency_key_invalid');
  if (!e.metadata || typeof e.metadata !== 'object' || Array.isArray(e.metadata)) reasons.push('metadata_object_required');
  if (!e.provenance || typeof e.provenance !== 'object' || Array.isArray(e.provenance)) {
    reasons.push('provenance_required');
  } else if (!EVIDENCE_CLASSES.has(e.provenance.evidenceClass as EvidenceClass)) {
    reasons.push('evidence_class_invalid');
  }
  if (e.actor !== null) {
    if (!e.actor || typeof e.actor !== 'object') reasons.push('actor_invalid');
    else if (!['user','service','system','external'].includes(e.actor.actorType)) reasons.push('actor_type_invalid');
  }

  const sensitive = findSensitiveKey(e.payload);
  if (sensitive) reasons.push(`credential_like_key_at_${sensitive}`);

  return { valid: reasons.length === 0, reasons };
}
