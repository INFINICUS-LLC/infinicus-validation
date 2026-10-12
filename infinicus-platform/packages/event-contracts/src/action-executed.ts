/**
 * `operations.action.executed@1` (alias `ACTION_EXECUTED`) - Business Operations announces that an authorized-action claim reached a
 * TERMINAL execution outcome (P0-6d; owner ruling O-9). Producer: BO. Transport contract: this package. Consumer: Outcome Monitoring.
 *
 * REFERENCE-ONLY: the payload points at the canonical `execution-evidence/1` record (execution id + evidence digest) and carries just
 * enough identity (scope, action type, target, package, claim) and the execution FACT (outcome, mutation result) for routing and for OM to
 * cross-check the evidence it then reads from the BO-owned reader port. It never carries the evidence document, operational state, parameters
 * or any claim about the business effect of the action. The event is transport, not truth: BO's execution row is the truth.
 *
 * Emitted for EVERY terminal outcome (SUCCEEDED, REFUSED, FAILED), in the SAME transaction as the execution row, so an execution cannot
 * commit without its event or the reverse. Deterministic event id per execution => announcing twice is a no-op.
 *
 * Pure: no database, no I/O (deterministic ids use Node's built-in SHA-256 only).
 */
import { createHash } from 'node:crypto';
import type { BusinessEventEnvelope } from './business-event.js';
import type { BusinessEventContract, BusinessEventContractRegistry } from './registry.js';

export const ACTION_EXECUTED_EVENT_TYPE = 'operations.action.executed';
export const ACTION_EXECUTED_EVENT_VERSION = '1';
/** The manifest name (architecture manifest section 9). Compatibility/documentation only: envelopes always carry the canonical type. */
export const ACTION_EXECUTED_ALIAS = 'ACTION_EXECUTED';
export const ACTION_EXECUTED_SOURCE_SERVICE = 'bo.authorized-action-execution';
export const ACTION_EXECUTED_AGGREGATE_TYPE = 'authorized_action_execution';
/** The one consumer allowed to act on the notification. */
export const ACTION_EXECUTED_CONSUMER = 'om.execution_verification';
/** The shared evidence contract the payload points at. */
export const ACTION_EXECUTED_EVIDENCE_CONTRACT = 'execution-evidence/1';

export const ACTION_EXECUTED_OUTCOMES = ['SUCCEEDED', 'REFUSED', 'FAILED'] as const;
export const ACTION_EXECUTED_MUTATION_RESULTS = ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE'] as const;

export interface ActionExecutedPayload {
  executionId: string;
  /** The `execution-evidence/N` contract the referenced evidence is sealed under. */
  contractVersion: string;
  /** Digest of the sealed evidence document: OM rejects any evidence that does not match it. */
  evidenceDigest: string;
  scope: { tenantId: string; workspaceId: string; businessId: string };
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  packageId: string;
  packageVersion: number;
  claimId: string;
  /** The execution FACT (never an effectiveness claim). */
  outcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
  mutationResult: 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLICABLE';
  /** Business Operations database time the execution was recorded (millisecond UTC). */
  recordedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/** Strict, closed-shape validator: every field is required, no other key is accepted. */
export function isActionExecutedPayload(value: unknown): value is ActionExecutedPayload {
  if (!isObject(value) || !exactKeys(value, ['executionId', 'contractVersion', 'evidenceDigest', 'scope', 'actionType', 'target', 'packageId', 'packageVersion', 'claimId', 'outcome', 'mutationResult', 'recordedAt'])) return false;
  const { scope, actionType, target } = value;
  return typeof value.executionId === 'string' && UUID.test(value.executionId)
    && text(value.contractVersion)
    && typeof value.evidenceDigest === 'string' && DIGEST.test(value.evidenceDigest)
    && isObject(scope) && exactKeys(scope, ['tenantId', 'workspaceId', 'businessId']) && [scope.tenantId, scope.workspaceId, scope.businessId].every((id) => typeof id === 'string' && UUID.test(id))
    && isObject(actionType) && exactKeys(actionType, ['code', 'schemaVersion']) && text(actionType.code) && text(actionType.schemaVersion)
    && isObject(target) && exactKeys(target, ['kind', 'id']) && text(target.kind) && text(target.id)
    && typeof value.packageId === 'string' && UUID.test(value.packageId)
    && typeof value.packageVersion === 'number' && Number.isSafeInteger(value.packageVersion) && value.packageVersion >= 1
    && typeof value.claimId === 'string' && UUID.test(value.claimId)
    && (ACTION_EXECUTED_OUTCOMES as readonly unknown[]).includes(value.outcome)
    && (ACTION_EXECUTED_MUTATION_RESULTS as readonly unknown[]).includes(value.mutationResult)
    && typeof value.recordedAt === 'string' && MS_UTC.test(value.recordedAt) && !Number.isNaN(Date.parse(value.recordedAt));
}

/** `aap-exec:{executionId}` - the ledger idempotency key (one notification per execution). */
export function actionExecutedIdempotencyKey(executionId: string): string {
  return `aap-exec:${executionId}`;
}

/** Deterministic, UUID-shaped event id derived from the execution id: announcing the same execution twice is the same event. */
export function actionExecutedEventId(executionId: string): string {
  const h = createHash('sha256').update(`infinicus:${ACTION_EXECUTED_EVENT_TYPE}@${ACTION_EXECUTED_EVENT_VERSION}:${actionExecutedIdempotencyKey(executionId)}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const ACTION_EXECUTED_CONTRACT: BusinessEventContract<ActionExecutedPayload> = Object.freeze({
  eventType: ACTION_EXECUTED_EVENT_TYPE,
  eventVersion: ACTION_EXECUTED_EVENT_VERSION,
  schemaName: ACTION_EXECUTED_EVENT_TYPE,
  schemaVersion: ACTION_EXECUTED_EVENT_VERSION,
  ownerDomain: 'operations' as const,
  producer: ACTION_EXECUTED_SOURCE_SERVICE,
  supportedConsumers: Object.freeze([ACTION_EXECUTED_CONSUMER]),
  sensitivity: 'internal' as const,
  status: 'active' as const,
  effectiveFrom: '2026-10-12T00:00:00.000Z',
  deprecatedAt: null,
  compatibilityAliases: Object.freeze([ACTION_EXECUTED_ALIAS]),
  validatePayload: isActionExecutedPayload,
});

/** Registers the contract. Explicit (never import-time) so a registry only knows what its composition root chose. */
export function registerActionExecutedContract(registry: BusinessEventContractRegistry): void {
  registry.register(ACTION_EXECUTED_CONTRACT as BusinessEventContract);
}

export interface BuildActionExecutedEventInput {
  payload: ActionExecutedPayload;
  /** The execution's correlation id (inherited from the package trace through the claim). */
  correlationId: string;
  /** What caused the execution: its claim. */
  causationId: string;
  /** Millisecond UTC. */
  recordedAt: string;
}

/** Builds the envelope for one execution. Throws on a payload that is not exactly the reference shape. */
export function buildActionExecutedEvent(input: BuildActionExecutedEventInput): BusinessEventEnvelope<ActionExecutedPayload> {
  const { payload } = input;
  if (!isActionExecutedPayload(payload)) throw new Error('action_executed_payload_invalid');
  return {
    eventId: actionExecutedEventId(payload.executionId),
    eventType: ACTION_EXECUTED_EVENT_TYPE,
    eventVersion: ACTION_EXECUTED_EVENT_VERSION,
    tenantId: payload.scope.tenantId,
    workspaceId: payload.scope.workspaceId,
    businessId: payload.scope.businessId,
    sourceDomain: 'operations',
    sourceService: ACTION_EXECUTED_SOURCE_SERVICE,
    aggregateType: ACTION_EXECUTED_AGGREGATE_TYPE,
    aggregateId: payload.executionId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: payload.recordedAt,
    recordedAt: input.recordedAt,
    actor: { actorType: 'system', actorId: ACTION_EXECUTED_SOURCE_SERVICE },
    idempotencyKey: actionExecutedIdempotencyKey(payload.executionId),
    payload,
    metadata: { alias: ACTION_EXECUTED_ALIAS },
    provenance: { evidenceClass: 'ACTUAL', sourceSystem: 'bo', sourceRecordId: payload.executionId },
    schemaName: ACTION_EXECUTED_EVENT_TYPE,
    schemaVersion: ACTION_EXECUTED_EVENT_VERSION,
    sensitivity: 'internal',
  };
}
