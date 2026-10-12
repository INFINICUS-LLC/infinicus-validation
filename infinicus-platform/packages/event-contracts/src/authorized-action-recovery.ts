/**
 * `operations.authorized_action.recovery_due@1` (alias `AUTHORIZED_ACTION_RECOVERY_DUE`) - the INTERNAL durable recovery signal of a Business
 * Operations claim (P0-6g; owner ruling: stranded-claim recovery is Alternative C). Producer and sole consumer: Business Operations.
 *
 * It is written once per claim, in the same transaction that creates the claim, with `available_at = claimedAt + 60 s` (the ruled
 * claimed-without-outcome recovery threshold). When it falls due, the existing outbox worker delivers it to BO, which resolves the EXISTING claim
 * and hands it to the one execution engine. It is a nudge, not authority: it creates no claim, carries no package body, parameters or
 * authority, and a claim that already has a terminal outcome is never re-driven because of it.
 *
 * Event names are lowercase dot notation with underscores (`EVENT_NAME` in business-event.ts), so the planned hyphenated spelling
 * `operations.authorized-action.recovery-due` is `operations.authorized_action.recovery_due`.
 *
 * Pure: no database, no I/O (deterministic ids use Node's built-in SHA-256 only).
 */
import { createHash } from 'node:crypto';
import type { BusinessEventEnvelope } from './business-event.js';
import type { BusinessEventContract, BusinessEventContractRegistry } from './registry.js';

export const AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE = 'operations.authorized_action.recovery_due';
export const AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION = '1';
export const AUTHORIZED_ACTION_RECOVERY_ALIAS = 'AUTHORIZED_ACTION_RECOVERY_DUE';
export const AUTHORIZED_ACTION_RECOVERY_SOURCE_SERVICE = 'bo.authorized-action-recovery';
export const AUTHORIZED_ACTION_RECOVERY_AGGREGATE_TYPE = 'authorized_action_claim';
/** The one consumer allowed to act on the signal (also the inbox consumer name and the subscription `destination_ref`). */
export const AUTHORIZED_ACTION_RECOVERY_CONSUMER = 'bo.authorized_action_recovery';

export interface AuthorizedActionRecoveryPayload {
  /** The EXISTING BO claim this signal is about. The signal can never create one. */
  claimId: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  scope: { tenantId: string; workspaceId: string; businessId: string };
  actionType: { code: string; schemaVersion: string };
  /** BO database time the claim was taken (millisecond UTC). */
  claimedAt: string;
  /** When the signal falls due: `claimedAt` + the ruled recovery threshold (millisecond UTC). */
  dueAt: string;
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
export function isAuthorizedActionRecoveryPayload(value: unknown): value is AuthorizedActionRecoveryPayload {
  if (!isObject(value) || !exactKeys(value, ['claimId', 'packageId', 'packageVersion', 'digest', 'scope', 'actionType', 'claimedAt', 'dueAt'])) return false;
  const { scope, actionType } = value;
  return typeof value.claimId === 'string' && UUID.test(value.claimId)
    && typeof value.packageId === 'string' && UUID.test(value.packageId)
    && typeof value.packageVersion === 'number' && Number.isSafeInteger(value.packageVersion) && value.packageVersion >= 1
    && typeof value.digest === 'string' && DIGEST.test(value.digest)
    && isObject(scope) && exactKeys(scope, ['tenantId', 'workspaceId', 'businessId']) && [scope.tenantId, scope.workspaceId, scope.businessId].every((id) => typeof id === 'string' && UUID.test(id))
    && isObject(actionType) && exactKeys(actionType, ['code', 'schemaVersion']) && text(actionType.code) && text(actionType.schemaVersion)
    && ts(value.claimedAt) && ts(value.dueAt) && Date.parse(value.dueAt) >= Date.parse(value.claimedAt);
}

/** `aap-recovery:{claimId}` - the ledger idempotency key (one recovery signal per claim). */
export function authorizedActionRecoveryIdempotencyKey(claimId: string): string {
  return `aap-recovery:${claimId}`;
}

/** Deterministic, UUID-shaped event id derived from the claim id: scheduling the same claim's recovery twice is the same event. */
export function authorizedActionRecoveryEventId(claimId: string): string {
  const h = createHash('sha256').update(`infinicus:${AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE}@${AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION}:${authorizedActionRecoveryIdempotencyKey(claimId)}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const AUTHORIZED_ACTION_RECOVERY_CONTRACT: BusinessEventContract<AuthorizedActionRecoveryPayload> = Object.freeze({
  eventType: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE,
  eventVersion: AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION,
  schemaName: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE,
  schemaVersion: AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION,
  ownerDomain: 'operations' as const,
  producer: AUTHORIZED_ACTION_RECOVERY_SOURCE_SERVICE,
  supportedConsumers: Object.freeze([AUTHORIZED_ACTION_RECOVERY_CONSUMER]),
  sensitivity: 'internal' as const,
  status: 'active' as const,
  effectiveFrom: '2026-10-12T00:00:00.000Z',
  deprecatedAt: null,
  compatibilityAliases: Object.freeze([AUTHORIZED_ACTION_RECOVERY_ALIAS]),
  validatePayload: isAuthorizedActionRecoveryPayload,
});

/** Registers the contract. Explicit (never import-time) so a registry only knows what its composition root chose. */
export function registerAuthorizedActionRecoveryContract(registry: BusinessEventContractRegistry): void {
  registry.register(AUTHORIZED_ACTION_RECOVERY_CONTRACT as BusinessEventContract);
}

export interface BuildAuthorizedActionRecoveryEventInput {
  payload: AuthorizedActionRecoveryPayload;
  /** The claim's correlation id (inherited from the package trace). */
  correlationId: string;
}

/** Builds the envelope for one claim. Throws on a payload that is not exactly the reference shape. */
export function buildAuthorizedActionRecoveryEvent(input: BuildAuthorizedActionRecoveryEventInput): BusinessEventEnvelope<AuthorizedActionRecoveryPayload> {
  const { payload } = input;
  if (!isAuthorizedActionRecoveryPayload(payload)) throw new Error('authorized_action_recovery_payload_invalid');
  return {
    eventId: authorizedActionRecoveryEventId(payload.claimId),
    eventType: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE,
    eventVersion: AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION,
    tenantId: payload.scope.tenantId,
    workspaceId: payload.scope.workspaceId,
    businessId: payload.scope.businessId,
    sourceDomain: 'operations',
    sourceService: AUTHORIZED_ACTION_RECOVERY_SOURCE_SERVICE,
    aggregateType: AUTHORIZED_ACTION_RECOVERY_AGGREGATE_TYPE,
    aggregateId: payload.claimId,
    correlationId: input.correlationId,
    causationId: payload.claimId,
    occurredAt: payload.claimedAt,
    recordedAt: payload.claimedAt,
    actor: { actorType: 'system', actorId: AUTHORIZED_ACTION_RECOVERY_SOURCE_SERVICE },
    idempotencyKey: authorizedActionRecoveryIdempotencyKey(payload.claimId),
    payload,
    metadata: { alias: AUTHORIZED_ACTION_RECOVERY_ALIAS },
    provenance: { evidenceClass: 'ACTUAL', sourceSystem: 'bo', sourceRecordId: payload.claimId },
    schemaName: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE,
    schemaVersion: AUTHORIZED_ACTION_RECOVERY_EVENT_VERSION,
    sensitivity: 'internal',
  };
}
