/**
 * `control_loop.action.authorized@1` (alias `ACTION_AUTHORIZED`) - the notification that Approved Business Action sealed an
 * AuthorizedActionPackage (P0-6b; owner ruling O-9).
 *
 * REFERENCE-ONLY by construction: the payload names the package (id, version, digest, scope, action type, automation level, expiry,
 * decision, issue time) and nothing else. It never carries the package body, parameters, owner, boundaries or lineage, so the event
 * ledger can never become a second authorization record: Business Operations pulls the sealed document through the ABA-owned source port
 * and validates it itself. The event is transport, not authority. Unknown payload keys are rejected, so a body cannot ride along.
 *
 * Pure: no database, no I/O (deterministic ids use Node's built-in SHA-256 only).
 */
import { createHash } from 'node:crypto';
import type { BusinessEventContract } from './registry.js';
import type { BusinessEventEnvelope } from './business-event.js';
import type { BusinessEventContractRegistry } from './registry.js';

export const ACTION_AUTHORIZED_EVENT_TYPE = 'control_loop.action.authorized';
export const ACTION_AUTHORIZED_EVENT_VERSION = '1';
/** The manifest name (architecture manifest section 9). Documentation/compatibility only: envelopes always carry the canonical type. */
export const ACTION_AUTHORIZED_ALIAS = 'ACTION_AUTHORIZED';
export const ACTION_AUTHORIZED_SOURCE_SERVICE = 'aba.package-issuer';
export const ACTION_AUTHORIZED_AGGREGATE_TYPE = 'authorized_action_package';
/** The one consumer allowed to act on the notification. */
export const ACTION_AUTHORIZED_CONSUMER = 'bo.authorized_action_intake';

export interface ActionAuthorizedPayload {
  packageId: string;
  packageVersion: number;
  digest: string;
  scope: { tenantId: string; workspaceId: string; businessId: string };
  actionType: { code: string; schemaVersion: string };
  automationLevel: number;
  /** Millisecond UTC, or null when the package carries no expiry. */
  expiresAt: string | null;
  decisionId: string;
  /** Millisecond UTC. */
  issuedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const ts = (v: unknown): v is string => typeof v === 'string' && MS_UTC.test(v) && !Number.isNaN(Date.parse(v));
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/** Strict, closed-shape validator: every field is required and no other key is accepted. */
export function isActionAuthorizedPayload(value: unknown): value is ActionAuthorizedPayload {
  if (!isObject(value) || !exactKeys(value, ['packageId', 'packageVersion', 'digest', 'scope', 'actionType', 'automationLevel', 'expiresAt', 'decisionId', 'issuedAt'])) return false;
  const { scope, actionType } = value;
  return typeof value.packageId === 'string' && UUID.test(value.packageId)
    && typeof value.packageVersion === 'number' && Number.isSafeInteger(value.packageVersion) && value.packageVersion >= 1
    && typeof value.digest === 'string' && DIGEST.test(value.digest)
    && isObject(scope) && exactKeys(scope, ['tenantId', 'workspaceId', 'businessId'])
    && [scope.tenantId, scope.workspaceId, scope.businessId].every((id) => typeof id === 'string' && UUID.test(id))
    && isObject(actionType) && exactKeys(actionType, ['code', 'schemaVersion']) && text(actionType.code) && text(actionType.schemaVersion)
    && typeof value.automationLevel === 'number' && Number.isSafeInteger(value.automationLevel) && value.automationLevel >= 1
    && (value.expiresAt === null || ts(value.expiresAt))
    && typeof value.decisionId === 'string' && UUID.test(value.decisionId)
    && ts(value.issuedAt);
}

/** `aap:{packageId}:{packageVersion}` - the ledger idempotency key (one notification per package version). */
export function actionAuthorizedIdempotencyKey(packageId: string, packageVersion: number): string {
  return `aap:${packageId}:${packageVersion}`;
}

/**
 * A deterministic event id (UUID-shaped, derived from the idempotency key) so that announcing the same package version twice is the same
 * event: the outbox primary key makes the second announcement a no-op instead of a duplicate notification.
 */
export function actionAuthorizedEventId(packageId: string, packageVersion: number): string {
  const h = createHash('sha256').update(`infinicus:${ACTION_AUTHORIZED_EVENT_TYPE}@${ACTION_AUTHORIZED_EVENT_VERSION}:${actionAuthorizedIdempotencyKey(packageId, packageVersion)}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const ACTION_AUTHORIZED_CONTRACT: BusinessEventContract<ActionAuthorizedPayload> = Object.freeze({
  eventType: ACTION_AUTHORIZED_EVENT_TYPE,
  eventVersion: ACTION_AUTHORIZED_EVENT_VERSION,
  schemaName: ACTION_AUTHORIZED_EVENT_TYPE,
  schemaVersion: ACTION_AUTHORIZED_EVENT_VERSION,
  ownerDomain: 'control_loop' as const,
  producer: ACTION_AUTHORIZED_SOURCE_SERVICE,
  supportedConsumers: Object.freeze([ACTION_AUTHORIZED_CONSUMER]),
  sensitivity: 'internal' as const,
  status: 'active' as const,
  effectiveFrom: '2026-10-12T00:00:00.000Z',
  deprecatedAt: null,
  compatibilityAliases: Object.freeze([ACTION_AUTHORIZED_ALIAS]),
  validatePayload: isActionAuthorizedPayload,
});

/** Registers the contract. Registration is explicit (never import-time) so a registry only knows what its composition root chose. */
export function registerActionAuthorizedContract(registry: BusinessEventContractRegistry): void {
  registry.register(ACTION_AUTHORIZED_CONTRACT as BusinessEventContract);
}

export interface BuildActionAuthorizedEventInput {
  payload: ActionAuthorizedPayload;
  correlationId: string;
  /** The package's causation (the approval audit event); null when unknown. */
  causationId: string | null;
  /** Millisecond UTC; the package's issue time is the occurrence. */
  recordedAt: string;
}

/** Builds the envelope for one package version. Throws on a payload that is not exactly the reference-only shape. */
export function buildActionAuthorizedEvent(input: BuildActionAuthorizedEventInput): BusinessEventEnvelope<ActionAuthorizedPayload> {
  const { payload } = input;
  if (!isActionAuthorizedPayload(payload)) throw new Error('action_authorized_payload_invalid');
  return {
    eventId: actionAuthorizedEventId(payload.packageId, payload.packageVersion),
    eventType: ACTION_AUTHORIZED_EVENT_TYPE,
    eventVersion: ACTION_AUTHORIZED_EVENT_VERSION,
    tenantId: payload.scope.tenantId,
    workspaceId: payload.scope.workspaceId,
    businessId: payload.scope.businessId,
    sourceDomain: 'control_loop',
    sourceService: ACTION_AUTHORIZED_SOURCE_SERVICE,
    aggregateType: ACTION_AUTHORIZED_AGGREGATE_TYPE,
    aggregateId: payload.packageId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: payload.issuedAt,
    recordedAt: input.recordedAt,
    actor: { actorType: 'system', actorId: ACTION_AUTHORIZED_SOURCE_SERVICE },
    idempotencyKey: actionAuthorizedIdempotencyKey(payload.packageId, payload.packageVersion),
    payload,
    metadata: { alias: ACTION_AUTHORIZED_ALIAS },
    provenance: { evidenceClass: 'ACTUAL', sourceSystem: 'aba', sourceRecordId: payload.packageId },
    schemaName: ACTION_AUTHORIZED_EVENT_TYPE,
    schemaVersion: ACTION_AUTHORIZED_EVENT_VERSION,
    sensitivity: 'internal',
  };
}
