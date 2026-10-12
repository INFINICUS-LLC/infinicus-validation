import { describe, expect, it } from 'vitest';
import {
  ACTION_EXECUTED_ALIAS, ACTION_EXECUTED_CONTRACT, ACTION_EXECUTED_EVENT_TYPE, BusinessEventContractRegistry, actionExecutedEventId, actionExecutedIdempotencyKey,
  buildActionExecutedEvent, isActionExecutedPayload, registerActionExecutedContract, validateBusinessEventEnvelope,
} from '../index.js';
import type { ActionExecutedPayload } from '../index.js';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (over: Record<string, unknown> = {}): ActionExecutedPayload => ({
  executionId: U(1), contractVersion: 'execution-evidence/1', evidenceDigest: `sha256:${'a'.repeat(64)}`,
  scope: { tenantId: U(2), workspaceId: U(3), businessId: U(4) }, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: U(5) }, packageId: U(6), packageVersion: 1, claimId: U(7), outcome: 'SUCCEEDED', mutationResult: 'APPLIED',
  recordedAt: '2026-10-12T10:00:00.000Z', ...over,
}) as ActionExecutedPayload;
const built = (p = payload()) => buildActionExecutedEvent({ payload: p, correlationId: U(9), causationId: U(7), recordedAt: '2026-10-12T10:00:01.000Z' });

describe('operations.action.executed@1', () => {
  it('names the canonical type, version, owner domain and manifest alias', () => {
    expect(ACTION_EXECUTED_EVENT_TYPE).toBe('operations.action.executed');
    expect(ACTION_EXECUTED_ALIAS).toBe('ACTION_EXECUTED');
    expect(ACTION_EXECUTED_CONTRACT).toMatchObject({ eventVersion: '1', ownerDomain: 'operations', producer: 'bo.authorized-action-execution', supportedConsumers: ['om.execution_verification'], compatibilityAliases: ['ACTION_EXECUTED'] });
  });

  it('accepts the exact reference-only payload for every terminal outcome', () => {
    expect(isActionExecutedPayload(payload())).toBe(true);
    expect(isActionExecutedPayload(payload({ outcome: 'REFUSED', mutationResult: 'NOT_APPLICABLE' }))).toBe(true);
    expect(isActionExecutedPayload(payload({ outcome: 'FAILED', mutationResult: 'NOT_APPLICABLE' }))).toBe(true);
    expect(isActionExecutedPayload(payload({ mutationResult: 'NO_CHANGE' }))).toBe(true);
  });

  it('is closed: the evidence document, state, parameters or any effectiveness claim cannot ride along', () => {
    for (const extra of ['evidence', 'document', 'before', 'after', 'parameters', 'effectiveness', 'improved', 'outcomeState', 'learningEligible']) {
      expect(isActionExecutedPayload({ ...payload(), [extra]: { x: 1 } }), extra).toBe(false);
    }
    expect(isActionExecutedPayload({ ...payload(), scope: { ...payload().scope, extra: 1 } })).toBe(false);
    expect(isActionExecutedPayload({ ...payload(), target: { kind: 'inventory_item', id: 'x', extra: 1 } })).toBe(false);
  });

  it('refuses every missing or malformed field, including the legacy NOT_APPLIED vocabulary', () => {
    const bad: Record<string, unknown>[] = [
      { executionId: 'x' }, { contractVersion: '' }, { evidenceDigest: 'sha256:abc' }, { scope: undefined }, { scope: { tenantId: U(2), workspaceId: U(3) } },
      { actionType: { code: 'a' } }, { target: null }, { packageId: 'x' }, { packageVersion: 0 }, { claimId: 'x' }, { outcome: 'EXECUTED' }, { outcome: 'succeeded' },
      { mutationResult: 'NOT_APPLIED' }, { mutationResult: 'DONE' }, { recordedAt: '2026-10-12T10:00:00Z' }, { recordedAt: undefined },
    ];
    for (const over of bad) expect(isActionExecutedPayload(payload(over)), JSON.stringify(over)).toBe(false);
    for (const v of [null, undefined, 'x', 1, []]) expect(isActionExecutedPayload(v)).toBe(false);
  });

  it('builds a valid, registry-accepted, scope-bound envelope that references the execution and inherits its lineage', () => {
    const registry = new BusinessEventContractRegistry();
    registerActionExecutedContract(registry);
    const e = built();
    expect(validateBusinessEventEnvelope(e)).toEqual({ valid: true, reasons: [] });
    expect(registry.validate(e)).toEqual({ valid: true, reasons: [], canonicalEventType: ACTION_EXECUTED_EVENT_TYPE });
    expect(e).toMatchObject({
      eventType: 'operations.action.executed', eventVersion: '1', tenantId: U(2), workspaceId: U(3), businessId: U(4), sourceDomain: 'operations',
      aggregateType: 'authorized_action_execution', aggregateId: U(1), correlationId: U(9), causationId: U(7), idempotencyKey: `aap-exec:${U(1)}`,
      provenance: { evidenceClass: 'ACTUAL' }, sensitivity: 'internal', occurredAt: '2026-10-12T10:00:00.000Z',
    });
  });

  it('registration is explicit; a malformed payload is rejected by the registry; double registration throws', () => {
    const registry = new BusinessEventContractRegistry();
    expect(registry.validate(built()).reasons).toEqual(['event_contract_not_registered']);
    registerActionExecutedContract(registry);
    expect(registry.validate({ ...built(), payload: { ...payload(), effectiveness: 'IMPROVED' } }).reasons).toEqual(['event_payload_invalid']);
    expect(() => registerActionExecutedContract(registry)).toThrow('duplicate_event_contract');
  });

  it('refuses to build from a payload that is not exactly the reference shape', () => {
    expect(() => built({ ...payload(), evidence: {} } as never)).toThrow('action_executed_payload_invalid');
    expect(() => built(payload({ outcome: 'EXECUTED' }))).toThrow('action_executed_payload_invalid');
  });

  it('idempotency: one deterministic, UUID-shaped event id per execution', () => {
    expect(actionExecutedIdempotencyKey(U(1))).toBe(`aap-exec:${U(1)}`);
    const a = actionExecutedEventId(U(1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(actionExecutedEventId(U(1))).toBe(a);
    expect(actionExecutedEventId(U(2))).not.toBe(a);
    expect(built().eventId).toBe(a);
  });
});
