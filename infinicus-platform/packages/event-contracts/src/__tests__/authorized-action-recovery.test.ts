import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_ACTION_RECOVERY_ALIAS, AUTHORIZED_ACTION_RECOVERY_CONTRACT, AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE, BusinessEventContractRegistry,
  authorizedActionRecoveryEventId, authorizedActionRecoveryIdempotencyKey, buildAuthorizedActionRecoveryEvent, executionPipelineSubscriptions,
  isAuthorizedActionRecoveryPayload, registerAuthorizedActionRecoveryContract, validateBusinessEventEnvelope,
} from '../index.js';
import type { AuthorizedActionRecoveryPayload } from '../index.js';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (over: Record<string, unknown> = {}): AuthorizedActionRecoveryPayload => ({
  claimId: U(1), packageId: U(2), packageVersion: 1, digest: `sha256:${'a'.repeat(64)}`,
  scope: { tenantId: U(3), workspaceId: U(4), businessId: U(5) }, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  claimedAt: '2026-10-12T10:00:00.000Z', dueAt: '2026-10-12T10:01:00.000Z', ...over,
}) as AuthorizedActionRecoveryPayload;
const built = (p = payload()) => buildAuthorizedActionRecoveryEvent({ payload: p, correlationId: U(9) });

describe('operations.authorized_action.recovery_due@1', () => {
  it('names the canonical type, owner domain, single consumer and alias', () => {
    expect(AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE).toBe('operations.authorized_action.recovery_due');
    expect(AUTHORIZED_ACTION_RECOVERY_ALIAS).toBe('AUTHORIZED_ACTION_RECOVERY_DUE');
    expect(AUTHORIZED_ACTION_RECOVERY_CONTRACT).toMatchObject({ eventVersion: '1', ownerDomain: 'operations', producer: 'bo.authorized-action-recovery', supportedConsumers: ['bo.authorized_action_recovery'] });
  });

  it('accepts the exact reference-only payload', () => {
    expect(isAuthorizedActionRecoveryPayload(payload())).toBe(true);
  });

  it('is closed: a package body, parameters, authority or status cannot ride along', () => {
    for (const extra of ['package', 'document', 'parameters', 'authority', 'status', 'owner', 'receiptId', 'executionId']) {
      expect(isAuthorizedActionRecoveryPayload({ ...payload(), [extra]: { x: 1 } }), extra).toBe(false);
    }
    expect(isAuthorizedActionRecoveryPayload({ ...payload(), scope: { ...payload().scope, extra: 1 } })).toBe(false);
  });

  it('refuses every missing or malformed field and a due time before the claim', () => {
    const bad: Record<string, unknown>[] = [
      { claimId: 'x' }, { packageId: null }, { packageVersion: 0 }, { packageVersion: 1.5 }, { digest: 'sha256:short' },
      { scope: { tenantId: U(3), workspaceId: U(4) } }, { actionType: { code: '', schemaVersion: '1' } },
      { claimedAt: '2026-10-12T10:00:00Z' }, { dueAt: 'soon' }, { dueAt: '2026-10-12T09:59:59.999Z' },
    ];
    for (const over of bad) expect(isAuthorizedActionRecoveryPayload(payload(over)), JSON.stringify(over)).toBe(false);
    for (const key of Object.keys(payload())) {
      const { [key]: _omitted, ...rest } = payload() as unknown as Record<string, unknown>;
      expect(isAuthorizedActionRecoveryPayload(rest), `missing ${key}`).toBe(false);
    }
    expect(isAuthorizedActionRecoveryPayload(null)).toBe(false);
    expect(isAuthorizedActionRecoveryPayload([])).toBe(false);
  });

  it('derives one deterministic id and idempotency key per claim', () => {
    expect(authorizedActionRecoveryIdempotencyKey(U(1))).toBe(`aap-recovery:${U(1)}`);
    expect(authorizedActionRecoveryEventId(U(1))).toBe(authorizedActionRecoveryEventId(U(1)));
    expect(authorizedActionRecoveryEventId(U(1))).not.toBe(authorizedActionRecoveryEventId(U(2)));
    expect(authorizedActionRecoveryEventId(U(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('builds a valid envelope that the registry accepts, and refuses a malformed payload', () => {
    const event = built();
    expect(validateBusinessEventEnvelope(event).valid).toBe(true);
    const registry = new BusinessEventContractRegistry();
    registerAuthorizedActionRecoveryContract(registry);
    expect(registry.validate(event)).toMatchObject({ valid: true });
    expect(event).toMatchObject({ eventId: authorizedActionRecoveryEventId(U(1)), aggregateId: U(1), causationId: U(1), sourceDomain: 'operations', idempotencyKey: `aap-recovery:${U(1)}` });
    expect(() => buildAuthorizedActionRecoveryEvent({ payload: { ...payload(), extra: 1 } as never, correlationId: U(9) })).toThrow('authorized_action_recovery_payload_invalid');
    expect(registry.validate({ ...event, payload: { ...payload(), extra: 1 } }).valid).toBe(false);
  });

  it('is one of exactly three execution-pipeline subscriptions, with the ruled retry policy', () => {
    const specs = executionPipelineSubscriptions(U(4));
    expect(specs.map((s) => s.destinationReference)).toEqual(['bo.authorized_action_intake', 'om.execution_verification', 'bo.authorized_action_recovery']);
    const recovery = specs[2];
    expect(recovery).toMatchObject({ subscriberName: `bo.authorized_action_recovery@${U(4)}`, eventPattern: AUTHORIZED_ACTION_RECOVERY_EVENT_TYPE, supportedVersions: ['1'], retryPolicy: { maxAttempts: 3, backoffSeconds: [1, 5, 15] } });
    expect(new Set(specs.map((s) => s.subscriberName)).size).toBe(3);
  });
});
